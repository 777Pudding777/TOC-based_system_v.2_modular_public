// src/modules/complianceRunner.ts
// Orchestrates "one rule per project": reset state, (optional) deterministic start,
// capture snapshot(s), call VLM checker, store decisions, and optionally do follow-ups.

import type { WebEvidenceRecord } from "../types/trace.types";
import type { CameraPose, StartPosePreset } from "../viewer/api";
import type { SnapshotArtifact } from "./snapshotCollector";
import type { VlmDecision, VlmFollowUp } from "./vlmChecker";

type NavMetrics = {
  projectedAreaRatio?: number;
  occlusionRatio?: number;
  convergenceScore?: number;
};

type EvidenceItem = {
  artifact: SnapshotArtifact;
  nav?: NavMetrics;
  context?: any;
};


type EvidenceContext = {
  step: number;
  phase: "context" | "refined" | "final";
  viewPreset?: "iso" | "top";            // or StartPosePreset
  cameraPose: CameraPose;               // already accessible
  scope?: { storeyId?: string; spaceId?: string };
  isolatedCategories?: string[];
  hiddenIds?: string[];
  highlightedIds?: string[];
  selectedId?: string | null;
  lastActionReason?: string | null;
  availableStoreys?: string[];
  availableSpaces?: string[];
  planCut?: { enabled: boolean; planes?: number };
};

type ToastFn = (msg: string, ms?: number) => void;

export type DeterministicStart =
  | { enabled: false }
  | { enabled: true; mode: "iso" | "top" }
  | { enabled: true; mode: "custom"; pose: CameraPose };

export type ComplianceStartParams = {
  prompt: string;
  deterministic: DeterministicStart;
  maxSteps?: number;          // safeguard
  minConfidence?: number;     // stop condition
  evidenceWindow?: number;    // multi-view aggregation (forward-compatible)
  onStep?: (step: number, decision: VlmDecision) => void;  // live progress callback
};

export function createComplianceRunner(params: {
  viewerApi: {
    hasModelLoaded: () => boolean;
    resetVisibility: () => Promise<void>;
    setPresetView: (preset: StartPosePreset, smooth?: boolean) => Promise<void>;
    setCameraPose: (pose: CameraPose, smooth?: boolean) => Promise<void>;
    getCameraPose: () => Promise<CameraPose>;
    isolateCategory?: (category: string) => Promise<any>; // ideally OBC.ModelIdMap | null

    stabilizeForSnapshot?: () => Promise<void>;

    isolateStorey?: (storeyId: string) => Promise<any>;
    isolateSpace?: (spaceId: string) => Promise<any>;

    hideIds?: (ids: string[]) => Promise<void>;
    showIds?: (ids: string[]) => Promise<void>;
    getHiddenIds?: () => Promise<string[]>;

    hideCategory?: (category: string) => Promise<boolean>;
    showCategory?: (category: string) => Promise<boolean>;
    getRendererDomElement?: () => HTMLCanvasElement;

    highlightIds?: (ids: string[], style?: "primary" | "warn") => Promise<void>;
    pickObjectAt?: (x: number, y: number) => Promise<string | null>;
    getProperties?: (objectId: string) => Promise<Record<string, unknown> | null>;
    hideSelected?: () => Promise<void>;

    getActiveScope?: () => Promise<{ storeyId?: string; spaceId?: string }>;
    getIsolatedCategories?: () => Promise<string[]>;

    setPlanCut?: (p: { height: number; thickness?: number; mode?: "WORLD_UP" | "CAMERA" }) => Promise<void>;
    clearPlanCut?: () => Promise<void>;
    setStoreyPlanCut?: (p: { storeyId: string; offsetFromFloor?: number; mode?: "WORLD_UP" | "CAMERA" }) => Promise<void>;

   listStoreys?: () => Promise<string[]>;
   listSpaces?: () => Promise<string[]>;

  };

  // inside createComplianceRunner(...)


  snapshotCollector: {
    reset: () => Promise<void>;
    capture: (note?: string, mode?: any) => Promise<SnapshotArtifact>;
    getRun: () => any;
  };

  vlmChecker: {
    adapterName: string;
    check: (input: {
      prompt: string;
      artifacts: SnapshotArtifact[];
evidenceViews: {
  snapshotId: string;
  mode: SnapshotArtifact["mode"];
  note?: string;
  nav?: NavMetrics;
  context?: any;
}[];

    }) => Promise<VlmDecision>;
  };


  complianceDb: {
    saveDecision: (runId: string, decision: VlmDecision) => Promise<void>;
    clearAll?: () => Promise<void>;
  };

  // optional navigation agent for follow-ups
  navigationAgent?: {
    navigateToSelection?: (map: any, opts?: any) => Promise<{
      targetAreaRatio: number;
      occlusionRatio: number | null;
      steps: number;
      success: boolean;
      reason: string;
    }>;
    goToCurrentIsolateSelection?: (opts?: any) => Promise<any>;
  };

  toast?: ToastFn;
}) {
  const { viewerApi, snapshotCollector, vlmChecker, complianceDb, navigationAgent, toast } = params;

  // Runner-local evidence state (updated whenever we execute a follow-up)
  let lastScope: { storeyId?: string; spaceId?: string } = {};
  let lastIsolatedCategories: string[] = [];
  let lastHiddenIds: string[] = [];
  let lastHighlightedIds: string[] = [];
  let lastSelectedId: string | null = null;
  let lastViewPreset: StartPosePreset | null = null;

  // one-rule-per-project: single active run id
  let activeRunId: string | null = null;

  function makeRunId() {
    return crypto.randomUUID();
  }

  function parseCustomPose(text: string): CameraPose | null {
    try {
      const obj = JSON.parse(text);
      if (!obj?.eye || !obj?.target) return null;
      const e = obj.eye, t = obj.target;
      const ok =
        [e.x, e.y, e.z, t.x, t.y, t.z].every((n) => typeof n === "number" && isFinite(n));
      if (!ok) return null;
      return { eye: e, target: t };
    } catch {
      return null;
    }
  }

  async function applyDeterministicStart(d: DeterministicStart) {
    if (!d.enabled) return;

    if (d.mode === "iso" || d.mode === "top") {
      await viewerApi.setPresetView(d.mode, true);
      lastViewPreset = d.mode;
      return;
    }

    // custom pose
    await viewerApi.setCameraPose(d.pose, true);
  }

function enrichNote(base: string, d: DeterministicStart) {
  if (!d.enabled) return base + " | start=free";
  if (d.mode === "custom") return base + " | start=customPose";
  return base + ` | start=${d.mode}`;
}

function stableJson(x: any): string {
  if (x == null) return "";
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  if (typeof x === "object") {
    const keys = Object.keys(x).sort();
    return `{${keys.map(k => `${k}:${stableJson((x as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

function followUpKey(fu: VlmFollowUp | undefined): string | null {
  if (!fu) return null;
  return `${fu.request}|${stableJson((fu as any).params ?? null)}`;
}

function escalateFollowUp(fu: VlmFollowUp | undefined): VlmFollowUp | undefined {
  if (!fu) return fu;

  switch (fu.request) {
    case "ISOLATE_STOREY":
      return { request: "TOP_VIEW" };
    case "TOP_VIEW":
      return { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "WORLD_UP" } };
    case "SET_PLAN_CUT":
      return { request: "ISOLATE_CATEGORY", params: { category: "IfcDoor" } };
    //case "ISOLATE_CATEGORY":
    //  return { request: "PICK_CENTER", params: { reason: "Pick a representative door to inspect." } };
    default:
      return { request: "NEW_VIEW", params: { reason: "Repeated followUp; changing view to gather new evidence." } };
  }
}

  //------------------------------------------------//
  //----------------FOLLOW-UP EXECUTOR----------------//
  //------------------------------------------------//
  // Minimal follow-up executor (no nav yet unless you added goToCurrentIsolateSelection)
  async function executeFollowUp(f: VlmFollowUp | undefined) {
    if (!f) return { didSomething: false, reason: "no-followup" as const };

if (f.request === "ISO_VIEW") {
  await viewerApi.setPresetView("iso", true);
  lastViewPreset = "iso";
  return { didSomething: true, reason: "iso" as const };
}

if (f.request === "TOP_VIEW") {
  await viewerApi.setPresetView("top", true);
  lastViewPreset = "top";
  return { didSomething: true, reason: "top" as const };
}
// Set view preset follow-up
if (f.request === "SET_VIEW_PRESET") {
  const preset = f.params.preset;
  if (preset === "TOP") {
    await viewerApi.setPresetView("top", true);
    lastViewPreset = "top";
    return { didSomething: true, reason: "top" as const };
  }
  if (preset === "ISO") {
    await viewerApi.setPresetView("iso", true);
    lastViewPreset = "iso";
    return { didSomething: true, reason: "iso" as const };
  }
  // ORBIT preset: if you have a preset view for it, call it; otherwise treat as NEW_VIEW
  return { didSomething: false, reason: "set-view-preset-not-supported" as const };
}

// Hide category follow-up (e.g. slabs/ceilings)
if (f.request === "HIDE_CATEGORY") {
  if (!viewerApi.hideCategory) {
    console.warn("[FollowUp] hideCategory not wired");
    return { didSomething: false, reason: "hide-category-not-wired" as const };
  }
  const ok = await viewerApi.hideCategory(f.params.category);
  if (viewerApi.getHiddenIds) lastHiddenIds = await viewerApi.getHiddenIds();
  return { didSomething: ok, reason: ok ? "hide-category" as const : "hide-category-failed" as const };
}

if (f.request === "SHOW_CATEGORY") {
  if (!viewerApi.showCategory) {
    console.warn("[FollowUp] showCategory not wired");
    return { didSomething: false, reason: "show-category-not-wired" as const };
  }
  const ok = await viewerApi.showCategory(f.params.category);
  if (viewerApi.getHiddenIds) lastHiddenIds = await viewerApi.getHiddenIds();
  return { didSomething: ok, reason: ok ? "show-category" as const : "show-category-failed" as const };
}

// Pick center follow-up (deterministic, avoids pixel math in the VLM)
if (f.request === "PICK_CENTER") {
  if (!viewerApi.pickObjectAt) {
    console.warn("[FollowUp] pickObjectAt not wired");
    return { didSomething: false, reason: "pick-not-wired" as const };
  }
  const canvas = viewerApi.getRendererDomElement?.();
  if (!canvas) {
    console.warn("[FollowUp] getRendererDomElement not wired");
    return { didSomething: false, reason: "pick-center-no-canvas" as const };
  }
  const rect = canvas.getBoundingClientRect();
  const id = await viewerApi.pickObjectAt(rect.width / 2, rect.height / 2);
  lastSelectedId = id;

  if (id && viewerApi.highlightIds) {
    await viewerApi.highlightIds([id], "primary");
    lastHighlightedIds = [id];
  }

  return { didSomething: !!id, reason: id ? "picked-center" as const : "pick-center-empty" as const };
}

// Pick object follow-up
if (f.request === "PICK_OBJECT") {
  if (!viewerApi.pickObjectAt) {
    console.warn("[FollowUp] pickObjectAt not wired");
    return { didSomething: false, reason: "pick-not-wired" as const };
  }

  const id = await viewerApi.pickObjectAt(f.params.x, f.params.y);
  lastSelectedId = id;

  // Auto-highlight picked item if possible
  if (id && viewerApi.highlightIds) {
    await viewerApi.highlightIds([id], "primary");
    lastHighlightedIds = [id];
  }

  return { didSomething: !!id, reason: id ? "picked" as const : "pick-empty" as const };
}

// Set plan cut follow-up
if (f.request === "SET_PLAN_CUT") {
  if (!viewerApi.setPlanCut) {
    console.warn("[FollowUp] setPlanCut not wired");
    return { didSomething: false, reason: "plan-cut-not-wired" as const };
  }
  await viewerApi.setPlanCut(f.params);
  return { didSomething: true, reason: "plan-cut" as const };
}

// Storey-aware plan cut (CAD-style floor plan)
if (f.request === "SET_STOREY_PLAN_CUT") {
  if (!viewerApi.setStoreyPlanCut) {
    console.warn("[FollowUp] setStoreyPlanCut not wired");
    return { didSomething: false, reason: "storey-plan-cut-not-wired" as const };
  }
  await viewerApi.setStoreyPlanCut(f.params);
  return { didSomething: true, reason: "storey-plan-cut" as const };
}

if (f.request === "CLEAR_PLAN_CUT") {
  if (!viewerApi.clearPlanCut) {
    console.warn("[FollowUp] clearPlanCut not wired");
    return { didSomething: false, reason: "plan-cut-clear-not-wired" as const };
  }
  await viewerApi.clearPlanCut();
  return { didSomething: true, reason: "plan-cut-clear" as const };
}

// Highlight ids follow-up
if (f.request === "HIGHLIGHT_IDS") {
  if (!viewerApi.highlightIds) {
    console.warn("[FollowUp] highlightIds not wired");
    return { didSomething: false, reason: "highlight-not-wired" as const };
  }
  const ids = f.params.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return { didSomething: false, reason: "highlight-empty" as const };
  }
  await viewerApi.highlightIds(ids, f.params.style);
  lastHighlightedIds = ids;
  return { didSomething: true, reason: "highlight" as const };
}

// Get properties follow-up
if (f.request === "GET_PROPERTIES") {
  if (!viewerApi.getProperties) {
    console.warn("[FollowUp] getProperties not wired");
    return { didSomething: false, reason: "props-not-wired" as const };
  }
  const props = await viewerApi.getProperties(f.params.objectId);
  // Store something minimal in state for evidence metadata (optional)
  lastSelectedId = f.params.objectId;
  return { didSomething: !!props, reason: props ? "props" as const : "props-null" as const, props };
}

// Hide selected follow-up
if (f.request === "HIDE_SELECTED") {
  if (!viewerApi.hideSelected) {
    console.warn("[FollowUp] hideSelected not wired");
    return { didSomething: false, reason: "hide-selected-not-wired" as const };
  }
  await viewerApi.hideSelected();
  // Update hidden ids tracking if available
  if (viewerApi.getHiddenIds) lastHiddenIds = await viewerApi.getHiddenIds();
  return { didSomething: true, reason: "hide-selected" as const };
}


if (f.request === "NEW_VIEW") {
  const pose = await viewerApi.getCameraPose();

  const ex = pose.eye.x, ey = pose.eye.y, ez = pose.eye.z;
  const tx = pose.target.x, ty = pose.target.y, tz = pose.target.z;

  // Vector from target to eye
  const vx = ex - tx;
  const vy = ey - ty;
  const vz = ez - tz;

  // Orbit 20 degrees around world-up (Y). Deterministic and scale-invariant.
  const deg = 20;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const nx = vx * cos - vz * sin;
  const nz = vx * sin + vz * cos;

  await viewerApi.setCameraPose(
    {
      eye: { x: tx + nx, y: ty + vy, z: tz + nz },
      target: pose.target,
    },
    true
  );

  return { didSomething: true, reason: "orbit20deg" as const };
}

    
    if (f.request === "ZOOM_IN") {
  const factor = Math.max(0.1, Math.min(4, f.params?.factor ?? 1.5));
  const pose = await viewerApi.getCameraPose();
  // deterministic zoom towards target by scaling eye->target vector
  const vx = pose.eye.x - pose.target.x;
  const vy = pose.eye.y - pose.target.y;
  const vz = pose.eye.z - pose.target.z;
  await viewerApi.setCameraPose(
    {
      eye: {
        x: pose.target.x + vx / factor,
        y: pose.target.y + vy / factor,
        z: pose.target.z + vz / factor,
      },
      target: pose.target,
    },
    true
  );
  return { didSomething: true, reason: "zoom" as const };
}

// Isolate category follow-up
if (f.request === "ISOLATE_CATEGORY") {
  if (!viewerApi.isolateCategory) {
    console.warn("[FollowUp] isolateCategory not wired");
    return { didSomething: false, reason: "isolate-category-not-wired" as const };
  }

  const category = f.params.category;
  console.log("[FollowUp] ISOLATE_CATEGORY", { category });

  const map = await viewerApi.isolateCategory(category);

  const count =
    map && typeof map === "object"
      ? Object.values(map).reduce((acc: number, s: any) => acc + (s?.size ?? 0), 0)
      : 0;

  console.log("[FollowUp] isolateCategory result", { hasMap: !!map, count, map });

  if (!map || count === 0) {
    return { didSomething: false, reason: "isolate-category-empty" as const };
  }

  // Optional: navigation-derived metrics for next snapshot
  if (navigationAgent?.navigateToSelection) {
    const m = await navigationAgent.navigateToSelection(map, { maxSteps: 20 });
    const nav: NavMetrics = {
      projectedAreaRatio: m.targetAreaRatio,
      occlusionRatio: m.occlusionRatio ?? undefined,
      convergenceScore: m.success ? 1 : 0,
    };
    lastIsolatedCategories = [category];
    return { didSomething: true, reason: "isolate-category" as const, nav };
  }
  lastIsolatedCategories = [category];
  return { didSomething: true, reason: "isolate-category" as const };
}

// Isolate storey follow-up
if (f.request === "ISOLATE_STOREY") {
  if (!viewerApi.isolateStorey) {
    console.warn("[FollowUp] isolateStorey not wired");
    return { didSomething: false, reason: "isolate-storey-not-wired" as const };
  }

  const map = await viewerApi.isolateStorey(f.params.storeyId);

  // If isolate failed, report it as no-op so runner escalates
  if (!map) {
    return { didSomething: false, reason: "isolate-storey-empty" as const };
  }

  lastScope = { storeyId: f.params.storeyId };
  return { didSomething: true, reason: "isolate-storey" as const };
}

// Isolate space follow-up
if (f.request === "ISOLATE_SPACE") {
  if (!viewerApi.isolateSpace) {
    console.warn("[FollowUp] isolateSpace not wired");
    return { didSomething: false, reason: "isolate-space-not-wired" as const };
  }
  await viewerApi.isolateSpace(f.params.spaceId);
  lastScope = { spaceId: f.params.spaceId };
  return { didSomething: true, reason: "isolate-space" as const };
}

// Reset visibility follow-up
if (f.request === "RESET_VISIBILITY") {
  await viewerApi.resetVisibility();
  lastScope = {};
  lastIsolatedCategories = [];
  lastHiddenIds = [];
  lastHighlightedIds = [];
  lastSelectedId = null;
  return { didSomething: true, reason: "reset-visibility" as const };
}

// Hide IDs follow-up
if (f.request === "HIDE_IDS") {
  if (!viewerApi.hideIds) {
    console.warn("[FollowUp] hideIds not wired");
    return { didSomething: false, reason: "hide-ids-not-wired" as const };
  }
  const ids = f.params.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return { didSomething: false, reason: "hide-ids-empty" as const };
  }
  await viewerApi.hideIds(ids);

  // prefer authoritative getter if available
  if (viewerApi.getHiddenIds) lastHiddenIds = await viewerApi.getHiddenIds();
  else lastHiddenIds = Array.from(new Set([...lastHiddenIds, ...ids]));

  return { didSomething: true, reason: "hide-ids" as const };
}

// Show IDs follow-up
if (f.request === "SHOW_IDS") {
  if (!viewerApi.showIds) {
    console.warn("[FollowUp] showIds not wired");
    return { didSomething: false, reason: "show-ids-not-wired" as const };
  }
  const ids = f.params.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return { didSomething: false, reason: "show-ids-empty" as const };
  }
  await viewerApi.showIds(ids);

  if (viewerApi.getHiddenIds) lastHiddenIds = await viewerApi.getHiddenIds();
  else lastHiddenIds = lastHiddenIds.filter(x => !ids.includes(x));

  return { didSomething: true, reason: "show-ids" as const };
}

    // Optional: if nav exists and you want to support it
    if (f.request === "ORBIT" && navigationAgent?.goToCurrentIsolateSelection) {
      // you can map this later; for now ignore
      return { didSomething: false, reason: "orbit-not-wired" as const };
    }

    return { didSomething: false, reason: "unsupported-followup" as const };
  }

  async function start(params: ComplianceStartParams) {
    if (!viewerApi.hasModelLoaded()) {
      toast?.("Load a model first.");
      return { ok: false as const, reason: "no-model" as const };
    }

    const prompt = (params.prompt ?? "").trim();
    if (!prompt) {
      toast?.("Please enter a compliance rule / prompt first.");
      return { ok: false as const, reason: "empty-prompt" as const };
    }

    const maxSteps = Math.max(1, Math.min(20, params.maxSteps ?? 6));

    // One rule per project: reset everything relevant
    await viewerApi.resetVisibility();
    await snapshotCollector.reset();

    // Create a new compliance run id (DB is “decisions only” for now)
    activeRunId = makeRunId();

    // Apply deterministic start (optional)
    await applyDeterministicStart(params.deterministic);

    toast?.(`Compliance started (${vlmChecker.adapterName})`);

    const minConfidence = Math.max(0, Math.min(1, params.minConfidence ?? 0.75));
    const evidenceWindow = Math.max(1, Math.min(8, params.evidenceWindow ?? 3));

    // Accumulate ALL decisions across steps so the caller can build a trace
    const allDecisions: VlmDecision[] = [];

    // Per-run evidence buffer (deterministic, in-order)
    const evidence: EvidenceItem[] = [];

    function pushEvidence(item: EvidenceItem) {
      evidence.push(item);
    }

    function getEvidenceWindow() {
      const slice = evidence.slice(Math.max(0, evidence.length - evidenceWindow));
      return {
        artifacts: slice.map(s => s.artifact),
        evidenceViews: slice.map(s => ({
          snapshotId: s.artifact.id,
          mode: s.artifact.mode,
          note: s.artifact.meta.note,
          nav: s.nav,
          context: s.context,
        })),

      };
    }

let lastActionReason: string | null = null;
let pendingNav: NavMetrics | undefined = undefined;
let lastFollowUpKey: string | null = null;
let repeatedFollowUpCount = 0;

    // Step loop
    for (let step = 1; step <= maxSteps; step++) {
const note = enrichNote(`compliance_step_${step}_view`, params.deterministic) +
  (lastActionReason ? ` | prevAction=${lastActionReason}` : "");

      const artifact = await snapshotCollector.capture(note, "RENDER_PLUS_JSON_METADATA");

      const b64 = artifact.images?.[0]?.imageBase64Png ?? "";
const isProbablyBlank = b64.length > 0 && b64.length < 25000; // tune later if needed

if (isProbablyBlank) {
  console.warn("[Compliance] snapshot looks blank; recovering", {
    step,
    lastActionReason,
    len: b64.length,
  });

  // Undo the most common causes of blankness
  await viewerApi.clearPlanCut?.();
  await viewerApi.resetVisibility();
  await viewerApi.setPresetView("iso", true);
  lastViewPreset = "iso";

  lastScope = {};
  lastIsolatedCategories = [];
  lastHiddenIds = [];
  lastHighlightedIds = [];
  lastSelectedId = null;

  await (viewerApi as any).stabilizeForSnapshot?.();

  // Continue to next step (which will recapture clean evidence)
  continue;
}


      if (artifact.mode !== "RENDER_PLUS_JSON_METADATA") {
  console.warn("[Compliance] unexpected snapshot mode", artifact.mode);
}

const cameraPose = await viewerApi.getCameraPose();
const phase: EvidenceContext["phase"] =
  step === 1 ? "context" : step === maxSteps ? "final" : "refined";
const availableStoreys = viewerApi.listStoreys ? await viewerApi.listStoreys() : undefined;
const availableSpaces = viewerApi.listSpaces ? await viewerApi.listSpaces() : undefined;
const planCutState = (viewerApi as any).getPlanCutState ? await (viewerApi as any).getPlanCutState() : undefined;

// capture current evidence context
const context: EvidenceContext = {
  step,
  phase,
  viewPreset: lastViewPreset ?? undefined,
  cameraPose,
  scope: (lastScope.storeyId || lastScope.spaceId) ? lastScope : undefined,
  isolatedCategories: lastIsolatedCategories.length ? lastIsolatedCategories : undefined,
  hiddenIds: lastHiddenIds.length ? lastHiddenIds : undefined,
  highlightedIds: lastHighlightedIds.length ? lastHighlightedIds : undefined,
  selectedId: lastSelectedId ?? undefined,
  lastActionReason: lastActionReason ?? undefined,
  availableStoreys,
  availableSpaces,
  planCut: planCutState,
};

// then after you capture the next snapshot:
pushEvidence({ artifact, nav: pendingNav, context });
pendingNav = undefined;




      const windowed = getEvidenceWindow();
      const decision = await vlmChecker.check({
        prompt,
        artifacts: windowed.artifacts,
        evidenceViews: windowed.evidenceViews,
      });

      // activeRunId is set above; guard anyway for safety
      if (!activeRunId) {
        toast?.("Internal error: missing run id.");
        return { ok: false as const, reason: "no-runid" as const };
      }

      allDecisions.push(decision);
      await complianceDb.saveDecision(activeRunId, decision);
      console.log("[Compliance] decision:", decision);
      params.onStep?.(step, decision);

      const confident = decision.confidence >= minConfidence;

      if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && confident) {
        toast?.(
          `Compliance result: ${decision.verdict} (${(decision.confidence * 100).toFixed(0)}%)`
        );
        return {
          ok: true as const,
          runId: activeRunId,
          final: decision,
          decisions: allDecisions,
          snapshots: evidence.length,
        };
      }

      if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && !confident) {
const fuKey = followUpKey(decision.followUp);
if (fuKey && fuKey === lastFollowUpKey) repeatedFollowUpCount++;
else repeatedFollowUpCount = 0;
lastFollowUpKey = fuKey;

let followUpToRun = decision.followUp;

// If same followUp repeats, escalate instead of resetting
if (repeatedFollowUpCount >= 1) {
  console.warn("[Compliance] repeating same followUp, escalating", decision.followUp);
  followUpToRun = escalateFollowUp(decision.followUp);
  repeatedFollowUpCount = 0; // reset after escalation so we don't immediately loop
}

const acted = await executeFollowUp(followUpToRun);
lastActionReason = acted.reason;
pendingNav = (acted as any).nav ?? undefined;

if (acted.didSomething) {
  await (viewerApi as any).stabilizeForSnapshot?.();
  continue;
}

toast?.(`Low-confidence ${decision.verdict} with no actionable follow-up. Stopping.`);
        return {
          ok: true as const,
          runId: activeRunId,
          final: decision,
          decisions: allDecisions,
          snapshots: evidence.length,
        };
      }

      if (decision.verdict === "UNCERTAIN" && confident) {
        toast?.(
          `UNCERTAIN with high confidence (${(decision.confidence * 100).toFixed(0)}%). Stopping.`
        );
        return {
          ok: true as const,
          runId: activeRunId,
          final: decision,
          decisions: allDecisions,
          snapshots: evidence.length,
        };
      }

const fuKey = followUpKey(decision.followUp);
if (fuKey && fuKey === lastFollowUpKey) repeatedFollowUpCount++;
else repeatedFollowUpCount = 0;
lastFollowUpKey = fuKey;

let followUpToRun = decision.followUp;

// If same followUp repeats, escalate instead of resetting
if (repeatedFollowUpCount >= 1) {
  console.warn("[Compliance] repeating same followUp, escalating", decision.followUp);
  followUpToRun = escalateFollowUp(decision.followUp);
  repeatedFollowUpCount = 0; // reset after escalation so we don't immediately loop
}

const acted = await executeFollowUp(followUpToRun);
lastActionReason = acted.reason;
pendingNav = (acted as any).nav ?? undefined;

if (acted.didSomething) {
  await (viewerApi as any).stabilizeForSnapshot?.();
  continue;
}

toast?.("UNCERTAIN with no actionable follow-up. Stopping.");
      return {
        ok: true as const,
        runId: activeRunId,
        final: decision,
        decisions: allDecisions,
        snapshots: evidence.length,
      };
    }

    toast?.("Max steps reached without conclusive compliance result.");
    const lastDec = allDecisions.length > 0 ? allDecisions[allDecisions.length - 1] : undefined;
    return { ok: false as const, reason: "max-steps-reached" as const, final: lastDec, decisions: allDecisions, snapshots: evidence.length };
  }
return { start, getActiveRunId: () => activeRunId, parseCustomPose, }; }


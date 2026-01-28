// src/modules/complianceRunner.ts
// Orchestrates "one rule per project": reset state, (optional) deterministic start,
// capture snapshot(s), call VLM checker, store decisions, and optionally do follow-ups.

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
};

export function createComplianceRunner(params: {
  viewerApi: {
    hasModelLoaded: () => boolean;
    resetVisibility: () => Promise<void>;
    setPresetView: (preset: StartPosePreset, smooth?: boolean) => Promise<void>;
    setCameraPose: (pose: CameraPose, smooth?: boolean) => Promise<void>;
    getCameraPose: () => Promise<CameraPose>;
    isolateCategory?: (category: string) => Promise<any>; // ideally OBC.ModelIdMap | null
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


  // Minimal follow-up executor (no nav yet unless you added goToCurrentIsolateSelection)
  async function executeFollowUp(f: VlmFollowUp | undefined) {
    if (!f) return { didSomething: false, reason: "no-followup" as const };

    if (f.request === "ISO_VIEW") {
      await viewerApi.setPresetView("iso", true);
      return { didSomething: true, reason: "iso" as const };
    }

    if (f.request === "TOP_VIEW") {
      await viewerApi.setPresetView("top", true);
      return { didSomething: true, reason: "top" as const };
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
    return { didSomething: true, reason: "isolate-category" as const, nav };
  }

  return { didSomething: true, reason: "isolate-category" as const };
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
        })),
      };
    }

let lastActionReason: string | null = null;
let pendingNav: NavMetrics | undefined = undefined;


    // Step loop
    for (let step = 1; step <= maxSteps; step++) {
const note = enrichNote(`compliance_step_${step}_view`, params.deterministic) +
  (lastActionReason ? ` | prevAction=${lastActionReason}` : "");

      const artifact = await snapshotCollector.capture(note, "RENDER_PLUS_JSON_METADATA");
      if (artifact.mode !== "RENDER_PLUS_JSON_METADATA") {
  console.warn("[Compliance] unexpected snapshot mode", artifact.mode);
}

// then after you capture the next snapshot:
pushEvidence({ artifact, nav: pendingNav });
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

      await complianceDb.saveDecision(activeRunId, decision);
      console.log("[Compliance] decision:", decision);

      const confident = decision.confidence >= minConfidence;

      if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && confident) {
        toast?.(
          `Compliance result: ${decision.verdict} (${(decision.confidence * 100).toFixed(0)}%)`
        );
        return { ok: true as const, runId: activeRunId, final: decision };
      }

      if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && !confident) {
        const acted = await executeFollowUp(decision.followUp);
        lastActionReason = acted.reason;
        pendingNav = (acted as any).nav ?? undefined;


        if (!acted.didSomething) {
          toast?.(`Low-confidence ${decision.verdict} with no actionable follow-up. Stopping.`);
          return { ok: true as const, runId: activeRunId, final: decision };
        }
        continue;
      }

      if (decision.verdict === "UNCERTAIN" && confident) {
        toast?.(
          `UNCERTAIN with high confidence (${(decision.confidence * 100).toFixed(0)}%). Stopping.`
        );
        return { ok: true as const, runId: activeRunId, final: decision };
      }

      const acted = await executeFollowUp(decision.followUp);
      lastActionReason = acted.reason;
      pendingNav = (acted as any).nav ?? undefined;


      if (!acted.didSomething) {
        toast?.("UNCERTAIN with no actionable follow-up. Stopping.");
        return { ok: true as const, runId: activeRunId, final: decision };
      }
    }

    toast?.("Max steps reached without conclusive compliance result.");
    return { ok: false as const, reason: "max-steps-reached" as const };
  }
return { start, getActiveRunId: () => activeRunId, parseCustomPose, }; }


// src/modules/complianceRunner.ts
// Orchestrates "one rule per project": reset state, (optional) deterministic start,
// capture snapshot(s), call VLM checker, store decisions, and optionally do follow-ups.

import type { WebEvidenceRecord } from "../types/trace.types";
import {
  DEFAULT_MAX_COMPLIANCE_STEPS,
  ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS,
  ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE,
  ENTITY_UNCERTAIN_TERMINATION_STEPS,
  HIGHLIGHT_NAVIGATION_DEFAULTS,
  HIGHLIGHT_TARGET_AREA_RATIO,
  RAMP_NAVIGATION_DEFAULTS,
  REPEATED_FOLLOW_UPS_BEFORE_ESCALATION,
  ZOOM_IN_EXHAUSTION_AREA_FACTOR,
} from "../config/prototypeSettings";
import type { CameraPose, StartPosePreset, ViewerGridReference } from "../viewer/api";
import type { SnapshotArtifact } from "./snapshotCollector";
import type { VlmDecision, VlmFollowUp } from "./vlmChecker";
import {
  buildTaskGraphPromptSection,
  type CompactTaskGraphState,
  createTaskGraph,
  enrichTaskGraphFromText,
  getTaskGraphFocus,
  markActiveEntityInconclusive,
  summarizeTaskGraph,
  syncTaskGraphEntities,
  updateTaskGraphFromDecision,
  updateTaskGraphFromFollowUpResult,
} from "./taskGraph";

type NavMetrics = {
  projectedAreaRatio?: number;
  occlusionRatio?: number;
  convergenceScore?: number;
  targetAreaGoal?: number;
  success?: boolean;
  reason?: string;
  zoomPotentialExhausted?: boolean;
};

type EntityEvidenceStat = {
  steps: number;
  uncertainSteps: number;
  repeatedWorkflowStreak: number;
  lastWorkflowSignature?: string;
  topMeasurementReady?: boolean;
  contextConfirmReady?: boolean;
};

type EvidenceItem = {
  artifact: SnapshotArtifact;
  nav?: NavMetrics;
  context?: any;
};

type NavigationBookmark = {
  id: string;
  step: number;
  snapshotId?: string;
  label: string;
  action: string;
  viewPreset?: "iso" | "top";
  cameraPose: CameraPose;
  scope?: { storeyId?: string; spaceId?: string };
  isolatedCategories: string[];
  hiddenIds: string[];
  highlightedIds: string[];
  selectedId?: string | null;
  planCut?: {
    enabled: boolean;
    planes?: number;
    absoluteHeight?: number;
    mode?: "WORLD_UP" | "CAMERA";
    source?: string;
    storeyId?: string;
  };
};


type EvidenceContext = {
  step: number;
  phase: "context" | "refined" | "final";
  viewPreset?: "iso" | "top";            // or StartPosePreset
  cameraPose: CameraPose;               // already accessible
  scope?: { storeyId?: string; spaceId?: string };
  isolatedCategories?: string[];
  isolatedIds?: string[];
  hiddenIds?: string[];
  highlightedIds?: string[];
  selectedId?: string | null;
  lastActionReason?: string | null;
  availableStoreys?: string[];
  availableSpaces?: string[];
  planCut?: { enabled: boolean; planes?: number };
  viewerGrid?: ViewerGridReference;
  highlightAnnotations?: Record<string, unknown>;
  floorContext?: {
    missingLikely: boolean;
    visibleFloorCategories: string[];
    recommendedAction?: "SET_STOREY_PLAN_CUT";
    reason?: string;
  };
  taskGraph?: {
    profile: CompactTaskGraphState["profile"];
    source: CompactTaskGraphState["source"];
    primaryClass?: CompactTaskGraphState["primaryClass"];
    concerns: CompactTaskGraphState["concerns"];
    progress: CompactTaskGraphState["progress"];
    activeTask?: CompactTaskGraphState["activeTask"];
    activeEntity?: CompactTaskGraphState["activeEntity"];
    activeStoreyId?: string;
    clusterProgress?: CompactTaskGraphState["clusterProgress"];
    nextEntityIds: string[];
  };
  navigationHistory?: {
    recent: Array<{
      bookmarkId: string;
      step: number;
      snapshotId?: string;
      action: string;
      label: string;
      viewPreset?: "iso" | "top";
      storeyId?: string;
      highlightedCount: number;
      hasPlanCut: boolean;
    }>;
    storeyBookmarks: Array<{
      bookmarkId: string;
      step: number;
      storeyId: string;
      label: string;
      hasPlanCut: boolean;
    }>;
  };
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
  onProgress?: (update: {
    stage: "starting" | "seeded" | "captured" | "decision" | "followup" | "finished";
    step: number;
    summary: string;
    taskGraph?: CompactTaskGraphState;
    lastActionReason?: string | null;
    verdict?: VlmDecision["verdict"];
    confidence?: number;
  }) => void;
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
    getCurrentIsolateSelection?: () => Record<string, Set<number>> | null;
    getDoorClearanceFocusBox?: (ids?: string[]) => Promise<any>;
    listCategoryObjectIds?: (category: string, limit?: number) => Promise<string[]>;
    hideSelected?: () => Promise<void>;

    getActiveScope?: () => Promise<{ storeyId?: string; spaceId?: string }>;
    getIsolatedCategories?: () => Promise<string[]>;

    setPlanCut?: (p: { height?: number; absoluteHeight?: number; thickness?: number; mode?: "WORLD_UP" | "CAMERA" }) => Promise<void>;
    clearPlanCut?: () => Promise<void>;
    setStoreyPlanCut?: (p: { storeyId: string; offsetFromFloor?: number; mode?: "WORLD_UP" | "CAMERA" }) => Promise<void>;

   listStoreys?: () => Promise<string[]>;
   listSpaces?: () => Promise<string[]>;
   getGridReference?: () => ViewerGridReference;

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
  let currentTaskGraph: ReturnType<typeof createTaskGraph> | null = null;
  let navigationBookmarks: NavigationBookmark[] = [];

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

    if (d.mode === "custom") {
      await viewerApi.setCameraPose(d.pose, true);
    }
  }

  async function seedTaskGraphFromMetadata(
    taskGraph: ReturnType<typeof createTaskGraph>,
    deterministic: DeterministicStart
  ): Promise<boolean> {
    const entityClass = taskGraph.intent.repeatedEntityClass;
    if (!entityClass || !viewerApi.listCategoryObjectIds) return false;

    const storeys = viewerApi.listStoreys ? await viewerApi.listStoreys() : [];
    const seededStoreys = new Set<string>();

    if (storeys.length && viewerApi.isolateStorey) {
      for (const storeyId of storeys) {
        try {
          const isolated = await viewerApi.isolateStorey(storeyId);
          const categoryIds = await viewerApi.listCategoryObjectIds(entityClass, 300);
          const isolatedIds = new Set(
            flattenModelIdMap(isolated ?? viewerApi.getCurrentIsolateSelection?.() ?? null)
          );
          const ids = isolatedIds.size
            ? categoryIds.filter((id) => isolatedIds.has(id))
            : categoryIds;
          if (!ids.length) continue;
          syncTaskGraphEntities(taskGraph, ids, { storeyId, entityClass });
          seededStoreys.add(storeyId);
        } catch (error) {
          console.warn("[Compliance] storey task-graph seed failed", { storeyId, error });
        }
      }
    }

    if (!taskGraph.entities.trackedIds.length) {
      const ids = await viewerApi.listCategoryObjectIds(entityClass, 300);
      if (ids.length) {
        syncTaskGraphEntities(taskGraph, ids, { entityClass });
      }
    }

    const seeded = seededStoreys.size > 0 || taskGraph.entities.trackedIds.length > 0;
    if (seeded) {
      taskGraph.history.push(
        `Metadata seed: ${taskGraph.entities.trackedIds.length} entity candidate(s) across ${Math.max(
          seededStoreys.size,
          taskGraph.entities.clusters.length
        )} cluster(s).`
      );
    }

    await viewerApi.resetVisibility();
    await applyDeterministicStart(deterministic);
    return seeded;
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

function buildWorkflowSignature(args: {
  entityId?: string;
  decision: VlmDecision;
  viewPreset: StartPosePreset | null;
  planCutEnabled: boolean;
  isolatedCategories: string[];
  highlightedIds: string[];
  lastActionReason: string | null;
}) {
  const {
    entityId,
    decision,
    viewPreset,
    planCutEnabled,
    isolatedCategories,
    highlightedIds,
    lastActionReason,
  } = args;
  return stableJson({
    entityId: entityId ?? null,
    verdict: decision.verdict,
    confidenceBucket: Math.round((decision.confidence ?? 0) * 10) / 10,
    followUp: decision.followUp?.request ?? null,
    occlusion: decision.visibility?.occlusionAssessment ?? null,
    viewPreset: viewPreset ?? null,
    planCutEnabled,
    isolatedCategories: [...isolatedCategories].sort(),
    highlightedCount: highlightedIds.length,
    lastActionReason: lastActionReason ?? null,
  });
}

async function createNavigationBookmark(step: number, label: string, action: string): Promise<NavigationBookmark> {
  const pose = await viewerApi.getCameraPose();
  const planCut = (viewerApi as any).getPlanCutState ? await (viewerApi as any).getPlanCutState() : undefined;
  return {
    id: crypto.randomUUID(),
    step,
    label,
    action,
    viewPreset: lastViewPreset ?? undefined,
    cameraPose: pose,
    scope: lastScope.storeyId || lastScope.spaceId ? { ...lastScope } : undefined,
    isolatedCategories: [...lastIsolatedCategories],
    hiddenIds: [...lastHiddenIds],
    highlightedIds: [...lastHighlightedIds],
    selectedId: lastSelectedId,
    planCut: planCut
      ? {
          enabled: Boolean(planCut.enabled),
          planes: typeof planCut.planes === "number" ? planCut.planes : undefined,
          absoluteHeight: typeof planCut.absoluteHeight === "number" ? planCut.absoluteHeight : undefined,
          mode: planCut.mode,
          source: planCut.source,
          storeyId: planCut.storeyId,
        }
      : { enabled: false },
  };
}

function rememberNavigationBookmark(bookmark: NavigationBookmark) {
  navigationBookmarks.push(bookmark);
  if (navigationBookmarks.length > 40) {
    navigationBookmarks = navigationBookmarks.slice(-40);
  }
}

function summarizeNavigationHistory() {
  const recent = navigationBookmarks.slice(-6).reverse().map((bookmark) => ({
    bookmarkId: bookmark.id,
    step: bookmark.step,
    snapshotId: bookmark.snapshotId,
    action: bookmark.action,
    label: bookmark.label,
    viewPreset: bookmark.viewPreset,
    storeyId: bookmark.scope?.storeyId,
    highlightedCount: bookmark.highlightedIds.length,
    hasPlanCut: Boolean(bookmark.planCut?.enabled),
  }));

  const latestStoreyById = new Map<string, NavigationBookmark>();
  for (const bookmark of navigationBookmarks) {
    const storeyId = bookmark.scope?.storeyId;
    if (!storeyId) continue;
    const current = latestStoreyById.get(storeyId);
    if (!current || current.step <= bookmark.step) {
      latestStoreyById.set(storeyId, bookmark);
    }
  }

  const storeyBookmarks = Array.from(latestStoreyById.values())
    .sort((a, b) => b.step - a.step)
    .slice(0, 6)
    .map((bookmark) => ({
      bookmarkId: bookmark.id,
      step: bookmark.step,
      storeyId: bookmark.scope?.storeyId ?? "unknown",
      label: bookmark.label,
      hasPlanCut: Boolean(bookmark.planCut?.enabled),
    }));

  return { recent, storeyBookmarks };
}

function findReusableStoreyBookmark(storeyId?: string) {
  if (!storeyId) return undefined;
  return [...navigationBookmarks]
    .reverse()
    .find(
      (bookmark) =>
        bookmark.scope?.storeyId === storeyId &&
        bookmark.viewPreset === "top" &&
        Boolean(bookmark.planCut?.enabled)
    );
}

async function restoreNavigationBookmark(params?: { step?: number; snapshotId?: string; bookmarkId?: string }) {
  const target =
    (params?.bookmarkId
      ? navigationBookmarks.find((bookmark) => bookmark.id === params.bookmarkId)
      : undefined) ??
    (params?.snapshotId
      ? [...navigationBookmarks].reverse().find((bookmark) => bookmark.snapshotId === params.snapshotId)
      : undefined) ??
    (typeof params?.step === "number"
      ? [...navigationBookmarks].reverse().find((bookmark) => bookmark.step === params.step)
      : undefined);

  if (!target) {
    return { ok: false, reason: "navigation-bookmark-not-found" as const };
  }

  if (target.planCut?.enabled && target.scope?.storeyId) {
    await viewerApi.resetVisibility();
    lastScope = { storeyId: target.scope.storeyId };
  } else if (target.scope?.storeyId && viewerApi.isolateStorey) {
    await viewerApi.isolateStorey(target.scope.storeyId);
    lastScope = { storeyId: target.scope.storeyId };
  } else if (target.scope?.spaceId && viewerApi.isolateSpace) {
    await viewerApi.isolateSpace(target.scope.spaceId);
    lastScope = { spaceId: target.scope.spaceId };
  } else {
    await viewerApi.resetVisibility();
    lastScope = {};
  }

  await viewerApi.setCameraPose(target.cameraPose, true);
  lastViewPreset = target.viewPreset ?? null;

  if (target.planCut?.enabled && viewerApi.setPlanCut && Number.isFinite(target.planCut.absoluteHeight)) {
    await viewerApi.setPlanCut({
      absoluteHeight: target.planCut.absoluteHeight,
      mode: target.planCut.mode,
    });
  } else if (!target.planCut?.enabled && viewerApi.clearPlanCut) {
    await viewerApi.clearPlanCut();
  }

  if (target.highlightedIds.length && viewerApi.highlightIds) {
    await viewerApi.highlightIds(target.highlightedIds, "primary");
    lastHighlightedIds = [...target.highlightedIds];
    lastSelectedId = target.selectedId ?? target.highlightedIds[0] ?? null;
  } else {
    lastHighlightedIds = [];
    lastSelectedId = null;
  }

  lastHiddenIds = [...target.hiddenIds];
  lastIsolatedCategories = [...target.isolatedCategories];
  return { ok: true, reason: "navigation-bookmark-restored" as const, bookmark: target };
}

async function advanceToNextEntity(taskGraph: ReturnType<typeof createTaskGraph>, fromEntityId?: string) {
  const nextFocus = getTaskGraphFocus(taskGraph);
  if (!nextFocus.activeEntityId || nextFocus.activeEntityId === fromEntityId) {
    return { advanced: false as const, nextFocus, restoredPreparedView: false };
  }

  const nextEntity = taskGraph.entities.byId[nextFocus.activeEntityId];
  const reusableBookmark = findReusableStoreyBookmark(nextEntity?.storeyId);
  if (reusableBookmark) {
    await restoreNavigationBookmark({ bookmarkId: reusableBookmark.id });
  }

  if (viewerApi.highlightIds) {
    await viewerApi.highlightIds([nextFocus.activeEntityId], "primary");
    lastHighlightedIds = [nextFocus.activeEntityId];
    lastSelectedId = nextFocus.activeEntityId;
  }

  if (nextEntity?.storeyId) {
    lastScope = { storeyId: nextEntity.storeyId };
  }

  return { advanced: true as const, nextFocus, restoredPreparedView: Boolean(reusableBookmark) };
}

function flattenModelIdMap(map: Record<string, Set<number>> | null | undefined): string[] {
  if (!map || typeof map !== "object") return [];
  const out: string[] = [];
  const modelIds = Object.keys(map).sort();
  for (const modelId of modelIds) {
    const ids = Array.from(map[modelId] ?? [])
      .filter((id) => typeof id === "number" && isFinite(id))
      .sort((a, b) => a - b);
    for (const localId of ids) out.push(`${modelId}:${localId}`);
  }
  return out;
}

function buildModelIdMapFromObjectIds(ids: string[]): Record<string, Set<number>> {
  const map: Record<string, Set<number>> = {};
  for (const raw of ids ?? []) {
    const parts = String(raw).split(":");
    if (parts.length < 2) continue;
    const modelId = parts[0];
    const localId = Number(parts[1]);
    if (!modelId || !Number.isFinite(localId)) continue;
    (map[modelId] ??= new Set<number>()).add(localId);
  }
  return map;
}

async function detectFloorContextSignal(params: {
  viewerApi: {
    getCurrentIsolateSelection?: () => Record<string, Set<number>> | null;
    listCategoryObjectIds?: (category: string, limit?: number) => Promise<string[]>;
  };
  lastScope: { storeyId?: string; spaceId?: string };
  lastViewPreset: StartPosePreset | null;
  lastHighlightedIds: string[];
  lastIsolatedCategories: string[];
  planCutState: { enabled?: boolean } | undefined;
}) {
  const { viewerApi, lastScope, lastViewPreset, lastHighlightedIds, lastIsolatedCategories, planCutState } = params;
  const isolated = viewerApi.getCurrentIsolateSelection?.();
  const isolatedIds = new Set(flattenModelIdMap(isolated));
  const visibleFloorCategories: string[] = [];

  if (
    !lastScope.storeyId ||
    lastViewPreset !== "top" ||
    planCutState?.enabled ||
    !lastHighlightedIds.length ||
    !lastIsolatedCategories.some((category) => category.toUpperCase().includes("IFCDOOR")) ||
    !isolatedIds.size ||
    !viewerApi.listCategoryObjectIds
  ) {
    return {
      missingLikely: false,
      visibleFloorCategories,
    };
  }

  const floorCategories = ["IfcSlab", "IfcCovering"];
  for (const category of floorCategories) {
    const ids = await viewerApi.listCategoryObjectIds(category, 1000);
    if (ids.some((id) => isolatedIds.has(id))) {
      visibleFloorCategories.push(category);
    }
  }

  const missingLikely = visibleFloorCategories.length === 0;
  return {
    missingLikely,
    visibleFloorCategories,
    recommendedAction: missingLikely ? ("SET_STOREY_PLAN_CUT" as const) : undefined,
    reason: missingLikely
      ? "Active storey view contains the highlighted door but no visible slab/covering selection, so local floor context is likely missing."
      : undefined,
  };
}

function followUpKey(fu: VlmFollowUp | undefined): string | null {
  if (!fu) return null;
  return `${fu.request}|${stableJson((fu as any).params ?? null)}`;
}

function escalateFollowUp(fu: VlmFollowUp | undefined): VlmFollowUp | undefined {
  if (!fu) return fu;

  switch (fu.request) {
    case "TOP_VIEW":
      return { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "WORLD_UP" } };
    case "ISOLATE_STOREY":
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
  async function executeFollowUp(
    f: VlmFollowUp | undefined,
    previousActionReason?: string | null,
    previousNav?: NavMetrics
  ) {
    if (!f) return { didSomething: false, reason: "no-followup" as const };

const pickHighlightCandidates = (limit = 3): string[] => {
  const focusIds = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph).suggestedHighlightIds.slice(0, limit) : [];
  if (focusIds.length) return focusIds;

  const map = viewerApi.getCurrentIsolateSelection?.();
  if (!map || typeof map !== "object") return [];

  const out: string[] = [];
  const modelIds = Object.keys(map).sort();
  for (const modelId of modelIds) {
    const set = map[modelId];
    if (!set) continue;
    const localIds = Array.from(set).filter((id) => typeof id === "number" && isFinite(id)).sort((a, b) => a - b);
    for (const localId of localIds) {
      out.push(`${modelId}:${localId}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
};

const focusHighlightedIds = async (
  ids: string[],
  minTargetAreaRatio = Math.max(HIGHLIGHT_TARGET_AREA_RATIO, HIGHLIGHT_NAVIGATION_DEFAULTS.targetAreaRatio)
) => {
  if (!ids.length || !navigationAgent?.navigateToSelection) return undefined;
  const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
  const activeClass =
    (focus?.activeEntityId ? currentTaskGraph?.entities.byId[focus.activeEntityId]?.entityClass : undefined) ??
    currentTaskGraph?.intent.primaryClass;
  const isRampTarget = typeof activeClass === "string" && activeClass.toUpperCase().includes("IFCRAMP");
  const isDoorTarget = typeof activeClass === "string" && activeClass.toUpperCase().includes("IFCDOOR");
  const navProfile = isRampTarget ? RAMP_NAVIGATION_DEFAULTS : HIGHLIGHT_NAVIGATION_DEFAULTS;
  const targetAreaGoal = isRampTarget
    ? navProfile.targetAreaRatio
    : isDoorTarget
      ? Math.max(minTargetAreaRatio, HIGHLIGHT_TARGET_AREA_RATIO)
      : minTargetAreaRatio;
  const map = buildModelIdMapFromObjectIds(ids);
  if (!Object.keys(map).length) return undefined;
  const focusBox =
    isDoorTarget && viewerApi.getDoorClearanceFocusBox
      ? await viewerApi.getDoorClearanceFocusBox(ids.slice(0, 1))
      : undefined;
  const m = await navigationAgent.navigateToSelection(map as any, {
    minTargetAreaRatio: targetAreaGoal,
    maxSteps: navProfile.maxSteps,
    zoomFactor: navProfile.zoomFactor,
    orbitDegrees: lastViewPreset === "top" ? 0 : navProfile.orbitDegrees,
    enableOcclusion: false,
    focusBox,
  });
  const zoomPotentialExhausted =
    m.success ||
    m.reason === "converged-no-solution" ||
    m.reason === "max-steps" ||
    m.targetAreaRatio >= targetAreaGoal * ZOOM_IN_EXHAUSTION_AREA_FACTOR;
  const nav: NavMetrics = {
    projectedAreaRatio: m.targetAreaRatio,
    occlusionRatio: m.occlusionRatio ?? undefined,
    convergenceScore: m.success ? 1 : 0,
    targetAreaGoal,
    success: m.success,
    reason: m.reason,
    zoomPotentialExhausted,
  };
  return nav;
};

const recenterOnActiveHighlight = async (
  minTargetAreaRatio = Math.max(HIGHLIGHT_TARGET_AREA_RATIO, HIGHLIGHT_NAVIGATION_DEFAULTS.targetAreaRatio)
) => {
  if (!lastHighlightedIds.length) return undefined;
  return focusHighlightedIds(lastHighlightedIds.slice(0, 1), minTargetAreaRatio);
};


if (f.request === "ISO_VIEW") {
  await viewerApi.setPresetView("iso", true);
  lastViewPreset = "iso";
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "iso" as const, nav };
}

if (f.request === "TOP_VIEW") {
  if (previousActionReason === "top") {
    return { didSomething: false, reason: "top-view-already-active" as const, nav: previousNav };
  }
  await viewerApi.setPresetView("top", true);
  lastViewPreset = "top";
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "top" as const, nav };
}
// Set view preset follow-up
if (f.request === "SET_VIEW_PRESET") {
  const preset = f.params.preset;
  if (preset === "TOP") {
    await viewerApi.setPresetView("top", true);
    lastViewPreset = "top";
    const nav = await recenterOnActiveHighlight();
    return { didSomething: true, reason: "top" as const, nav };
  }
  if (preset === "ISO") {
    await viewerApi.setPresetView("iso", true);
    lastViewPreset = "iso";
    const nav = await recenterOnActiveHighlight();
    return { didSomething: true, reason: "iso" as const, nav };
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
  if (!viewerApi.highlightIds) {
    console.warn("[FollowUp] highlightIds not wired");
    return { didSomething: false, reason: "highlight-not-wired" as const };
  }
  const ids = pickHighlightCandidates(1);
  if (!ids.length) {
    return { didSomething: false, reason: "highlight-candidates-empty" as const };
  }

  await viewerApi.highlightIds(ids, "primary");
  lastHighlightedIds = ids;
  lastSelectedId = ids[0] ?? null;
  const nav = await focusHighlightedIds(ids);
  return { didSomething: true, reason: "highlight-center-candidate" as const, nav };
}

// Pick object follow-up
if (f.request === "PICK_OBJECT") {
  if (!viewerApi.highlightIds) {
    console.warn("[FollowUp] highlightIds not wired");
    return { didSomething: false, reason: "highlight-not-wired" as const };
  }

  const ids = pickHighlightCandidates(3);
  if (!ids.length) {
    return { didSomething: false, reason: "highlight-candidates-empty" as const };
  }

  await viewerApi.highlightIds(ids, "primary");
  lastHighlightedIds = ids;
  lastSelectedId = ids[0] ?? null;
  const nav = await focusHighlightedIds(ids.slice(0, 1));
  return { didSomething: true, reason: "highlight-picked-candidates" as const, nav };
}

// Set plan cut follow-up
if (f.request === "SET_PLAN_CUT") {
  if (!viewerApi.setPlanCut) {
    console.warn("[FollowUp] setPlanCut not wired");
    return { didSomething: false, reason: "plan-cut-not-wired" as const };
  }
  await viewerApi.setPlanCut(f.params);
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "plan-cut" as const, nav };
}

// Storey-aware plan cut (CAD-style floor plan)
if (f.request === "SET_STOREY_PLAN_CUT") {
  if (!viewerApi.setStoreyPlanCut) {
    console.warn("[FollowUp] setStoreyPlanCut not wired");
    return { didSomething: false, reason: "storey-plan-cut-not-wired" as const };
  }
  await viewerApi.setStoreyPlanCut(f.params);
  lastScope = { storeyId: f.params.storeyId };
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "storey-plan-cut" as const, nav };
}

if (f.request === "CLEAR_PLAN_CUT") {
  if (!viewerApi.clearPlanCut) {
    console.warn("[FollowUp] clearPlanCut not wired");
    return { didSomething: false, reason: "plan-cut-clear-not-wired" as const };
  }
  await viewerApi.clearPlanCut();
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "plan-cut-clear" as const, nav };
}

if (f.request === "RESTORE_VIEW") {
  const restored = await restoreNavigationBookmark(f.params);
  return { didSomething: restored.ok, reason: restored.reason };
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
  const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
  const targetIds =
    focus?.activeEntityId && ids.includes(focus.activeEntityId)
      ? [focus.activeEntityId]
      : ids.slice(0, focus?.activeEntityId ? 1 : 6);
  await viewerApi.highlightIds(targetIds, f.params.style);
  lastHighlightedIds = targetIds;
  lastSelectedId = targetIds[0] ?? null;
  const nav = await focusHighlightedIds(targetIds);
  return { didSomething: true, reason: "highlight" as const, nav };
}

// Get properties follow-up
if (f.request === "GET_PROPERTIES") {
  const ids = lastHighlightedIds.length ? lastHighlightedIds : pickHighlightCandidates(1);
  if (!ids.length || !viewerApi.highlightIds) {
    return { didSomething: false, reason: "highlight-candidates-empty" as const };
  }
  await viewerApi.highlightIds(ids.slice(0, 1), "primary");
  lastHighlightedIds = ids.slice(0, 1);
  lastSelectedId = ids[0] ?? null;
  const nav = await focusHighlightedIds(ids.slice(0, 1));
  return {
    didSomething: true,
    reason: "properties-deprecated-highlighted-candidate" as const,
    nav,
    props: { objectId: ids[0], source: "highlighting-fallback" },
  };
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
  if (lastHighlightedIds.length) {
    const nav = await recenterOnActiveHighlight();
    return { didSomething: true, reason: "orbit20deg" as const, nav };
  }

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
  if (previousNav?.zoomPotentialExhausted) {
    return { didSomething: false, reason: "zoom-potential-exhausted" as const, nav: previousNav };
  }
  if (lastHighlightedIds.length) {
    const nav = await focusHighlightedIds(lastHighlightedIds.slice(0, 1));
    if (nav) {
      return { didSomething: true, reason: "zoom-to-highlighted-entity" as const, nav };
    }
  }
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
  const nav = await focusHighlightedIds(lastHighlightedIds.slice(0, 1));
  return { didSomething: true, reason: "zoom" as const, nav };
}

// Isolate category follow-up
if (f.request === "ISOLATE_CATEGORY") {
  const category = f.params.category;
  console.log("[FollowUp] ISOLATE_CATEGORY", { category });

  if (viewerApi.listCategoryObjectIds && viewerApi.highlightIds) {
    const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
    const limit = focus?.activeEntityId ? 1 : 6;
    const ids = await viewerApi.listCategoryObjectIds(category, 24);
    if (ids.length) {
      const targetIds =
        focus?.activeEntityId && ids.includes(focus.activeEntityId)
          ? [focus.activeEntityId]
          : focus?.suggestedHighlightIds?.filter((id) => ids.includes(id)).slice(0, limit) ?? ids.slice(0, limit);
      await viewerApi.highlightIds(targetIds, "primary");
      lastHighlightedIds = targetIds;
      lastSelectedId = targetIds[0] ?? null;
      lastIsolatedCategories = [category];
      const nav = await focusHighlightedIds(targetIds.slice(0, 1));
      return { didSomething: true, reason: "highlight-category-context" as const, nav };
    }
  }

  if (!viewerApi.isolateCategory) {
    console.warn("[FollowUp] isolateCategory not wired");
    return { didSomething: false, reason: "isolate-category-not-wired" as const };
  }

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
    const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
    const activeClass =
      (focus?.activeEntityId ? currentTaskGraph?.entities.byId[focus.activeEntityId]?.entityClass : undefined) ??
      currentTaskGraph?.intent.primaryClass;
    const isRampTarget = typeof activeClass === "string" && activeClass.toUpperCase().includes("IFCRAMP");
    const navProfile = isRampTarget ? RAMP_NAVIGATION_DEFAULTS : HIGHLIGHT_NAVIGATION_DEFAULTS;
    const m = await navigationAgent.navigateToSelection(map, {
      minTargetAreaRatio: isRampTarget
        ? navProfile.targetAreaRatio
        : Math.max(HIGHLIGHT_TARGET_AREA_RATIO, HIGHLIGHT_NAVIGATION_DEFAULTS.targetAreaRatio),
      maxSteps: isRampTarget ? navProfile.maxSteps : 20,
      zoomFactor: navProfile.zoomFactor,
      orbitDegrees: lastViewPreset === "top" ? 0 : navProfile.orbitDegrees,
      enableOcclusion: false,
    });
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
  lastHighlightedIds = [];
  lastSelectedId = null;
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

    const taskGraph = createTaskGraph(prompt);
    enrichTaskGraphFromText(taskGraph, prompt);
    currentTaskGraph = taskGraph;

    const maxSteps = Math.max(1, Math.min(20, params.maxSteps ?? DEFAULT_MAX_COMPLIANCE_STEPS));

    // One rule per project: reset everything relevant
    await viewerApi.resetVisibility();
    await snapshotCollector.reset();

    // Create a new compliance run id (DB is “decisions only” for now)
    activeRunId = makeRunId();
    navigationBookmarks = [];

    let lastActionReason: string | null = null;
    let pendingNav: NavMetrics | undefined = undefined;
    let lastEvidenceNav: NavMetrics | undefined = undefined;
    let lastFollowUpKey: string | null = null;
    let repeatedFollowUpCount = 0;
    const entityEvidenceStats = new Map<string, EntityEvidenceStat>();

    // Apply deterministic start (optional)
    await applyDeterministicStart(params.deterministic);
    const metadataSeeded = await seedTaskGraphFromMetadata(taskGraph, params.deterministic);
    if (metadataSeeded) {
      lastActionReason = "metadata-seed";
    }
    params.onProgress?.({
      stage: metadataSeeded ? "seeded" : "starting",
      step: 0,
      summary: metadataSeeded
        ? "Seeded entity tasks from model metadata and prepared the first focused queue."
        : "Prepared the inspection run and waiting for the first snapshot.",
      taskGraph: summarizeTaskGraph(taskGraph),
      lastActionReason,
    });

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
const syncEntityTasks = () => {
  if (!lastHighlightedIds.length) return;
  const focus = getTaskGraphFocus(taskGraph);
  const activeEntityClass =
    (focus.activeEntityId ? taskGraph.entities.byId[focus.activeEntityId]?.entityClass : undefined) ??
    taskGraph.intent.repeatedEntityClass ??
    taskGraph.intent.primaryClass ??
    "IfcElement";
  syncTaskGraphEntities(taskGraph, lastHighlightedIds, { storeyId: lastScope.storeyId, entityClass: activeEntityClass });
};

    // Step loop
    for (let step = 1; step <= maxSteps; step++) {
const note = enrichNote(`compliance_step_${step}_view`, params.deterministic) +
  (lastActionReason ? ` | prevAction=${lastActionReason}` : "");

      const artifact = await snapshotCollector.capture(note, "RENDER_PLUS_JSON_METADATA");
      params.onProgress?.({
        stage: "captured",
        step,
        summary: `Captured step ${step} snapshot and assembled the current evidence window.`,
        taskGraph: summarizeTaskGraph(taskGraph),
        lastActionReason,
      });

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
const viewerGrid = viewerApi.getGridReference?.();
const floorContext = await detectFloorContextSignal({
  viewerApi,
  lastScope,
  lastViewPreset,
  lastHighlightedIds,
  lastIsolatedCategories,
  planCutState,
});
const highlightAnnotations =
  artifact.meta.context && typeof artifact.meta.context.highlightAnnotations === "object"
    ? (artifact.meta.context.highlightAnnotations as Record<string, unknown>)
    : undefined;

// capture current evidence context
const context: EvidenceContext = {
  step,
  phase,
  viewPreset: lastViewPreset ?? undefined,
  cameraPose,
  scope: (lastScope.storeyId || lastScope.spaceId) ? lastScope : undefined,
  isolatedCategories: lastIsolatedCategories.length ? lastIsolatedCategories : undefined,
  isolatedIds: flattenModelIdMap(viewerApi.getCurrentIsolateSelection?.() ?? null),
  hiddenIds: lastHiddenIds.length ? lastHiddenIds : undefined,
  highlightedIds: lastHighlightedIds.length ? lastHighlightedIds : undefined,
  selectedId: lastSelectedId ?? undefined,
  lastActionReason: lastActionReason ?? undefined,
  availableStoreys,
  availableSpaces,
  planCut: planCutState,
  viewerGrid,
  floorContext,
  highlightAnnotations,
  taskGraph: summarizeTaskGraph(taskGraph),
  navigationHistory: summarizeNavigationHistory(),
};

// then after you capture the next snapshot:
pushEvidence({ artifact, nav: pendingNav, context });
      lastEvidenceNav = pendingNav;
      const bookmark = await createNavigationBookmark(
        step,
        `Step ${step} ${lastViewPreset ? `${lastViewPreset.toUpperCase()} ` : ""}${lastActionReason ? `after ${lastActionReason}` : "snapshot"}`.trim(),
        lastActionReason ?? "snapshot"
      );
      bookmark.snapshotId = artifact.id;
      rememberNavigationBookmark(bookmark);
pendingNav = undefined;
syncEntityTasks();




      const windowed = getEvidenceWindow();
      const promptWithChecklist = `${prompt}\n\n${buildTaskGraphPromptSection(taskGraph)}`;
      const decision = await vlmChecker.check({
        prompt: promptWithChecklist,
        artifacts: windowed.artifacts,
        evidenceViews: windowed.evidenceViews,
      });
      const decisionFocus = getTaskGraphFocus(taskGraph);
      const activeEntityBeforeDecision = decisionFocus.activeEntityId;
      const doorClearanceReadiness = (context.highlightAnnotations as any)?.doorClearanceReadiness as
        | {
            measurableLikely?: boolean;
            evidenceBundle?: {
              topMeasurementViewReady?: boolean;
              contextConfirmViewReady?: boolean;
            };
          }
        | undefined;
      const enrichmentText = [
        decision.meta?.composedPromptText,
        decision.rationale,
        decision.followUp?.request === "WEB_FETCH" ? "web fetch requested for missing regulatory context" : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (enrichmentText) {
        enrichTaskGraphFromText(taskGraph, enrichmentText);
      }
      updateTaskGraphFromDecision(taskGraph, decision);
      params.onProgress?.({
        stage: "decision",
        step,
        summary: `Received ${decision.verdict} at ${(decision.confidence * 100).toFixed(0)}% confidence and updated the active task state.`,
        taskGraph: summarizeTaskGraph(taskGraph),
        lastActionReason,
        verdict: decision.verdict,
        confidence: decision.confidence,
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

      if (activeEntityBeforeDecision) {
        const workflowSignature = buildWorkflowSignature({
          entityId: activeEntityBeforeDecision,
          decision,
          viewPreset: lastViewPreset,
          planCutEnabled: Boolean(planCutState?.enabled),
          isolatedCategories: lastIsolatedCategories,
          highlightedIds: lastHighlightedIds,
          lastActionReason,
        });
        const stats = entityEvidenceStats.get(activeEntityBeforeDecision) ?? {
          steps: 0,
          uncertainSteps: 0,
          repeatedWorkflowStreak: 0,
        };
        stats.topMeasurementReady =
          stats.topMeasurementReady || Boolean(doorClearanceReadiness?.evidenceBundle?.topMeasurementViewReady);
        stats.contextConfirmReady =
          stats.contextConfirmReady || Boolean(doorClearanceReadiness?.evidenceBundle?.contextConfirmViewReady);
        stats.steps += 1;
        stats.uncertainSteps = decision.verdict === "UNCERTAIN" ? stats.uncertainSteps + 1 : stats.uncertainSteps;
        stats.repeatedWorkflowStreak =
          decision.verdict === "UNCERTAIN" && stats.lastWorkflowSignature === workflowSignature
            ? stats.repeatedWorkflowStreak + 1
            : 1;
        stats.lastWorkflowSignature = workflowSignature;
        entityEvidenceStats.set(activeEntityBeforeDecision, stats);

        if (
          decision.verdict === "UNCERTAIN" &&
          lastEvidenceNav?.zoomPotentialExhausted &&
          (!decision.followUp || decision.followUp.request === "ZOOM_IN")
        ) {
          markActiveEntityInconclusive(
            taskGraph,
            "Focused zoom potential was already exhausted for the active entity, so further generic zoom requests were suppressed."
          );
          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "zoom-potential-exhausted";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? "Focused zoom was already exhausted for the current entity, so the runner advanced instead of repeating the same zoom."
              : "Focused zoom was already exhausted for the current entity, so it was marked inconclusive.",
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
          });
          if (advanceResult.advanced) {
            await (viewerApi as any).stabilizeForSnapshot?.();
            continue;
          }
          return {
            ok: true as const,
            runId: activeRunId,
            final: decision,
            decisions: allDecisions,
            snapshots: evidence.length,
          };
        }

        if (
          decision.verdict === "UNCERTAIN" &&
          (
            (stats.uncertainSteps >= ENTITY_UNCERTAIN_TERMINATION_STEPS &&
              decision.confidence >= ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE) ||
            stats.repeatedWorkflowStreak >= ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS
          )
        ) {
          markActiveEntityInconclusive(
            taskGraph,
            stats.repeatedWorkflowStreak >= ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS
              ? `Workflow stalled after ${stats.repeatedWorkflowStreak} repeated uncertain state(s).`
              : `Evidence exhausted after ${stats.uncertainSteps} uncertain step(s) at ${(decision.confidence * 100).toFixed(0)}% confidence.`
          );
          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : stats.repeatedWorkflowStreak >= ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS
              ? "entity-workflow-stalled"
              : "entity-evidence-exhausted";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? advanceResult.restoredPreparedView
                ? `Evidence for the current entity was insufficient, so the runner restored the prepared storey plan-cut view and advanced to the next entity.`
                : stats.repeatedWorkflowStreak >= ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS
                  ? `The current entity repeated the same uncertain workflow, so the runner advanced to the next entity.`
                  : `Evidence for the current entity was insufficient after repeated uncertain steps, so the runner advanced to the next entity.`
              : stats.repeatedWorkflowStreak >= ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS
                ? `The current entity repeated the same uncertain workflow, so it was marked inconclusive.`
                : `Evidence for the current entity was insufficient after repeated uncertain steps, so it was marked inconclusive.`,
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
          });
          if (advanceResult.advanced) {
            await (viewerApi as any).stabilizeForSnapshot?.();
            continue;
          }
          toast?.("Active entity marked inconclusive after repeated uncertain evidence.");
          return {
            ok: true as const,
            runId: activeRunId,
            final: decision,
            decisions: allDecisions,
            snapshots: evidence.length,
          };
        }

        if (
          decision.verdict === "UNCERTAIN" &&
          doorClearanceReadiness?.measurableLikely &&
          stats.topMeasurementReady &&
          stats.contextConfirmReady &&
          !decision.followUp
        ) {
          markActiveEntityInconclusive(
            taskGraph,
            "Collected the required measurement and context views, but the evidence still did not support a reliable pass or fail."
          );
          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "entity-decidable-bundle-exhausted";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? "The current entity already had the required decisive evidence bundle, so the runner advanced to the next entity."
              : "The current entity already had the required decisive evidence bundle, so it was marked inconclusive.",
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
          });
          if (advanceResult.advanced) {
            await (viewerApi as any).stabilizeForSnapshot?.();
            continue;
          }
          return {
            ok: true as const,
            runId: activeRunId,
            final: decision,
            decisions: allDecisions,
            snapshots: evidence.length,
          };
        }

        if (!decision.followUp) {
          if (decision.verdict === "UNCERTAIN") {
            markActiveEntityInconclusive(
              taskGraph,
              "No further follow-up was proposed for the active entity, so it was finalized as inconclusive."
            );
          }

          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "advance-to-next-entity";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? `No further follow-up was proposed for the current entity, so the runner finalized it and advanced to the next entity.`
              : `No further follow-up was proposed for the current entity, so it was finalized.`,
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
          });
          if (advanceResult.advanced) {
            await (viewerApi as any).stabilizeForSnapshot?.();
            continue;
          }
          return {
            ok: true as const,
            runId: activeRunId,
            final: decision,
            decisions: allDecisions,
            snapshots: evidence.length,
          };
        }
      }

      const confident = decision.confidence >= minConfidence;

      if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && confident) {
        const completedEntityId = activeEntityBeforeDecision;
        const advanceResult = await advanceToNextEntity(taskGraph, completedEntityId);
        if (advanceResult.advanced) {
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "advance-to-next-entity";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.restoredPreparedView
              ? `The current entity was decided, so the runner restored the prepared storey plan-cut view and continued with the next entity on that storey.`
              : `The current entity was decided, so the runner continued with the next entity.`,
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
          });
          await (viewerApi as any).stabilizeForSnapshot?.();
          continue;
        }
        toast?.(
          `Compliance result: ${decision.verdict} (${(decision.confidence * 100).toFixed(0)}%)`
        );
        params.onProgress?.({
          stage: "finished",
          step,
          summary: `Finished with ${decision.verdict} at ${(decision.confidence * 100).toFixed(0)}% confidence.`,
          taskGraph: summarizeTaskGraph(taskGraph),
          lastActionReason,
          verdict: decision.verdict,
          confidence: decision.confidence,
        });
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
if (repeatedFollowUpCount >= REPEATED_FOLLOW_UPS_BEFORE_ESCALATION) {
  console.warn("[Compliance] repeating same followUp, escalating", decision.followUp);
  followUpToRun = escalateFollowUp(decision.followUp);
  repeatedFollowUpCount = 0; // reset after escalation so we don't immediately loop
}

const acted = await executeFollowUp(followUpToRun, lastActionReason, lastEvidenceNav);
lastActionReason = acted.reason;
pendingNav = (acted as any).nav ?? undefined;
updateTaskGraphFromFollowUpResult(taskGraph, followUpToRun, acted.didSomething, acted.reason);
syncEntityTasks();
params.onProgress?.({
  stage: "followup",
  step,
  summary: acted.didSomething
    ? `Executed follow-up ${followUpToRun?.request ?? "none"} to gather better evidence.`
    : `Follow-up ${followUpToRun?.request ?? "none"} could not improve the current evidence.`,
  taskGraph: summarizeTaskGraph(taskGraph),
  lastActionReason,
});

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

/*      if (decision.verdict === "UNCERTAIN" && confident) {
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
*/
    // Do not early-stop on UNCERTAIN, even if confidence is high.
    // Continue gathering evidence and applying follow-ups so reports include full step history.

const fuKey = followUpKey(decision.followUp);
if (fuKey && fuKey === lastFollowUpKey) repeatedFollowUpCount++;
else repeatedFollowUpCount = 0;
lastFollowUpKey = fuKey;

let followUpToRun = decision.followUp;

// If same followUp repeats, escalate instead of resetting
if (repeatedFollowUpCount >= REPEATED_FOLLOW_UPS_BEFORE_ESCALATION) {
  console.warn("[Compliance] repeating same followUp, escalating", decision.followUp);
  followUpToRun = escalateFollowUp(decision.followUp);
  repeatedFollowUpCount = 0; // reset after escalation so we don't immediately loop
}

const acted = await executeFollowUp(followUpToRun, lastActionReason, lastEvidenceNav);
lastActionReason = acted.reason;
pendingNav = (acted as any).nav ?? undefined;
updateTaskGraphFromFollowUpResult(taskGraph, followUpToRun, acted.didSomething, acted.reason);
syncEntityTasks();
params.onProgress?.({
  stage: "followup",
  step,
  summary: acted.didSomething
    ? `Executed follow-up ${followUpToRun?.request ?? "none"} to refine the current task.`
    : `Follow-up ${followUpToRun?.request ?? "none"} did not change the current state.`,
  taskGraph: summarizeTaskGraph(taskGraph),
  lastActionReason,
});

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

// src/modules/complianceRunner.ts
// Orchestrates "one rule per project": reset state, (optional) deterministic start,
// capture snapshot(s), call VLM checker, store decisions, and optionally do follow-ups.

import {
  clampMaxSnapshotsPerRequest,
  ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS,
  HIGHLIGHT_NAVIGATION_DEFAULTS,
  HIGHLIGHT_TARGET_AREA_RATIO,
  MAX_ORBIT_DEGREES_PER_AXIS,
  MAX_ORBIT_FOLLOW_UPS_PER_ENTITY,
  RAMP_NAVIGATION_DEFAULTS,
  REPEATED_FOLLOW_UPS_BEFORE_ESCALATION,
  SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS,
  SAME_ENTITY_RECURRENCE_DECAY,
  SAME_ENTITY_RECURRENCE_WARNING_THRESHOLD,
  SAME_ENTITY_RECURRENCE_WEIGHTS,
  TOP_VIEW_TARGET_AREA_RATIO,
  ZOOM_IN_EXHAUSTION_AREA_FACTOR,
  getPrototypeRuntimeSettings,
} from "../config/prototypeSettings";
import type { CameraPose, StartPosePreset, ViewerGridReference } from "../viewer/api";
import type { SnapshotArtifact } from "./snapshotCollector";
import type { VlmDecision, VlmFollowUp } from "./vlmChecker";
import { buildCompactFollowUpTaskPrompt } from "./vlmAdapters/prompts/promptWrappers";
import {
  assessPromptRegulatoryGrounding,
  hasExplicitRegulatoryGapText,
} from "./regulatoryContext";
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
import type {
  FollowUpActionFamily,
  NavigationAction,
  NavigationStateTrace,
  PlanCutStateTrace,
  SemanticEvidenceProgressTrace,
  SnapshotNoveltyMetrics,
  SuppressedFollowUpTrace,
} from "../types/trace.types";
import type {
  EvidenceRequirementReasonMap,
  EvidenceRequirementsSnapshot,
  EvidenceRequirementsStatus,
} from "../types/evidenceRequirements.types";

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
  orbitFollowUps: number;
  lastWorkflowSignature?: string;
  topMeasurementReady?: boolean;
  contextConfirmReady?: boolean;
  recentLowNoveltyCount: number;
  recentRedundancyWarnings: number;
  lastLowNoveltyAction?: VlmFollowUp["request"];
  lastUsefulNoveltyScore?: number;
};

type SemanticEvidenceProgress = SemanticEvidenceProgressTrace;

type EntitySemanticEvidenceTracker = {
  activeEntityId: string;
  previousMissingEvidenceNormalized: string[];
  previousEvidenceRequirementsStatus: EvidenceRequirementsStatus;
  repeatedEvidenceGapCount: number;
  triedActionFamilies: FollowUpActionFamily[];
  triedActionFamilyCounts: Partial<Record<FollowUpActionFamily, number>>;
  stagnatedActionFamilies: FollowUpActionFamily[];
  lastActionFamily?: FollowUpActionFamily;
  lastEvidenceProgressSummary?: string;
  lastSemanticProgressScore?: number;
  suppressedFollowUp?: SuppressedFollowUpTrace;
  finalizationReason?: string;
};

type EvidenceItem = {
  artifact: SnapshotArtifact;
  nav?: NavMetrics;
  context?: EvidenceContext;
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
  isolatedIds: string[];
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
  activeEntityId?: string;
  scope?: { storeyId?: string; spaceId?: string };
  isolatedCategories?: string[];
  isolatedIds?: string[];
  hiddenIds?: string[];
  highlightedIds?: string[];
  selectedId?: string | null;
  lastActionReason?: string | null;
  availableStoreys?: string[];
  availableSpaces?: string[];
  planCut?: {
    enabled: boolean;
    planes?: number;
    height?: number;
    absoluteHeight?: number;
    thickness?: number;
    mode?: string;
    source?: string;
    storeyId?: string;
  };
  viewerGrid?: ViewerGridReference;
  highlightAnnotations?: Record<string, unknown>;
  floorContext?: {
    missingLikely: boolean;
    visibleFloorCategories: string[];
    recommendedAction?: "SET_STOREY_PLAN_CUT";
    reason?: string;
  };
  followUpBudget?: {
    orbitCallsForActiveEntity: number;
    maxOrbitCallsPerEntity: number;
    orbitRemainingForActiveEntity: number;
    orbitMaxHighlightOcclusionRatio: number;
  };
  evidenceRequirements?: EvidenceRequirementsSnapshot;
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
  snapshotNovelty?: SnapshotNoveltyMetrics;
  semanticEvidenceProgress?: SemanticEvidenceProgress;
  normalizedEvidenceGaps?: string[];
  triedActionFamilies?: FollowUpActionFamily[];
  suppressedFollowUp?: SuppressedFollowUpTrace;
  finalizationReason?: string;
};

type FullTraceEvidenceContext = EvidenceContext;

type CompactVlmEvidenceContext = {
  contextMode: "compact_vlm_evidence";
  snapshotId: string;
  note?: string;
  stepLabel?: string;
  activeEntity: {
    id: string;
    class: string;
    storeyId?: string;
  };
  taskBrief?: {
    activeTaskTitle?: string;
    activeStoreyId?: string;
  };
  currentView: {
    viewPreset: "top" | "iso" | "angled" | "unknown";
    viewLayout?: string;
    targetHighlighted: boolean;
    targetFocused?: boolean;
    planCutEnabled: boolean;
    scopeSummary: {
      mode: "storey" | "category" | "space" | "none";
      storeyId?: string;
      spaceId?: string;
      isolatedElements?: {
        count: number;
        containsActiveEntity: boolean;
      };
      hidden: {
        count: number;
        categories?: string[];
      };
      highlighted: {
        count: number;
        activeTargetHighlighted: boolean;
      };
      isolatedCategoryCount?: number;
    };
  };
  visualReference?: {
    gridCellSizeMeters?: number;
    majorGridCellSizeMeters?: number;
    targetMetadata?: {
      dimensions?: string;
      legend?: string[];
    };
  };
  navigationQuality?: {
    projectedAreaRatio?: number;
    zoomPotentialExhausted?: boolean;
    visualNoveltyScore?: number;
    redundancyWarning?: string;
  };
  evidenceRequirements: {
    resolved: string[];
    missing: string[];
    missingReasons?: Record<string, string>;
  };
  semanticProgress?: {
    semanticProgressScore?: number;
    semanticStagnationWarning?: boolean;
    normalizedEvidenceGaps?: string[];
  };
  runtimeHints?: {
    orbitRemainingForActiveEntity?: number;
  };
  runtimeNotice?: string;
};

type PromptContextStats = {
  fullContextChars: number;
  compactContextChars: number;
  snapshotCount: number;
  compactModeEnabled: boolean;
  usedCompactContext: boolean;
  fullFallbackSnapshotIds?: string[];
};

type SnapshotNoveltyComparable = {
  snapshotId: string;
  activeEntityId?: string;
  viewPreset?: EvidenceContext["viewPreset"];
  cameraPose: CameraPose;
  scope?: EvidenceContext["scope"];
  highlightedIds?: string[];
  planCut?: EvidenceContext["planCut"];
  nav?: NavMetrics;
};

type ToastFn = (msg: string, ms?: number) => void;

function distance3d(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function normalizeStringArray(values?: string[]): string[] {
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice()
        .sort()
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shortText(value: unknown, maxLength = 140): string | undefined {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…` : normalized;
}

function readHudDimensions(highlightAnnotations?: Record<string, unknown>): string | undefined {
  const sizeReference = asRecord(highlightAnnotations?.sizeReference);
  const hudContents = asRecord(highlightAnnotations?.hudContents);
  const hudDimensions = shortText(hudContents?.dimensions, 80);
  if (hudDimensions) return hudDimensions;

  const width = typeof sizeReference?.width === "number" ? sizeReference.width : undefined;
  const depth = typeof sizeReference?.depth === "number" ? sizeReference.depth : undefined;
  const height = typeof sizeReference?.height === "number" ? sizeReference.height : undefined;
  if ([width, depth, height].every((value) => typeof value === "number")) {
    return `W ${width!.toFixed(3)} m D ${depth!.toFixed(3)} m H ${height!.toFixed(3)} m`;
  }
  return undefined;
}

function readCompactLegend(highlightAnnotations?: Record<string, unknown>): string[] | undefined {
  const hudContents = asRecord(highlightAnnotations?.hudContents);
  const hudLegend = Array.isArray(hudContents?.legend) ? hudContents.legend : undefined;
  const highlightLegend = Array.isArray(highlightAnnotations?.legend) ? highlightAnnotations.legend : undefined;
  const source = hudLegend?.length ? hudLegend : highlightLegend;
  if (!source?.length) return undefined;

  const labels = source
    .map((entry) => {
      if (typeof entry === "string") return shortText(entry, 30);
      const record = asRecord(entry);
      return shortText(record?.meaning ?? record?.label, 30);
    })
    .filter((value): value is string => Boolean(value));

  return labels.length ? Array.from(new Set(labels)).slice(0, 4) : undefined;
}

function summarizeIsolationMode(context: FullTraceEvidenceContext): "storey" | "category" | "space" | "none" {
  if (context.scope?.spaceId) return "space";
  if (context.scope?.storeyId || context.planCut?.storeyId) return "storey";
  if (context.isolatedCategories?.length) return "category";
  return "none";
}

function inferCompactViewPreset(
  context: FullTraceEvidenceContext,
  highlightAnnotations?: Record<string, unknown>
): "top" | "iso" | "angled" | "unknown" {
  if (context.viewPreset === "top") return "top";
  if (context.viewPreset === "iso") return "iso";
  const viewLayout = shortText(highlightAnnotations?.viewLayout, 30);
  if (viewLayout?.includes("angled")) return "angled";
  if (viewLayout?.includes("top")) return "top";
  return "unknown";
}

function buildEvidenceRequirementSummary(
  evidenceRequirements?: EvidenceRequirementsSnapshot
): CompactVlmEvidenceContext["evidenceRequirements"] {
  const status = evidenceRequirements?.status ?? {};
  const reasons = evidenceRequirements?.reasons ?? {};
  const resolved = Object.entries(status)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  const missing = Object.entries(status)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  const missingReasons = Object.fromEntries(
    missing
      .map((key) => [key, shortText(reasons[key as keyof typeof reasons], 120)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  );

  if (!resolved.length && !missing.length) {
    return {
      resolved: [],
      missing: ["unspecified_evidence_requirements"],
      missingReasons: {
        unspecified_evidence_requirements: "Runtime evidence requirements were not attached to this snapshot.",
      },
    };
  }

  return {
    resolved,
    missing,
    ...(Object.keys(missingReasons).length ? { missingReasons } : {}),
  };
}

function buildRuntimeNotice(context: FullTraceEvidenceContext): string | undefined {
  const notices = [
    context.snapshotNovelty?.redundancyWarning
      ? "Recent view looks redundant for the active entity."
      : undefined,
    context.semanticEvidenceProgress?.semanticStagnationWarning
      ? "Semantic evidence gaps are stagnating."
      : undefined,
    shortText(context.suppressedFollowUp?.reason, 120),
    shortText(context.finalizationReason, 120),
  ].filter((value): value is string => Boolean(value));

  return notices.length ? notices.slice(0, 2).join(" ") : undefined;
}

/**
 * Compact VLM evidence context logic:
 * keep full trace context for audit/report export, but send a summarized,
 * task-focused context to the VLM prompt.
 */
function buildCompactVlmEvidenceContext(args: {
  snapshotId: string;
  note?: string;
  fullContext: FullTraceEvidenceContext;
  nav?: NavMetrics;
}): CompactVlmEvidenceContext {
  const { snapshotId, note, fullContext, nav } = args;
  const highlightAnnotations = asRecord(fullContext.highlightAnnotations);
  const hudContents = asRecord(highlightAnnotations?.hudContents);
  const taskGraph = fullContext.taskGraph;
  const activeEntityId =
    fullContext.activeEntityId ??
    taskGraph?.activeEntity?.id ??
    (typeof fullContext.selectedId === "string" ? fullContext.selectedId : undefined) ??
    (fullContext.highlightedIds?.[0] || undefined) ??
    "unknown_active_entity";
  const activeEntityClass =
    taskGraph?.activeEntity?.class ??
    taskGraph?.primaryClass ??
    shortText(highlightAnnotations?.primaryClass, 60) ??
    shortText(hudContents?.title, 60)?.split(/\s+/)[0] ??
    "unknown_class";
  const activeStoreyId =
    fullContext.scope?.storeyId ??
    fullContext.planCut?.storeyId ??
    taskGraph?.activeStoreyId ??
    taskGraph?.activeEntity?.storeyId;
  const targetHighlighted = Boolean(activeEntityId && fullContext.highlightedIds?.includes(activeEntityId));
  const evidenceRequirements = buildEvidenceRequirementSummary(fullContext.evidenceRequirements);
  const legend = readCompactLegend(highlightAnnotations);
  const dimensions = readHudDimensions(highlightAnnotations);
  const hiddenCategories = fullContext.hiddenIds?.length
    ? Array.from(
        new Set(
          fullContext.hiddenIds
            .map((id) => {
              const prefix = id.split(":")[0]?.trim();
              return prefix && /^Ifc/i.test(prefix) ? prefix : undefined;
            })
            .filter((value): value is string => Boolean(value))
        )
      ).slice(0, 4)
    : undefined;

  return {
    contextMode: "compact_vlm_evidence",
    snapshotId,
    ...(note ? { note } : {}),
    stepLabel: `step_${fullContext.step}_${fullContext.phase}`,
    activeEntity: {
      id: activeEntityId,
      class: activeEntityClass,
      ...(activeStoreyId ? { storeyId: activeStoreyId } : {}),
    },
    ...(taskGraph?.activeTask?.title || activeStoreyId
      ? {
          taskBrief: {
            ...(taskGraph?.activeTask?.title ? { activeTaskTitle: taskGraph.activeTask.title } : {}),
            ...(activeStoreyId ? { activeStoreyId } : {}),
          },
        }
      : {}),
    currentView: {
      viewPreset: inferCompactViewPreset(fullContext, highlightAnnotations),
      ...(shortText(highlightAnnotations?.viewLayout, 30)
        ? { viewLayout: shortText(highlightAnnotations?.viewLayout, 30) }
        : {}),
      targetHighlighted,
      ...(typeof fullContext.evidenceRequirements?.status?.targetFocused === "boolean"
        ? { targetFocused: fullContext.evidenceRequirements.status.targetFocused }
        : {}),
      planCutEnabled: Boolean(fullContext.planCut?.enabled),
      scopeSummary: {
        mode: summarizeIsolationMode(fullContext),
        ...(fullContext.scope?.storeyId ? { storeyId: fullContext.scope.storeyId } : {}),
        ...(fullContext.scope?.spaceId ? { spaceId: fullContext.scope.spaceId } : {}),
        ...(typeof fullContext.isolatedIds?.length === "number"
          ? {
              isolatedElements: {
                count: fullContext.isolatedIds.length,
                containsActiveEntity: Boolean(activeEntityId && fullContext.isolatedIds.includes(activeEntityId)),
              },
            }
          : {}),
        hidden: {
          count: fullContext.hiddenIds?.length ?? 0,
          ...(hiddenCategories?.length ? { categories: hiddenCategories } : {}),
        },
        highlighted: {
          count: fullContext.highlightedIds?.length ?? 0,
          activeTargetHighlighted: targetHighlighted,
        },
        ...(fullContext.isolatedCategories?.length
          ? { isolatedCategoryCount: fullContext.isolatedCategories.length }
          : {}),
      },
    },
    ...(fullContext.viewerGrid || dimensions || legend
      ? {
          visualReference: {
            ...(typeof fullContext.viewerGrid?.primaryCellSize === "number"
              ? { gridCellSizeMeters: fullContext.viewerGrid.primaryCellSize }
              : {}),
            ...(typeof fullContext.viewerGrid?.secondaryCellSize === "number"
              ? { majorGridCellSizeMeters: fullContext.viewerGrid.secondaryCellSize }
              : {}),
            ...(dimensions || legend
              ? {
                  targetMetadata: {
                    ...(dimensions ? { dimensions } : {}),
                    ...(legend?.length ? { legend } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(nav?.projectedAreaRatio !== undefined ||
    nav?.zoomPotentialExhausted ||
    fullContext.snapshotNovelty?.approximateNoveltyScore !== undefined
      ? {
          navigationQuality: {
            ...(typeof nav?.projectedAreaRatio === "number"
              ? { projectedAreaRatio: nav.projectedAreaRatio }
              : {}),
            ...(nav?.zoomPotentialExhausted ? { zoomPotentialExhausted: true } : {}),
            ...(typeof fullContext.snapshotNovelty?.approximateNoveltyScore === "number"
              ? { visualNoveltyScore: Number(fullContext.snapshotNovelty.approximateNoveltyScore.toFixed(3)) }
              : {}),
            ...(fullContext.snapshotNovelty?.redundancyWarning
              ? { redundancyWarning: "Current view appears visually redundant for this target." }
              : {}),
          },
        }
      : {}),
    evidenceRequirements,
    ...(fullContext.semanticEvidenceProgress
      ? {
          semanticProgress: {
            ...(typeof fullContext.semanticEvidenceProgress.semanticProgressScore === "number"
              ? {
                  semanticProgressScore: Number(
                    fullContext.semanticEvidenceProgress.semanticProgressScore.toFixed(3)
                  ),
                }
              : {}),
            ...(typeof fullContext.semanticEvidenceProgress.semanticStagnationWarning === "boolean"
              ? {
                  semanticStagnationWarning:
                    fullContext.semanticEvidenceProgress.semanticStagnationWarning,
                }
              : {}),
            ...(fullContext.normalizedEvidenceGaps?.length
              ? { normalizedEvidenceGaps: fullContext.normalizedEvidenceGaps.slice(0, 5) }
              : {}),
          },
        }
      : {}),
    ...(typeof fullContext.followUpBudget?.orbitRemainingForActiveEntity === "number"
      ? {
          runtimeHints: {
            orbitRemainingForActiveEntity: fullContext.followUpBudget.orbitRemainingForActiveEntity,
          },
        }
      : {}),
    ...(buildRuntimeNotice(fullContext) ? { runtimeNotice: buildRuntimeNotice(fullContext) } : {}),
  };
}

function shouldFallbackToFullContext(compact: CompactVlmEvidenceContext): boolean {
  return (
    !compact.snapshotId ||
    !compact.activeEntity?.id ||
    compact.activeEntity.id === "unknown_active_entity" ||
    !compact.activeEntity?.class ||
    compact.activeEntity.class === "unknown_class" ||
    !compact.evidenceRequirements ||
    (!compact.evidenceRequirements.resolved.length && !compact.evidenceRequirements.missing.length)
  );
}

function sameStringArray(a?: string[], b?: string[]): boolean {
  const left = normalizeStringArray(a);
  const right = normalizeStringArray(b);
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeScope(scope?: EvidenceContext["scope"]): { storeyId?: string; spaceId?: string } | undefined {
  if (!scope) return undefined;
  return {
    storeyId: typeof scope.storeyId === "string" ? scope.storeyId : undefined,
    spaceId: typeof scope.spaceId === "string" ? scope.spaceId : undefined,
  };
}

function sameScope(a?: EvidenceContext["scope"], b?: EvidenceContext["scope"]): boolean {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  return (left?.storeyId ?? null) === (right?.storeyId ?? null) &&
    (left?.spaceId ?? null) === (right?.spaceId ?? null);
}

function normalizePlanCutKey(planCut?: EvidenceContext["planCut"]): string {
  if (!planCut) return "none";
  return JSON.stringify({
    enabled: Boolean(planCut.enabled),
    height: typeof planCut.height === "number" ? Number(planCut.height.toFixed(3)) : null,
    absoluteHeight:
      typeof planCut.absoluteHeight === "number" ? Number(planCut.absoluteHeight.toFixed(3)) : null,
    thickness: typeof planCut.thickness === "number" ? Number(planCut.thickness.toFixed(3)) : null,
    mode: typeof planCut.mode === "string" ? planCut.mode : null,
    source: typeof planCut.source === "string" ? planCut.source : null,
    storeyId: typeof planCut.storeyId === "string" ? planCut.storeyId : null,
  });
}

function stableJson(x: any): string {
  if (x == null) return "";
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  if (typeof x === "object") {
    const keys = Object.keys(x).sort();
    return `{${keys.map((key) => `${key}:${stableJson((x as any)[key])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

function getYawPitchDegrees(pose: CameraPose): { yawDeg: number; pitchDeg: number } | null {
  const dx = pose.target.x - pose.eye.x;
  const dy = pose.target.y - pose.eye.y;
  const dz = pose.target.z - pose.eye.z;
  const horizontalLength = Math.sqrt(dx * dx + dz * dz);
  const fullLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!isFinite(fullLength) || fullLength <= 1e-6) return null;
  return {
    yawDeg: Math.atan2(dz, dx) * (180 / Math.PI),
    pitchDeg: Math.atan2(dy, Math.max(horizontalLength, 1e-6)) * (180 / Math.PI),
  };
}

function getSmallestAngleDeltaDegrees(a: number, b: number): number {
  const wrapped = ((a - b + 540) % 360) - 180;
  return Math.abs(wrapped);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function expSimilarity(delta: number, scale: number): number {
  if (!Number.isFinite(delta) || !Number.isFinite(scale) || scale <= 1e-6) return 0;
  return clamp01(Number(Math.exp(-Math.max(0, delta) / scale).toFixed(2)));
}

function nullableStringEqual(a?: string | null, b?: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

function computeJaccardSimilarity(a?: string[], b?: string[]): number {
  const left = new Set(normalizeStringArray(a));
  const right = new Set(normalizeStringArray(b));
  if (!left.size && !right.size) return 1;
  const intersection = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 ? Number((intersection / union).toFixed(2)) : 0;
}

function computeScopeSimilarity(a?: EvidenceContext["scope"], b?: EvidenceContext["scope"]): number {
  if (!a && !b) return 1;
  if (sameScope(a, b)) return 1;
  if ((a?.storeyId ?? null) && (a?.storeyId ?? null) === (b?.storeyId ?? null)) return 0.5;
  return 0;
}

function computePlanCutSimilarity(
  current?: EvidenceContext["planCut"],
  previous?: EvidenceContext["planCut"]
): number {
  if (!current && !previous) return 1;
  if (normalizePlanCutKey(current) === normalizePlanCutKey(previous)) return 1;
  if (!current || !previous) return 0;

  const enabledSimilarity = Boolean(current.enabled) === Boolean(previous.enabled) ? 1 : 0;
  const modeSimilarity = nullableStringEqual(current.mode, previous.mode) ? 1 : 0;
  const storeySimilarity = nullableStringEqual(current.storeyId, previous.storeyId) ? 1 : 0;

  const currentHeight =
    typeof current.absoluteHeight === "number"
      ? current.absoluteHeight
      : typeof current.height === "number"
        ? current.height
        : undefined;
  const previousHeight =
    typeof previous.absoluteHeight === "number"
      ? previous.absoluteHeight
      : typeof previous.height === "number"
        ? previous.height
        : undefined;
  const heightSimilarity =
    typeof currentHeight === "number" && typeof previousHeight === "number"
      ? expSimilarity(Math.abs(currentHeight - previousHeight), 0.25)
      : currentHeight == null && previousHeight == null
        ? 1
        : 0.25;

  return clamp01(
    Number(
      (
        enabledSimilarity * 0.35 +
        modeSimilarity * 0.2 +
        storeySimilarity * 0.2 +
        heightSimilarity * 0.25
      ).toFixed(2)
    )
  );
}

function computeCameraSimilarity(current: CameraPose, previous: CameraPose): number {
  const currentDistance = distance3d(current.eye, current.target);
  const previousDistance = distance3d(previous.eye, previous.target);
  const representativeDistance = Math.max(currentDistance, previousDistance, 1);
  const eyeDelta = distance3d(current.eye, previous.eye);
  const targetDelta = distance3d(current.target, previous.target);
  const eyeSimilarity = expSimilarity(eyeDelta, Math.max(0.35, representativeDistance * 0.08));
  const targetSimilarity = expSimilarity(targetDelta, Math.max(0.25, representativeDistance * 0.06));
  return Number((((eyeSimilarity + targetSimilarity) / 2)).toFixed(2));
}

function computeMetricSimilarity(
  current?: number,
  previous?: number,
  scale = 0.1
): number {
  if (typeof current === "number" && typeof previous === "number") {
    return expSimilarity(Math.abs(current - previous), scale);
  }
  return current == null && previous == null ? 1 : 0.5;
}

function computeSameEntityViewSimilarity(args: {
  current: SnapshotNoveltyComparable;
  previous: SnapshotNoveltyComparable;
}): number {
  const { current, previous } = args;
  const viewPresetSimilarity = (current.viewPreset ?? null) === (previous.viewPreset ?? null) ? 1 : 0;
  const cameraSimilarity = computeCameraSimilarity(current.cameraPose, previous.cameraPose);
  const planCutSimilarity = computePlanCutSimilarity(current.planCut, previous.planCut);
  const scopeSimilarity = computeScopeSimilarity(current.scope, previous.scope);
  const highlightSimilarity = computeJaccardSimilarity(current.highlightedIds, previous.highlightedIds);
  const projectedAreaSimilarity = computeMetricSimilarity(
    current.nav?.projectedAreaRatio,
    previous.nav?.projectedAreaRatio,
    0.08
  );
  const occlusionSimilarity = computeMetricSimilarity(
    current.nav?.occlusionRatio,
    previous.nav?.occlusionRatio,
    0.12
  );
  const presetPenalty =
    current.viewPreset && previous.viewPreset && current.viewPreset !== previous.viewPreset ? 0.55 : 1;

  return clamp01(
    Number(
      ((
        SAME_ENTITY_RECURRENCE_WEIGHTS.viewPreset * viewPresetSimilarity +
        SAME_ENTITY_RECURRENCE_WEIGHTS.camera * cameraSimilarity +
        SAME_ENTITY_RECURRENCE_WEIGHTS.planCut * planCutSimilarity +
        SAME_ENTITY_RECURRENCE_WEIGHTS.scope * scopeSimilarity +
        SAME_ENTITY_RECURRENCE_WEIGHTS.highlight * highlightSimilarity +
        SAME_ENTITY_RECURRENCE_WEIGHTS.projectedArea * projectedAreaSimilarity +
        SAME_ENTITY_RECURRENCE_WEIGHTS.occlusion * occlusionSimilarity
      ) * presetPenalty).toFixed(2)
    )
  );
}

function computeSemanticFailureWeight(progress?: SemanticEvidenceProgress): number {
  if (!progress) return 0;
  const unresolved = (progress.normalizedEvidenceGaps?.length ?? 0) > 0 || progress.unchangedGapCount > 0;
  if (!unresolved) return 0;
  const base = 1 - clamp01(progress.semanticProgressScore ?? 1);
  const boosted = progress.semanticStagnationWarning ? Math.max(base, 0.85) : base;
  return Number(boosted.toFixed(2));
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bucketMissingEvidenceGap(text: string): string[] {
  const buckets = new Set<string>();
  const has = (pattern: RegExp) => pattern.test(text);

  if (has(/\bvisible|visibility|see|seen|viewable\b/)) buckets.add("target_visibility");
  if (has(/\bfocus|focused|close up|closeup|zoom|center|centred|readable\b/)) buckets.add("target_focus");
  if (has(/\bplan|top view|plan cut|measure|measurement|measurable\b/)) buckets.add("plan_measurement");
  if (has(/\bcontext|angle|orbit|side view|side angle|overview|isometric|iso\b/)) buckets.add("context_view");
  if (has(/\boccl|obstruct|blocked|hidden|clutter\b/)) buckets.add("obstruction_context");
  if (has(/\bdimension|reference|scale|grid|ruler\b/)) buckets.add("dimension_reference");
  if (has(/\bclause|section|regulation|standard|code text|threshold|edition\b/)) buckets.add("regulatory_clause");
  if (has(/\bboth sides|surroundings|adjacent|around|opposite side|nearby\b/)) {
    buckets.add("both_sides_or_surroundings");
  }
  if (has(/\bhandrail|guardrail|rail\b/)) buckets.add("handrail");
  if (has(/\briser|tread|nosing|stair run|step depth|step height\b/)) buckets.add("riser_tread");
  if (has(/\blanding\b/)) buckets.add("landing");
  if (has(/\bheadroom|overhead\b/)) buckets.add("headroom");
  if (has(/\bclearance|clear width|free width\b/)) buckets.add("clearance");

  return [...buckets];
}

function normalizeMissingEvidenceGaps(values?: string[]): string[] {
  const normalized = new Set<string>();
  for (const raw of values ?? []) {
    if (typeof raw !== "string") continue;
    const text = normalizeEvidenceText(raw);
    if (!text) continue;
    const buckets = bucketMissingEvidenceGap(text);
    if (buckets.length) {
      for (const bucket of buckets) normalized.add(bucket);
      continue;
    }
    normalized.add(text.replace(/\b(the|a|an|need|needs|missing)\b/g, "").replace(/\s+/g, " ").trim());
  }
  return [...normalized].filter(Boolean).sort();
}

function normalizeEvidenceRequirementsStatusSnapshot(
  status?: EvidenceRequirementsStatus
): EvidenceRequirementsStatus {
  return Object.fromEntries(
    Object.entries(status ?? {}).filter(([, value]) => typeof value === "boolean")
  ) as EvidenceRequirementsStatus;
}

function classifyFollowUpActionFamily(
  followUp?: VlmFollowUp | VlmFollowUp["request"]
): FollowUpActionFamily | undefined {
  const request = typeof followUp === "string" ? followUp : followUp?.request;
  if (!request) return undefined;
  switch (request) {
    case "TOP_VIEW":
    case "SET_PLAN_CUT":
    case "SET_STOREY_PLAN_CUT":
    case "CLEAR_PLAN_CUT":
      return "plan_measurement";
    case "ISO_VIEW":
    case "NEW_VIEW":
    case "ORBIT":
    case "SET_VIEW_PRESET":
      return "context_angle";
    case "ZOOM_IN":
    case "HIGHLIGHT_IDS":
    case "PICK_OBJECT":
    case "PICK_CENTER":
      return "focus";
    case "ISOLATE_STOREY":
    case "ISOLATE_SPACE":
    case "ISOLATE_CATEGORY":
      return "scope";
    case "HIDE_CATEGORY":
    case "HIDE_IDS":
    case "SHOW_CATEGORY":
    case "SHOW_IDS":
    case "HIDE_SELECTED":
      return "occlusion_or_context_cleanup";
    case "WEB_FETCH":
      return "regulatory_grounding";
    case "GET_PROPERTIES":
      return "property_measurement";
    case "RESTORE_VIEW":
      return "restore";
    case "RESET_VISIBILITY":
      return "reset";
    default:
      return undefined;
  }
}

function summarizeTriedActionFamilies(
  counts: Partial<Record<FollowUpActionFamily, number>>
): FollowUpActionFamily[] {
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([family]) => family as FollowUpActionFamily)
    .sort();
}

function makeDefaultSemanticTracker(activeEntityId: string): EntitySemanticEvidenceTracker {
  return {
    activeEntityId,
    previousMissingEvidenceNormalized: [],
    previousEvidenceRequirementsStatus: {},
    repeatedEvidenceGapCount: 0,
    triedActionFamilies: [],
    triedActionFamilyCounts: {},
    stagnatedActionFamilies: [],
  };
}

function cloneSuppressedFollowUp(
  value?: SuppressedFollowUpTrace
): SuppressedFollowUpTrace | undefined {
  return value ? { ...value } : undefined;
}

function getLowNoveltyActionFamily(action?: VlmFollowUp["request"]): string | null {
  if (!action) return null;
  switch (action) {
    case "NEW_VIEW":
    case "ORBIT":
    case "ZOOM_IN":
    case "TOP_VIEW":
    case "ISO_VIEW":
    case "SET_VIEW_PRESET":
      return "view";
    case "SET_PLAN_CUT":
    case "SET_STOREY_PLAN_CUT":
    case "CLEAR_PLAN_CUT":
      return "plan";
    case "ISOLATE_STOREY":
    case "ISOLATE_SPACE":
    case "ISOLATE_CATEGORY":
    case "HIDE_IDS":
    case "SHOW_IDS":
    case "RESET_VISIBILITY":
    case "HIDE_CATEGORY":
    case "SHOW_CATEGORY":
    case "HIDE_SELECTED":
      return "scope";
    case "PICK_CENTER":
    case "PICK_OBJECT":
    case "GET_PROPERTIES":
    case "HIGHLIGHT_IDS":
      return "target";
    case "RESTORE_VIEW":
      return "restore";
    case "WEB_FETCH":
      return "web";
    default:
      return action;
  }
}

function makeDefaultEntityEvidenceStat(): EntityEvidenceStat {
  return {
    steps: 0,
    uncertainSteps: 0,
    repeatedWorkflowStreak: 0,
    orbitFollowUps: 0,
    recentLowNoveltyCount: 0,
    recentRedundancyWarnings: 0,
  };
}

type FollowUpDecisionSource = "runtime_planner" | "vlm_advisory" | "provider_override" | "anti_repeat";

type FollowUpPlan = {
  followUp?: VlmFollowUp;
  source: FollowUpDecisionSource;
  reason: string;
  evidenceRequirements: EvidenceRequirementsSnapshot;
  suppressedFollowUp?: SuppressedFollowUpTrace;
  finalizationReason?: string;
};

function makeEvidenceRequirementsSnapshot(
  status: EvidenceRequirementsStatus,
  reasons?: EvidenceRequirementReasonMap
): EvidenceRequirementsSnapshot {
  const filteredStatus = Object.fromEntries(
    Object.entries(status).filter(([, value]) => typeof value === "boolean")
  ) as EvidenceRequirementsStatus;
  const filteredReasons = reasons
    ? Object.fromEntries(
        Object.entries(reasons).filter(([, value]) => typeof value === "string" && value.length > 0)
      ) as EvidenceRequirementReasonMap
    : undefined;
  return {
    status: filteredStatus,
    ...(filteredReasons && Object.keys(filteredReasons).length ? { reasons: filteredReasons } : {}),
  };
}

function mergeEvidenceRequirements(
  base: EvidenceRequirementsSnapshot | undefined,
  overlay: EvidenceRequirementsSnapshot | undefined
): EvidenceRequirementsSnapshot | undefined {
  if (!base && !overlay) return undefined;
  return makeEvidenceRequirementsSnapshot(
    {
      ...(base?.status ?? {}),
      ...(overlay?.status ?? {}),
    },
    {
      ...(base?.reasons ?? {}),
      ...(overlay?.reasons ?? {}),
    }
  );
}

function boolFromRequirement(
  value: unknown
): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function summarizeEvidenceRequirementsStatus(status?: EvidenceRequirementsStatus): Record<string, boolean> | undefined {
  const normalized = normalizeEvidenceRequirementsStatusSnapshot(status);
  return Object.keys(normalized).length ? { ...normalized } : undefined;
}

function computeEvidenceRequirementStatusDelta(
  previous: EvidenceRequirementsStatus,
  current: EvidenceRequirementsStatus
): { improved: number; regressed: number } {
  const positiveWhenTrue = new Set([
    "targetVisible",
    "targetFocused",
    "planMeasurementReady",
    "contextViewReady",
  ]);
  const positiveWhenFalse = new Set([
    "obstructionContextNeeded",
    "dimensionReferenceNeeded",
    "regulatoryClauseNeeded",
    "occlusionProblem",
    "lowNoveltyOrRepeatedView",
    "bothSidesOrSurroundingsNeeded",
  ]);
  let improved = 0;
  let regressed = 0;
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})]);
  for (const key of keys) {
    const prev = boolFromRequirement(previous[key as keyof EvidenceRequirementsStatus]);
    const next = boolFromRequirement(current[key as keyof EvidenceRequirementsStatus]);
    if (prev === undefined || next === undefined || prev === next) continue;
    if (positiveWhenTrue.has(key)) {
      if (prev === false && next === true) improved += 1;
      if (prev === true && next === false) regressed += 1;
    } else if (positiveWhenFalse.has(key)) {
      if (prev === true && next === false) improved += 1;
      if (prev === false && next === true) regressed += 1;
    }
  }
  return { improved, regressed };
}

function computeSameEntityRecurrenceMetrics(args: {
  currentStep: number;
  current: SnapshotNoveltyComparable;
  history: EvidenceItem[];
}): Pick<
  SemanticEvidenceProgress,
  | "sameEntityRecurrenceScore"
  | "sameEntityRecurrenceWarning"
  | "sameEntityRecurrenceComparedSnapshotId"
  | "sameEntityRecurrenceStepDelta"
  | "sameEntityRecurrenceViewSimilarity"
  | "sameEntityRecurrenceDecayWeight"
  | "sameEntityRecurrenceFailureWeight"
> {
  const { currentStep, current, history } = args;
  if (!current.activeEntityId) {
    return {
      sameEntityRecurrenceScore: 0,
      sameEntityRecurrenceWarning: false,
    };
  }

  let strongestScore = 0;
  let strongestSnapshotId: string | undefined;
  let strongestStepDelta: number | undefined;
  let strongestSimilarity: number | undefined;
  let strongestDecay: number | undefined;
  let strongestFailureWeight: number | undefined;

  for (const item of history) {
    const previousContext = item.context;
    if (!previousContext?.activeEntityId || previousContext.activeEntityId !== current.activeEntityId) continue;
    if (previousContext.step >= currentStep) continue;

    const previousProgress = previousContext.semanticEvidenceProgress;
    const failureWeight = computeSemanticFailureWeight(previousProgress);
    if (failureWeight <= 0) continue;

    const stepDelta = currentStep - previousContext.step;
    const decayWeight = Number(Math.pow(SAME_ENTITY_RECURRENCE_DECAY, Math.max(0, stepDelta - 1)).toFixed(2));
    const viewSimilarity = computeSameEntityViewSimilarity({
      current,
      previous: {
        snapshotId: item.artifact.id,
        activeEntityId: previousContext.activeEntityId,
        viewPreset: previousContext.viewPreset,
        cameraPose: previousContext.cameraPose ?? item.artifact.meta.camera,
        scope: previousContext.scope,
        highlightedIds: previousContext.highlightedIds,
        planCut: previousContext.planCut,
        nav: item.nav,
      },
    });
    const recurrenceScore = clamp01(Number((decayWeight * viewSimilarity * failureWeight).toFixed(2)));
    if (recurrenceScore <= strongestScore) continue;

    strongestScore = recurrenceScore;
    strongestSnapshotId = item.artifact.id;
    strongestStepDelta = stepDelta;
    strongestSimilarity = viewSimilarity;
    strongestDecay = decayWeight;
    strongestFailureWeight = failureWeight;
  }

  return {
    sameEntityRecurrenceScore: strongestScore,
    sameEntityRecurrenceWarning: strongestScore >= SAME_ENTITY_RECURRENCE_WARNING_THRESHOLD,
    sameEntityRecurrenceComparedSnapshotId: strongestSnapshotId,
    sameEntityRecurrenceStepDelta: strongestStepDelta,
    sameEntityRecurrenceViewSimilarity: strongestSimilarity,
    sameEntityRecurrenceDecayWeight: strongestDecay,
    sameEntityRecurrenceFailureWeight: strongestFailureWeight,
  };
}

function predictComparableStateForFollowUp(args: {
  followUp?: VlmFollowUp;
  context: EvidenceContext;
}): SnapshotNoveltyComparable | undefined {
  const { followUp, context } = args;
  if (!followUp || !context.activeEntityId) return undefined;

  const predicted: SnapshotNoveltyComparable = {
    snapshotId: `predicted_step_${context.step + 1}`,
    activeEntityId: context.activeEntityId,
    viewPreset: context.viewPreset,
    cameraPose: context.cameraPose,
    scope: context.scope,
    highlightedIds: context.highlightedIds,
    planCut: context.planCut,
    nav: undefined,
  };

  switch (followUp.request) {
    case "TOP_VIEW":
      predicted.viewPreset = "top";
      return predicted;
    case "ISO_VIEW":
      predicted.viewPreset = "iso";
      return predicted;
    case "SET_VIEW_PRESET":
      predicted.viewPreset =
        followUp.params.preset === "TOP"
          ? "top"
          : followUp.params.preset === "ISO"
            ? "iso"
            : undefined;
      return predicted;
    case "SET_PLAN_CUT":
      predicted.planCut = {
        enabled: true,
        height: followUp.params.height,
        thickness: followUp.params.thickness,
        mode: followUp.params.mode,
        absoluteHeight: context.planCut?.absoluteHeight,
        source: "predicted",
        storeyId: context.planCut?.storeyId,
      };
      return predicted;
    case "SET_STOREY_PLAN_CUT":
      predicted.planCut = {
        enabled: true,
        mode: followUp.params.mode ?? "WORLD_UP",
        storeyId: followUp.params.storeyId,
        height: followUp.params.offsetFromFloor,
        source: "predicted",
      };
      predicted.scope = { ...(predicted.scope ?? {}), storeyId: followUp.params.storeyId };
      return predicted;
    case "CLEAR_PLAN_CUT":
      predicted.planCut = { enabled: false };
      return predicted;
    case "ISOLATE_STOREY":
      predicted.scope = { storeyId: followUp.params.storeyId };
      return predicted;
    case "ISOLATE_SPACE":
      predicted.scope = { spaceId: followUp.params.spaceId };
      return predicted;
    case "HIGHLIGHT_IDS":
      predicted.highlightedIds = followUp.params.ids;
      return predicted;
    default:
      if (followUp.request === "ORBIT" || followUp.request === "NEW_VIEW") {
        return undefined;
      }
      return predicted;
  }
}

function computeProspectiveSameEntityRecurrenceMetrics(args: {
  followUp?: VlmFollowUp;
  context: EvidenceContext;
  history: EvidenceItem[];
}): Pick<
  SemanticEvidenceProgress,
  | "sameEntityRecurrenceScore"
  | "sameEntityRecurrenceWarning"
  | "sameEntityRecurrenceComparedSnapshotId"
  | "sameEntityRecurrenceStepDelta"
  | "sameEntityRecurrenceViewSimilarity"
  | "sameEntityRecurrenceDecayWeight"
  | "sameEntityRecurrenceFailureWeight"
> | undefined {
  const predicted = predictComparableStateForFollowUp(args);
  if (!predicted) return undefined;
  return computeSameEntityRecurrenceMetrics({
    currentStep: args.context.step + 1,
    current: predicted,
    history: args.history,
  });
}

// Semantic evidence stagnation / anti-cycle logic:
// compare normalized evidence gaps plus requirement-status deltas so visually
// novel snapshots can still be flagged as semantically redundant.
function assessSemanticEvidenceProgress(args: {
  activeEntityId: string;
  tracker?: EntitySemanticEvidenceTracker;
  missingEvidence: string[];
  evidenceRequirementsStatus: EvidenceRequirementsStatus;
  recurrenceMetrics?: Pick<
    SemanticEvidenceProgress,
    | "sameEntityRecurrenceScore"
    | "sameEntityRecurrenceWarning"
    | "sameEntityRecurrenceComparedSnapshotId"
    | "sameEntityRecurrenceStepDelta"
    | "sameEntityRecurrenceViewSimilarity"
    | "sameEntityRecurrenceDecayWeight"
    | "sameEntityRecurrenceFailureWeight"
  >;
}): SemanticEvidenceProgress {
  const {
    activeEntityId,
    tracker,
    missingEvidence,
    evidenceRequirementsStatus,
    recurrenceMetrics,
  } = args;
  const previousGaps = tracker?.previousMissingEvidenceNormalized ?? [];
  const previousStatus = tracker?.previousEvidenceRequirementsStatus ?? {};
  const currentGapSet = new Set(missingEvidence);
  const previousGapSet = new Set(previousGaps);
  const resolvedGapCount = previousGaps.filter((gap) => !currentGapSet.has(gap)).length;
  const newGapCount = missingEvidence.filter((gap) => !previousGapSet.has(gap)).length;
  const unchangedGapCount = missingEvidence.filter((gap) => previousGapSet.has(gap)).length;
  const evidenceGapsChanged =
    !sameStringArray(previousGaps, missingEvidence) ||
    stableJson(normalizeEvidenceRequirementsStatusSnapshot(previousStatus)) !==
      stableJson(normalizeEvidenceRequirementsStatusSnapshot(evidenceRequirementsStatus));
  const statusDelta = computeEvidenceRequirementStatusDelta(previousStatus, evidenceRequirementsStatus);
  const noPreviousState =
    !tracker ||
    (!tracker.previousMissingEvidenceNormalized.length &&
      !Object.keys(tracker.previousEvidenceRequirementsStatus ?? {}).length);

  const repeatedEvidenceGapCount = noPreviousState
    ? (missingEvidence.length ? 1 : 0)
    : unchangedGapCount > 0 &&
        resolvedGapCount === 0 &&
        newGapCount === 0 &&
        statusDelta.improved === 0
      ? Math.max(tracker?.repeatedEvidenceGapCount ?? 1, 1) + 1
      : (missingEvidence.length ? 1 : 0);

  const scoreDenominator =
    resolvedGapCount + unchangedGapCount + newGapCount + statusDelta.improved + statusDelta.regressed;
  const semanticProgressScore = noPreviousState
    ? 1
    : scoreDenominator <= 0
      ? 0
      : clamp01(
          Number(
            (
              (resolvedGapCount + statusDelta.improved * 0.75) /
              Math.max(1, scoreDenominator)
            ).toFixed(2)
          )
        );
  const semanticStagnationWarning = Boolean(
    repeatedEvidenceGapCount >= 2 &&
      semanticProgressScore <= 0.15 &&
      missingEvidence.length > 0
  );
  const summary = noPreviousState
    ? `Baseline evidence state recorded for entity ${activeEntityId}.`
    : `Semantic evidence progress for ${activeEntityId}: resolved=${resolvedGapCount}, new=${newGapCount}, unchanged=${unchangedGapCount}, score=${semanticProgressScore.toFixed(2)}.`;

  return {
    normalizedEvidenceGaps: missingEvidence,
    evidenceGapsChanged,
    resolvedGapCount,
    newGapCount,
    unchangedGapCount,
    semanticProgressScore,
    semanticStagnationWarning,
    sameEntityRecurrenceScore: recurrenceMetrics?.sameEntityRecurrenceScore ?? 0,
    sameEntityRecurrenceWarning: recurrenceMetrics?.sameEntityRecurrenceWarning ?? false,
    sameEntityRecurrenceComparedSnapshotId: recurrenceMetrics?.sameEntityRecurrenceComparedSnapshotId,
    sameEntityRecurrenceStepDelta: recurrenceMetrics?.sameEntityRecurrenceStepDelta,
    sameEntityRecurrenceViewSimilarity: recurrenceMetrics?.sameEntityRecurrenceViewSimilarity,
    sameEntityRecurrenceDecayWeight: recurrenceMetrics?.sameEntityRecurrenceDecayWeight,
    sameEntityRecurrenceFailureWeight: recurrenceMetrics?.sameEntityRecurrenceFailureWeight,
    repeatedEvidenceGapCount,
    previousEvidenceRequirementsStatus: summarizeEvidenceRequirementsStatus(previousStatus),
    currentEvidenceRequirementsStatus: summarizeEvidenceRequirementsStatus(evidenceRequirementsStatus),
    triedActionFamilies: tracker?.triedActionFamilies ?? [],
    triedActionFamilyCounts: tracker?.triedActionFamilyCounts ?? {},
    lastActionFamily: tracker?.lastActionFamily,
    lastEvidenceProgressSummary: summary,
  };
}

function updateSemanticTrackerFromDecision(args: {
  tracker: EntitySemanticEvidenceTracker;
  progress: SemanticEvidenceProgress;
  evidenceRequirementsStatus: EvidenceRequirementsStatus;
}): EntitySemanticEvidenceTracker {
  const { tracker, progress, evidenceRequirementsStatus } = args;
  const nextTracker: EntitySemanticEvidenceTracker = {
    ...tracker,
    previousMissingEvidenceNormalized: [...progress.normalizedEvidenceGaps],
    previousEvidenceRequirementsStatus: normalizeEvidenceRequirementsStatusSnapshot(evidenceRequirementsStatus),
    repeatedEvidenceGapCount: progress.repeatedEvidenceGapCount,
    lastEvidenceProgressSummary: progress.lastEvidenceProgressSummary,
    lastSemanticProgressScore: progress.semanticProgressScore,
  };
  if (tracker.lastActionFamily && progress.semanticProgressScore <= 0.15) {
    nextTracker.stagnatedActionFamilies = Array.from(
      new Set([...(tracker.stagnatedActionFamilies ?? []), tracker.lastActionFamily])
    ).sort() as FollowUpActionFamily[];
  }
  if (tracker.lastActionFamily && progress.semanticProgressScore > 0.15) {
    nextTracker.stagnatedActionFamilies = (tracker.stagnatedActionFamilies ?? []).filter(
      (family) => family !== tracker.lastActionFamily
    );
  }
  nextTracker.triedActionFamilies = summarizeTriedActionFamilies(nextTracker.triedActionFamilyCounts);
  return nextTracker;
}

function recordTriedActionFamily(
  tracker: EntitySemanticEvidenceTracker,
  family?: FollowUpActionFamily
): EntitySemanticEvidenceTracker {
  if (!family) return tracker;
  const count = Number(tracker.triedActionFamilyCounts[family] ?? 0) + 1;
  const triedActionFamilyCounts = {
    ...tracker.triedActionFamilyCounts,
    [family]: count,
  };
  return {
    ...tracker,
    lastActionFamily: family,
    triedActionFamilyCounts,
    triedActionFamilies: summarizeTriedActionFamilies(triedActionFamilyCounts),
  };
}

function buildSemanticStagnationFinalizationReason(progress: SemanticEvidenceProgress): string {
  const gaps = progress.normalizedEvidenceGaps.length
    ? progress.normalizedEvidenceGaps.join(", ")
    : "unresolved evidence";
  return `Multiple navigation strategies were attempted, but the same evidence gaps remained unresolved: ${gaps}. Further visual navigation is unlikely to ground the requirement without measurement/property support.`;
}

function hasConcern(context: EvidenceContext, concern: string): boolean {
  return Boolean(context.taskGraph?.concerns?.includes(concern as any));
}

function deriveRuntimeEvidenceRequirements(args: {
  context: EvidenceContext;
  decision?: VlmDecision;
  nav?: NavMetrics;
  stats?: EntityEvidenceStat;
}): EvidenceRequirementsSnapshot {
  const { context, decision, nav, stats } = args;
  const reasons: EvidenceRequirementReasonMap = {};
  const status: EvidenceRequirementsStatus = {};
  const activeEntityId = context.activeEntityId;
  const highlightIds = context.highlightedIds ?? [];
  const projectedAreaRatio = typeof nav?.projectedAreaRatio === "number" ? nav.projectedAreaRatio : undefined;
  const zoomExhausted = Boolean(nav?.zoomPotentialExhausted);
  const missingEvidence = [
    ...(decision?.missingEvidence ?? []),
    ...(decision?.visibility?.missingEvidence ?? []),
  ]
    .map((item) => String(item).toLowerCase());
  const readiness = (context.highlightAnnotations as any)?.doorClearanceReadiness as
    | {
        measurableLikely?: boolean;
        evidenceBundle?: {
          topMeasurementViewReady?: boolean;
          contextConfirmViewReady?: boolean;
        };
      }
    | undefined;
  const promptGrounding = assessPromptRegulatoryGrounding(decision?.meta?.composedPromptText ?? "");

  const visibleFromDecision = decision?.visibility?.isRuleTargetVisible;
  const visibleFromHighlights = Boolean(activeEntityId && highlightIds.includes(activeEntityId));
  status.targetVisible = visibleFromDecision ?? visibleFromHighlights;
  if (status.targetVisible === false) {
    reasons.targetVisible = "The active target is not yet clearly visible in the current evidence.";
  }

  const targetAreaGoal = nav?.targetAreaGoal ?? HIGHLIGHT_TARGET_AREA_RATIO;
  status.targetFocused = Boolean(
    activeEntityId &&
      highlightIds.includes(activeEntityId) &&
      (
        (typeof projectedAreaRatio === "number" && projectedAreaRatio >= targetAreaGoal * 0.8) ||
        zoomExhausted
      )
  );
  if (status.targetFocused === false && activeEntityId) {
    reasons.targetFocused = "The active target is not yet sufficiently centered or readable.";
  }

  const planMeasurementNeeded =
    Boolean(readiness) ||
    hasConcern(context, "clearance") ||
    hasConcern(context, "dimensions") ||
    hasConcern(context, "landing") ||
    hasConcern(context, "slope") ||
    hasConcern(context, "egress_width") ||
    hasConcern(context, "object_clearance") ||
    hasConcern(context, "accessibility");
  status.planMeasurementNeeded = planMeasurementNeeded;
  status.planMeasurementReady = planMeasurementNeeded
    ? Boolean(
        readiness?.evidenceBundle?.topMeasurementViewReady ||
          readiness?.measurableLikely ||
          (
            context.viewPreset === "top" &&
            (context.planCut?.enabled || !context.floorContext?.missingLikely)
          )
      )
    : false;
  if (planMeasurementNeeded && status.planMeasurementReady === false) {
    reasons.planMeasurementReady = "A decisive plan-oriented measurement view is not ready yet.";
  }

  const contextViewNeeded =
    hasConcern(context, "opening_direction") ||
    hasConcern(context, "hardware_side") ||
    hasConcern(context, "line_of_sight") ||
    hasConcern(context, "headroom") ||
    hasConcern(context, "handrail") ||
    hasConcern(context, "landing") ||
    boolFromRequirement(decision?.evidenceRequirementsStatus?.contextViewNeeded) === true;
  status.contextViewNeeded = contextViewNeeded;
  status.contextViewReady = contextViewNeeded
    ? Boolean(
        readiness?.evidenceBundle?.contextConfirmViewReady ||
          (context.viewPreset && context.viewPreset !== "top" && decision?.visibility?.isRuleTargetVisible)
      )
    : false;
  if (contextViewNeeded && status.contextViewReady === false) {
    reasons.contextViewReady = "A confirming context or side view is still missing.";
  }

  status.obstructionContextNeeded = Boolean(
    hasConcern(context, "clearance") ||
      hasConcern(context, "object_clearance") ||
      missingEvidence.some((item) => item.includes("occl") || item.includes("obstruct") || item.includes("hidden")) ||
      boolFromRequirement(decision?.evidenceRequirementsStatus?.obstructionContextNeeded) === true
  );
  status.occlusionProblem = Boolean(
    decision?.visibility?.occlusionAssessment === "HIGH" ||
      (typeof nav?.occlusionRatio === "number" && nav.occlusionRatio >= 0.45) ||
      context.floorContext?.missingLikely
  );
  if (status.occlusionProblem) {
    reasons.occlusionProblem = "Occlusion or missing floor context is limiting the current evidence.";
  }

  status.dimensionReferenceNeeded = Boolean(
    planMeasurementNeeded ||
      hasConcern(context, "dimensions") ||
      hasConcern(context, "headroom") ||
      boolFromRequirement(decision?.evidenceRequirementsStatus?.dimensionReferenceNeeded) === true
  );

  const modelRequestedRegulatoryClause = boolFromRequirement(
    decision?.evidenceRequirementsStatus?.regulatoryClauseNeeded
  ) === true;
  const textExplicitRegulatoryGap = hasExplicitRegulatoryGapText([
    decision?.rationale,
    ...(decision?.missingEvidence ?? []),
    ...(decision?.visibility?.missingEvidence ?? []),
  ]);
  const customPromptMissingGrounding =
    promptGrounding.promptSource === "custom_user_prompt" &&
    !promptGrounding.hasUsableLocalGrounding &&
    (hasConcern(context, "regulatory_context") ||
      hasConcern(context, "accessibility") ||
      modelRequestedRegulatoryClause ||
      decision?.followUp?.request === "WEB_FETCH");
  const predefinedRuleNeedsSupplementalGrounding =
    promptGrounding.promptSource === "rule_library" &&
    (!promptGrounding.hasUsableLocalGrounding || textExplicitRegulatoryGap);

  // Distinguish rule-library grounding from supplemental clause fetching:
  // predefined rules with usable local criteria are not "missing regulatory
  // context" by default, even when no web evidence has been fetched.
  status.regulatoryClauseNeeded = Boolean(customPromptMissingGrounding || predefinedRuleNeedsSupplementalGrounding);
  if (status.regulatoryClauseNeeded) {
    reasons.regulatoryClauseNeeded =
      promptGrounding.promptSource === "rule_library" && promptGrounding.hasUsableLocalGrounding
        ? "The local ruleLibrary context exists, but an additional clause, threshold, definition, or exception is still missing."
        : "The rule threshold or clause text is still missing or underspecified.";
  }

  status.lowNoveltyOrRepeatedView = Boolean(
    context.snapshotNovelty?.redundancyWarning ||
      (context.snapshotNovelty &&
        context.snapshotNovelty.approximateNoveltyScore <
          getPrototypeRuntimeSettings().snapshotNoveltyRedundancyThreshold) ||
      (stats && stats.repeatedWorkflowStreak >= 2)
  );
  if (status.lowNoveltyOrRepeatedView) {
    reasons.lowNoveltyOrRepeatedView = "Recent evidence changes were low-novelty or repetitive.";
  }

  status.bothSidesOrSurroundingsNeeded = Boolean(
    hasConcern(context, "clearance") ||
      hasConcern(context, "object_clearance") ||
      hasConcern(context, "opening_direction") ||
      boolFromRequirement(decision?.evidenceRequirementsStatus?.bothSidesOrSurroundingsNeeded) === true
  );

  return makeEvidenceRequirementsSnapshot(
    {
      ...status,
      ...(decision?.evidenceRequirementsStatus ?? {}),
    },
    reasons
  );
}

type FollowUpCandidate = {
  followUp?: VlmFollowUp;
  source: FollowUpDecisionSource;
  reason: string;
};

function evaluateSemanticFollowUpCandidate(args: {
  followUp?: VlmFollowUp;
  context: EvidenceContext;
  semanticTracker?: EntitySemanticEvidenceTracker;
  semanticProgress?: SemanticEvidenceProgress;
  sameEntityHistory?: EvidenceItem[];
}): { allowed: boolean; family?: FollowUpActionFamily; suppressionReason?: string } {
  const { followUp, context, semanticTracker, semanticProgress, sameEntityHistory } = args;
  if (!followUp) return { allowed: true };
  const family = classifyFollowUpActionFamily(followUp);
  if (!family || !semanticTracker) return { allowed: true, family };

  const count = Number(semanticTracker.triedActionFamilyCounts[family] ?? 0);
  const maxBudget =
    family === "restore" || family === "reset"
      ? undefined
      : SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS[
          family as keyof typeof SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS
        ];
  const novelty = context.snapshotNovelty;
  const lowVisualNovelty = Boolean(
    novelty &&
      (novelty.redundancyWarning ||
        novelty.approximateNoveltyScore < getPrototypeRuntimeSettings().snapshotNoveltyRedundancyThreshold)
  );
  const lowSemanticProgress = (semanticProgress?.semanticProgressScore ?? 1) <= 0.15;
  const recurrenceWarning = Boolean(semanticProgress?.sameEntityRecurrenceWarning);
  const semanticStagnation = Boolean(
    semanticProgress?.semanticStagnationWarning || semanticTracker.repeatedEvidenceGapCount >= 2
  );
  const prospectiveRecurrence = sameEntityHistory?.length
    ? computeProspectiveSameEntityRecurrenceMetrics({
        followUp,
        context,
        history: sameEntityHistory,
      })
    : undefined;
  const triedFamilyAlready = semanticTracker.triedActionFamilies.includes(family);
  const stagnatedFamilyAlready = semanticTracker.stagnatedActionFamilies.includes(family);
  const viewCycleFamily = family === "plan_measurement" || family === "context_angle";

  if (typeof maxBudget === "number" && count >= maxBudget) {
    return {
      allowed: false,
      family,
      suppressionReason: `Action family ${family} reached its per-entity budget (${count}/${maxBudget}).`,
    };
  }

  if (semanticStagnation && stagnatedFamilyAlready) {
    return {
      allowed: false,
      family,
      suppressionReason: `Action family ${family} already failed to reduce the same evidence gaps for this entity.`,
    };
  }

  if (semanticStagnation && viewCycleFamily && triedFamilyAlready) {
    return {
      allowed: false,
      family,
      suppressionReason: `Semantic stagnation blocked another ${family} step because repeated view-family cycling did not reduce the missing evidence gaps.`,
    };
  }

  if (recurrenceWarning && lowSemanticProgress && viewCycleFamily && triedFamilyAlready) {
    return {
      allowed: false,
      family,
      suppressionReason:
        `Same-entity recurrence score ${(semanticProgress?.sameEntityRecurrenceScore ?? 0).toFixed(2)} ` +
        `blocked another ${family} step because the current view state closely matches a recent semantically unproductive state.`,
    };
  }

  if (
    prospectiveRecurrence?.sameEntityRecurrenceWarning &&
    lowSemanticProgress &&
    viewCycleFamily &&
    triedFamilyAlready
  ) {
    return {
      allowed: false,
      family,
      suppressionReason:
        `Projected same-entity recurrence score ${(prospectiveRecurrence.sameEntityRecurrenceScore ?? 0).toFixed(2)} ` +
        `blocked ${followUp.request} before execution because it would recreate a recent semantically unproductive view state ` +
        `${prospectiveRecurrence.sameEntityRecurrenceComparedSnapshotId ? `from ${prospectiveRecurrence.sameEntityRecurrenceComparedSnapshotId}` : ""}.`,
    };
  }

  if (lowVisualNovelty && lowSemanticProgress && semanticTracker.lastActionFamily === family) {
    return {
      allowed: false,
      family,
      suppressionReason: `Low visual novelty and low semantic progress suppressed another ${family} step for the current entity.`,
    };
  }

  return { allowed: true, family };
}

function pushUniqueFollowUpCandidate(
  candidates: FollowUpCandidate[],
  candidate: FollowUpCandidate | undefined
) {
  if (!candidate) return;
  const serializeFollowUp = (followUp?: VlmFollowUp) =>
    followUp ? `${followUp.request}|${stableJson((followUp as any).params ?? null)}` : "none";
  const key = serializeFollowUp(candidate.followUp);
  const exists = candidates.some((entry) => serializeFollowUp(entry.followUp) === key);
  if (!exists) candidates.push(candidate);
}

function buildEvidenceRequirementFollowUpCandidates(args: {
  decision: VlmDecision;
  context: EvidenceContext;
  lastViewPreset: StartPosePreset | null;
  nav?: NavMetrics;
  evidenceRequirements: EvidenceRequirementsSnapshot;
}): FollowUpCandidate[] {
  const { decision, context, lastViewPreset, nav, evidenceRequirements } = args;
  const advisory = decision.followUp;
  const targetClass = context.taskGraph?.activeEntity?.class ?? context.taskGraph?.primaryClass;
  const activeEntityId = context.activeEntityId ?? context.taskGraph?.activeEntity?.id;
  const activeStoreyId = context.scope?.storeyId ?? context.planCut?.storeyId ?? context.taskGraph?.activeStoreyId;
  const status = evidenceRequirements.status;
  const followUpSourceFromDecision = decision.meta?.followUpSource;
  const orbitAvailable =
    Number(context.followUpBudget?.orbitRemainingForActiveEntity ?? 0) > 0;
  const canZoom = !nav?.zoomPotentialExhausted;
  const candidates: FollowUpCandidate[] = [];

  if (status.regulatoryClauseNeeded && advisory?.request === "WEB_FETCH") {
    pushUniqueFollowUpCandidate(candidates, {
      followUp: advisory,
      source: followUpSourceFromDecision === "provider_override" ? "provider_override" : "vlm_advisory",
      reason: "Supplemental regulatory clause text is still missing, so the advisory web fetch is retained.",
    });
  }

  if (status.targetVisible === false) {
    if (activeStoreyId && context.scope?.storeyId !== activeStoreyId) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "ISOLATE_STOREY", params: { storeyId: activeStoreyId } },
        source: "runtime_planner",
        reason: "The target is not yet visible, so the runtime narrows the scope to the active storey.",
      });
    }
    if (targetClass && !context.isolatedCategories?.some((cat) => cat.toLowerCase() === targetClass.toLowerCase())) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "ISOLATE_CATEGORY", params: { category: targetClass } },
        source: "runtime_planner",
        reason: "The target is not yet visible, so the runtime narrows the visible category set.",
      });
    }
    if (activeEntityId && !context.highlightedIds?.includes(activeEntityId)) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "HIGHLIGHT_IDS", params: { ids: [activeEntityId], style: "primary" } },
        source: "runtime_planner",
        reason: "The target is not yet clearly visible, so the runtime highlights the active entity.",
      });
    }
  }

  if (status.targetFocused === false && activeEntityId) {
    if (!context.highlightedIds?.includes(activeEntityId)) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "HIGHLIGHT_IDS", params: { ids: [activeEntityId], style: "primary" } },
        source: "runtime_planner",
        reason: "The target is visible but not yet focused, so the runtime highlights the active entity.",
      });
    }
    if (canZoom) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "ZOOM_IN", params: { factor: 1.15 } },
        source: "runtime_planner",
        reason: "The target is visible but not yet readable enough, so the runtime requests a tighter view.",
      });
    }
  }

  if (status.planMeasurementNeeded && status.planMeasurementReady === false) {
    if (lastViewPreset !== "top") {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "TOP_VIEW" },
        source: "runtime_planner",
        reason: "Plan-based measurement evidence is needed but not ready, so the runtime moves to a top view first.",
      });
    }
    if (activeStoreyId && (!context.planCut?.enabled || context.floorContext?.missingLikely)) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: {
          request: "SET_STOREY_PLAN_CUT",
          params: { storeyId: activeStoreyId, offsetFromFloor: 1.2, mode: "WORLD_UP" },
        },
        source: "runtime_planner",
        reason: "Plan-based measurement evidence is needed but local floor context is not ready, so the runtime prepares a storey plan cut.",
      });
    }
    if (!context.planCut?.enabled) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "WORLD_UP" } },
        source: "runtime_planner",
        reason: "Plan-based measurement evidence is needed but not readable yet, so the runtime enables a plan cut.",
      });
    }
  }

  if (status.obstructionContextNeeded && status.occlusionProblem) {
    if (targetClass && (!context.isolatedCategories?.length || !context.isolatedCategories.some((cat) => cat.toLowerCase() === targetClass.toLowerCase()))) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: { request: "ISOLATE_CATEGORY", params: { category: targetClass } },
        source: "runtime_planner",
        reason: "Occlusion is limiting the target evidence, so the runtime narrows visible geometry to the relevant category.",
      });
    }
    if (status.contextViewNeeded && orbitAvailable) {
      pushUniqueFollowUpCandidate(candidates, {
        followUp: {
          request: "ORBIT",
          params: {
            yawDegrees: lastViewPreset === "top" ? 45 : 25,
            pitchDegrees: lastViewPreset === "top" ? -30 : 0,
            reason: "Need a less occluded context confirmation view.",
          },
        },
        source: "runtime_planner",
        reason: "Occlusion is still limiting the evidence, so the runtime asks for a bounded alternate context angle.",
      });
    }
  }

  if (status.contextViewNeeded && status.contextViewReady === false) {
    pushUniqueFollowUpCandidate(candidates, {
      followUp: orbitAvailable
        ? {
            request: "ORBIT",
            params: {
              yawDegrees: lastViewPreset === "top" ? 45 : 25,
              pitchDegrees: lastViewPreset === "top" ? -30 : 0,
              reason: "Need a confirming context view for the active target.",
            },
          }
        : { request: "NEW_VIEW", params: { reason: "Need a different context angle for the active target." } },
      source: "runtime_planner",
      reason: orbitAvailable
        ? "A confirming context view is still missing, so the runtime requests one bounded orbit."
        : "A confirming context view is still missing, so the runtime requests a generic new view.",
    });
  }

  if (advisory) {
    pushUniqueFollowUpCandidate(candidates, {
      followUp: advisory,
      source: followUpSourceFromDecision === "provider_override" ? "provider_override" : "vlm_advisory",
      reason:
        followUpSourceFromDecision === "provider_override"
          ? "No stronger runtime evidence-state action was required, so the provider-level advisory was preserved."
          : "No stronger runtime evidence-state action was required, so the VLM advisory was preserved.",
    });
  }

  if (!candidates.length) {
    candidates.push({
      followUp: undefined,
      source: "vlm_advisory",
      reason: "No decisive additional follow-up was justified by the generalized evidence requirements.",
    });
  }

  return candidates;
}

function chooseFollowUpFromEvidenceRequirements(args: {
  decision: VlmDecision;
  context: EvidenceContext;
  lastViewPreset: StartPosePreset | null;
  nav?: NavMetrics;
  stats?: EntityEvidenceStat;
  evidenceRequirements?: EvidenceRequirementsSnapshot;
  semanticTracker?: EntitySemanticEvidenceTracker;
  semanticProgress?: SemanticEvidenceProgress;
  sameEntityHistory?: EvidenceItem[];
}): FollowUpPlan {
  const { decision, context, lastViewPreset, nav, stats, semanticTracker, semanticProgress, sameEntityHistory } = args;
  const evidenceRequirements =
    args.evidenceRequirements ?? deriveRuntimeEvidenceRequirements({ context, decision, nav, stats });
  const candidates = buildEvidenceRequirementFollowUpCandidates({
    decision,
    context,
    lastViewPreset,
    nav,
    evidenceRequirements,
  });
  let suppressedFollowUp: SuppressedFollowUpTrace | undefined;

  for (const candidate of candidates) {
    const evaluation = evaluateSemanticFollowUpCandidate({
      followUp: candidate.followUp,
      context,
      semanticTracker,
      semanticProgress,
      sameEntityHistory,
    });
    if (evaluation.allowed) {
      return {
        followUp: candidate.followUp,
        source: candidate.source,
        reason: candidate.reason,
        evidenceRequirements,
        suppressedFollowUp,
      };
    }
    if (!suppressedFollowUp && candidate.followUp) {
      suppressedFollowUp = {
        request: candidate.followUp.request,
        family: evaluation.family,
        reason: evaluation.suppressionReason ?? "Suppressed by semantic anti-cycle logic.",
      };
    }
  }

  const finalizationReason =
    (semanticProgress?.semanticStagnationWarning || semanticProgress?.sameEntityRecurrenceWarning) &&
    semanticProgress.normalizedEvidenceGaps.length
      ? buildSemanticStagnationFinalizationReason(semanticProgress)
      : suppressedFollowUp?.reason ??
        "No decisive additional follow-up was justified by the generalized evidence requirements.";

  return {
    followUp: undefined,
    source: "anti_repeat",
    reason: finalizationReason,
    evidenceRequirements,
    suppressedFollowUp,
    finalizationReason,
  };
}

// Paper-inspired but intentionally lightweight thresholds:
// the goal is to reward materially different evidence views while keeping
// repeated same-entity snapshots deterministic and easy to audit.
function computeSnapshotNoveltyMetrics(args: {
  current: SnapshotNoveltyComparable;
  previous?: SnapshotNoveltyComparable;
  previousSameEntity?: SnapshotNoveltyComparable;
}): SnapshotNoveltyMetrics {
  const { current, previous, previousSameEntity } = args;
  const baseline = previousSameEntity ?? previous;
  const sameEntityAsPrevious = Boolean(
    previous?.activeEntityId &&
      current.activeEntityId &&
      previous.activeEntityId === current.activeEntityId
  );

  if (!baseline) {
    return {
      sameEntityAsPrevious,
      viewPresetChanged: true,
      cameraMoved: true,
      yawPitchChanged: true,
      planCutChanged: true,
      highlightedIdsChanged: true,
      scopeChanged: true,
      approximateNoveltyScore: 1,
      redundancyWarning: false,
    };
  }

  const currentViewDistance = distance3d(current.cameraPose.eye, current.cameraPose.target);
  const baselineViewDistance = distance3d(baseline.cameraPose.eye, baseline.cameraPose.target);
  const representativeViewDistance = Math.max(currentViewDistance, baselineViewDistance, 1);
  const cameraMoveThreshold = Math.max(0.35, representativeViewDistance * 0.05);
  const eyeDelta = distance3d(current.cameraPose.eye, baseline.cameraPose.eye);
  const targetDelta = distance3d(current.cameraPose.target, baseline.cameraPose.target);
  const cameraMoved = eyeDelta >= cameraMoveThreshold || targetDelta >= cameraMoveThreshold * 0.5;

  const currentAngles = getYawPitchDegrees(current.cameraPose);
  const baselineAngles = getYawPitchDegrees(baseline.cameraPose);
  const yawDeltaDeg =
    currentAngles && baselineAngles
      ? getSmallestAngleDeltaDegrees(currentAngles.yawDeg, baselineAngles.yawDeg)
      : 0;
  const pitchDeltaDeg =
    currentAngles && baselineAngles
      ? Math.abs(currentAngles.pitchDeg - baselineAngles.pitchDeg)
      : 0;
  const yawPitchChanged = yawDeltaDeg >= 12 || pitchDeltaDeg >= 8;

  const viewPresetChanged = (current.viewPreset ?? null) !== (baseline.viewPreset ?? null);
  const planCutChanged = normalizePlanCutKey(current.planCut) !== normalizePlanCutKey(baseline.planCut);
  const highlightedIdsChanged = !sameStringArray(current.highlightedIds, baseline.highlightedIds);
  const scopeChanged = !sameScope(current.scope, baseline.scope);

  const projectedAreaDelta =
    typeof current.nav?.projectedAreaRatio === "number" && typeof baseline.nav?.projectedAreaRatio === "number"
      ? Math.abs(current.nav.projectedAreaRatio - baseline.nav.projectedAreaRatio)
      : undefined;
  const occlusionDelta =
    typeof current.nav?.occlusionRatio === "number" && typeof baseline.nav?.occlusionRatio === "number"
      ? Math.abs(current.nav.occlusionRatio - baseline.nav.occlusionRatio)
      : undefined;
  const projectedAreaChanged =
    typeof projectedAreaDelta === "number" ? projectedAreaDelta >= 0.05 : undefined;
  const occlusionChanged = typeof occlusionDelta === "number" ? occlusionDelta >= 0.08 : undefined;

  let approximateNoveltyScore = 0;
  if (viewPresetChanged) approximateNoveltyScore += 0.18;
  if (cameraMoved) approximateNoveltyScore += 0.18;
  if (yawPitchChanged) approximateNoveltyScore += 0.18;
  if (planCutChanged) approximateNoveltyScore += 0.16;
  if (highlightedIdsChanged) approximateNoveltyScore += 0.1;
  if (scopeChanged) approximateNoveltyScore += 0.1;
  if (projectedAreaChanged) approximateNoveltyScore += 0.06;
  if (occlusionChanged) approximateNoveltyScore += 0.04;
  if (baseline === previousSameEntity && current.activeEntityId && baseline.activeEntityId === current.activeEntityId) {
    approximateNoveltyScore += 0.04;
  }

  approximateNoveltyScore = clamp01(Number(approximateNoveltyScore.toFixed(2)));

  const redundancyWarning = Boolean(
    baseline.activeEntityId &&
      current.activeEntityId &&
      baseline.activeEntityId === current.activeEntityId &&
      approximateNoveltyScore <= getPrototypeRuntimeSettings().snapshotNoveltyRedundancyThreshold
  );

  return {
    comparedToSnapshotId: baseline.snapshotId,
    comparedEntityId: baseline.activeEntityId,
    sameEntityAsPrevious,
    viewPresetChanged,
    cameraMoved,
    yawPitchChanged,
    planCutChanged,
    highlightedIdsChanged,
    scopeChanged,
    projectedAreaChanged,
    occlusionChanged,
    approximateNoveltyScore,
    redundancyWarning,
  };
}

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
  shouldStop?: () => "continue" | "stop" | "skip";
  onStep?: (step: number, decision: VlmDecision) => void;  // live progress callback
  onProgress?: (update: {
    stage: "starting" | "seeded" | "captured" | "decision" | "followup" | "finished";
    step: number;
    summary: string;
    taskGraph?: CompactTaskGraphState;
    lastActionReason?: string | null;
    verdict?: VlmDecision["verdict"];
    confidence?: number;
    thinking?: string;
    followUpSummary?: string;
  }) => void;
};

export function createComplianceRunner(params: {
  viewerApi: {
    hasModelLoaded: () => boolean;
    resetVisibility: () => Promise<void>;
    isolate?: (map: Record<string, Set<number>>) => Promise<void>;
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
    getProperties?: (objectId: string) => Promise<Record<string, unknown> | null>;
    getRendererDomElement?: () => HTMLCanvasElement;

    highlightIds?: (ids: string[], style?: "primary" | "warn") => Promise<void>;
    getCurrentIsolateSelection?: () => Record<string, Set<number>> | null;
    getDoorClearanceFocusBox?: (ids?: string[]) => Promise<any>;
    listCategoryObjectIds?: (category: string, limit?: number) => Promise<string[]>;
    hideSelected?: () => Promise<void>;
    getSelectionWorldBox?: (map: any) => Promise<any>;

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
    measureSelection?: (map: any, opts?: any) => Promise<{
      targetAreaRatio: number;
      occlusionRatio: number | null;
      steps: number;
      success: boolean;
      reason: string;
    }>;
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
  let navigationActionLog: NavigationAction[] = [];
  let entityEvidenceStats = new Map<string, EntityEvidenceStat>();
  let entitySemanticTrackers = new Map<string, EntitySemanticEvidenceTracker>();

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

function clonePlanCutState(planCut: PlanCutStateTrace | undefined): PlanCutStateTrace | undefined {
  return planCut ? { ...planCut } : undefined;
}

function toPlanCutTrace(planCut: any): PlanCutStateTrace | undefined {
  if (!planCut || typeof planCut !== "object") return undefined;
  return {
    enabled: typeof planCut.enabled === "boolean" ? planCut.enabled : undefined,
    height: typeof planCut.height === "number" ? planCut.height : undefined,
    absoluteHeight: typeof planCut.absoluteHeight === "number" ? planCut.absoluteHeight : undefined,
    thickness: typeof planCut.thickness === "number" ? planCut.thickness : undefined,
    mode: typeof planCut.mode === "string" ? planCut.mode : undefined,
    source: typeof planCut.source === "string" ? planCut.source : undefined,
    storeyId: typeof planCut.storeyId === "string" ? planCut.storeyId : undefined,
  };
}

async function captureNavigationStateTrace(): Promise<NavigationStateTrace> {
  const pose = await viewerApi.getCameraPose();
  const planCut = (viewerApi as any).getPlanCutState ? await (viewerApi as any).getPlanCutState() : undefined;
  return {
    cameraPose: pose
      ? {
          eye: { ...pose.eye },
          target: { ...pose.target },
        }
      : undefined,
    highlightedIds: [...lastHighlightedIds],
    planCut: toPlanCutTrace(planCut),
  };
}

function cloneNavigationStateTrace(
  state: NavigationStateTrace | undefined
): NavigationStateTrace | undefined {
  if (!state) return undefined;
  return {
    cameraPose: state.cameraPose
      ? {
          eye: { ...state.cameraPose.eye },
          target: { ...state.cameraPose.target },
        }
      : undefined,
    highlightedIds: [...(state.highlightedIds ?? [])],
    planCut: clonePlanCutState(state.planCut),
  };
}

async function recordNavigationControlEvent(args: {
  step: number;
  requestedFollowUp?: VlmFollowUp;
  executedFollowUp?: VlmFollowUp;
  activeEntityId?: string;
  activeStoreyId?: string;
  note: string;
  evidenceRequirementsBeforeAction?: EvidenceRequirementsSnapshot;
  decisionSource?: FollowUpDecisionSource;
  snapshotNoveltyBeforeAction?: SnapshotNoveltyMetrics;
  semanticEvidenceProgress?: SemanticEvidenceProgress;
  suppressedFollowUp?: SuppressedFollowUpTrace;
  finalizationReason?: string;
}) {
  const {
    step,
    requestedFollowUp,
    executedFollowUp,
    activeEntityId,
    activeStoreyId,
    note,
    evidenceRequirementsBeforeAction,
    decisionSource,
    snapshotNoveltyBeforeAction,
    semanticEvidenceProgress,
    suppressedFollowUp,
    finalizationReason,
  } = args;
  const state = await captureNavigationStateTrace();
  const actionFamily = classifyFollowUpActionFamily(executedFollowUp ?? requestedFollowUp);
  navigationActionLog.push({
    step,
    action: executedFollowUp?.request ?? requestedFollowUp?.request ?? "NEW_VIEW",
    requestedAction: requestedFollowUp?.request,
    activeEntityId,
    activeStoreyId,
    params: ((executedFollowUp as any)?.params ?? undefined) as Record<string, unknown> | undefined,
    requestedParams: ((requestedFollowUp as any)?.params ?? undefined) as Record<string, unknown> | undefined,
    reason: note,
    timestamp: new Date().toISOString(),
    success: false,
    noOpReason: note,
    beforeState: cloneNavigationStateTrace(state),
    afterState: cloneNavigationStateTrace(state),
    evidenceRequirementsBeforeAction,
    chosenFollowUp: executedFollowUp
      ? {
          request: executedFollowUp.request,
          params: ((executedFollowUp as any)?.params ?? undefined) as Record<string, unknown> | undefined,
        }
      : undefined,
    decisionSource,
    decisionReason: note,
    evaluationSummary: note,
    snapshotNoveltyBeforeAction,
    semanticEvidenceProgress,
    actionFamily,
    suppressedFollowUp: cloneSuppressedFollowUp(suppressedFollowUp),
    finalizationReason,
  });
}

function summarizeNavigationEvaluation(args: {
  requestedAction?: VlmFollowUp["request"];
  executedAction?: VlmFollowUp["request"];
  activeEntityId?: string;
  activeStoreyId?: string;
  success: boolean;
  reason?: string;
  nav?: NavMetrics;
  beforeState?: NavigationStateTrace;
  afterState?: NavigationStateTrace;
  controlNote?: string;
  evidenceRequirementsBeforeAction?: EvidenceRequirementsSnapshot;
  decisionSource?: FollowUpDecisionSource;
  decisionReason?: string;
  snapshotNoveltyBeforeAction?: SnapshotNoveltyMetrics;
  semanticEvidenceProgress?: SemanticEvidenceProgress;
  suppressedFollowUp?: SuppressedFollowUpTrace;
}) {
  const {
    requestedAction,
    executedAction,
    activeEntityId,
    activeStoreyId,
    success,
    reason,
    nav,
    beforeState,
    afterState,
    controlNote,
    evidenceRequirementsBeforeAction,
    decisionSource,
    decisionReason,
    snapshotNoveltyBeforeAction,
    semanticEvidenceProgress,
    suppressedFollowUp,
  } = args;
  const scope = activeEntityId
    ? `entity ${activeEntityId}`
    : activeStoreyId
      ? `storey ${activeStoreyId}`
      : "current scope";
  const normalized = requestedAction && executedAction && requestedAction !== executedAction
    ? `normalized ${requestedAction} to ${executedAction}`
    : `executed ${executedAction ?? requestedAction ?? "no-followup"}`;
  const areaRatio = typeof nav?.projectedAreaRatio === "number" ? nav.projectedAreaRatio.toFixed(3) : null;
  const occlusion = typeof nav?.occlusionRatio === "number" ? nav.occlusionRatio.toFixed(3) : null;
  const beforeHighlights = beforeState?.highlightedIds?.length ?? 0;
  const afterHighlights = afterState?.highlightedIds?.length ?? 0;
  const beforePlanCut = beforeState?.planCut?.enabled ? "on" : "off";
  const afterPlanCut = afterState?.planCut?.enabled ? "on" : "off";
  const evidenceSummary = evidenceRequirementsBeforeAction
    ? Object.entries(evidenceRequirementsBeforeAction.status)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
        .join(", ")
    : "";
  return [
    `${scope}: ${normalized}.`,
    success ? "Outcome: success." : `Outcome: no-op${reason ? ` (${reason})` : ""}.`,
    `Highlights ${beforeHighlights}->${afterHighlights}; plan cut ${beforePlanCut}->${afterPlanCut}.`,
    areaRatio ? `Target area ${areaRatio}.` : "",
    occlusion ? `Occlusion ${occlusion}.` : "",
    decisionSource ? `Decision source: ${decisionSource}.` : "",
    decisionReason ? `Decision reason: ${decisionReason}` : "",
    evidenceSummary ? `Evidence requirements before action: ${evidenceSummary}.` : "",
    snapshotNoveltyBeforeAction
      ? `Visual novelty ${snapshotNoveltyBeforeAction.approximateNoveltyScore.toFixed(2)}${snapshotNoveltyBeforeAction.redundancyWarning ? " (redundant)" : ""}.`
      : "",
    semanticEvidenceProgress
      ? `Semantic progress ${semanticEvidenceProgress.semanticProgressScore.toFixed(2)}; unchanged gaps ${semanticEvidenceProgress.unchangedGapCount}.`
      : "",
    semanticEvidenceProgress?.sameEntityRecurrenceScore
      ? `Same-entity recurrence ${semanticEvidenceProgress.sameEntityRecurrenceScore.toFixed(2)}${semanticEvidenceProgress.sameEntityRecurrenceComparedSnapshotId ? ` vs ${semanticEvidenceProgress.sameEntityRecurrenceComparedSnapshotId}` : ""}.`
      : "",
    suppressedFollowUp ? `Suppressed follow-up: ${suppressedFollowUp.request}.` : "",
    nav?.zoomPotentialExhausted ? "Zoom exhausted." : "",
    controlNote ? `Control: ${controlNote}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Paper-inspired deterministic ReAct-style navigation evaluation:
// every executed follow-up gets a before/after viewer-state audit record
// without issuing an additional VLM call.
async function executeFollowUpWithEvaluation(params: {
  step: number;
  requestedFollowUp: VlmFollowUp | undefined;
  executedFollowUp: VlmFollowUp | undefined;
  previousActionReason?: string | null;
  previousNav?: NavMetrics;
  controlNote?: string;
  evidenceRequirementsBeforeAction?: EvidenceRequirementsSnapshot;
  decisionSource?: FollowUpDecisionSource;
  decisionReason?: string;
  snapshotNoveltyBeforeAction?: SnapshotNoveltyMetrics;
  semanticEvidenceProgress?: SemanticEvidenceProgress;
  suppressedFollowUp?: SuppressedFollowUpTrace;
}) {
  const {
    step,
    requestedFollowUp,
    executedFollowUp,
    previousActionReason,
    previousNav,
    controlNote,
    evidenceRequirementsBeforeAction,
    decisionSource,
    decisionReason,
    snapshotNoveltyBeforeAction,
    semanticEvidenceProgress,
    suppressedFollowUp,
  } = params;
  const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
  const beforeState = await captureNavigationStateTrace();
  const activeEntityId = focus?.activeEntityId ?? lastSelectedId ?? beforeState.highlightedIds?.[0];
  const activeStoreyId =
    lastScope.storeyId ??
    beforeState.planCut?.storeyId ??
    focus?.activeStoreyId ??
    undefined;
  const actionFamily = classifyFollowUpActionFamily(executedFollowUp ?? requestedFollowUp);
  const acted = await executeFollowUp(executedFollowUp, previousActionReason, previousNav);
  const afterState = await captureNavigationStateTrace();
  const nav = (acted as any).nav as NavMetrics | undefined;
  navigationActionLog.push({
    step,
    action: executedFollowUp?.request ?? requestedFollowUp?.request ?? "NEW_VIEW",
    requestedAction: requestedFollowUp?.request,
    activeEntityId,
    activeStoreyId,
    params: ((executedFollowUp as any)?.params ?? undefined) as Record<string, unknown> | undefined,
    requestedParams: ((requestedFollowUp as any)?.params ?? undefined) as Record<string, unknown> | undefined,
    reason: acted.reason,
    timestamp: new Date().toISOString(),
    success: acted.didSomething,
    noOpReason: acted.didSomething ? undefined : acted.reason,
    beforeState: {
      cameraPose: beforeState.cameraPose
        ? { eye: { ...beforeState.cameraPose.eye }, target: { ...beforeState.cameraPose.target } }
        : undefined,
      highlightedIds: [...(beforeState.highlightedIds ?? [])],
      planCut: clonePlanCutState(beforeState.planCut),
    },
    afterState: {
      cameraPose: afterState.cameraPose
        ? { eye: { ...afterState.cameraPose.eye }, target: { ...afterState.cameraPose.target } }
        : undefined,
      highlightedIds: [...(afterState.highlightedIds ?? [])],
      planCut: clonePlanCutState(afterState.planCut),
    },
    navigationMetrics: nav
      ? {
          targetAreaRatio: nav.projectedAreaRatio,
          projectedAreaRatio: nav.projectedAreaRatio,
          occlusionRatio: nav.occlusionRatio,
          convergenceScore: nav.convergenceScore,
          targetAreaGoal: nav.targetAreaGoal,
          zoomExhausted: nav.zoomPotentialExhausted,
          success: nav.success,
          reason: nav.reason,
        }
      : undefined,
    evidenceRequirementsBeforeAction,
    chosenFollowUp: executedFollowUp
      ? {
          request: executedFollowUp.request,
          params: ((executedFollowUp as any)?.params ?? undefined) as Record<string, unknown> | undefined,
        }
      : undefined,
    decisionSource,
    decisionReason,
    evaluationSummary: summarizeNavigationEvaluation({
      requestedAction: requestedFollowUp?.request,
      executedAction: executedFollowUp?.request,
      activeEntityId,
      activeStoreyId,
      success: acted.didSomething,
      reason: acted.reason,
      nav,
      beforeState,
      afterState,
      controlNote,
      evidenceRequirementsBeforeAction,
      decisionSource,
      decisionReason,
      snapshotNoveltyBeforeAction,
      semanticEvidenceProgress,
      suppressedFollowUp,
    }),
    error: acted.didSomething ? undefined : acted.reason,
    snapshotNoveltyBeforeAction,
    semanticEvidenceProgress,
    actionFamily,
    suppressedFollowUp: cloneSuppressedFollowUp(suppressedFollowUp),
  });
  if (activeEntityId && executedFollowUp && actionFamily) {
    const tracker =
      entitySemanticTrackers.get(activeEntityId) ?? makeDefaultSemanticTracker(activeEntityId);
    entitySemanticTrackers.set(activeEntityId, recordTriedActionFamily(tracker, actionFamily));
  }
  return acted;
}

async function createNavigationBookmark(step: number, label: string, action: string): Promise<NavigationBookmark> {
  const pose = await viewerApi.getCameraPose();
  const planCut = (viewerApi as any).getPlanCutState ? await (viewerApi as any).getPlanCutState() : undefined;
  const isolatedIds = flattenModelIdMap(viewerApi.getCurrentIsolateSelection?.() ?? null);
  return {
    id: crypto.randomUUID(),
    step,
    label,
    action,
    viewPreset: lastViewPreset ?? undefined,
    cameraPose: pose,
    scope: lastScope.storeyId || lastScope.spaceId ? { ...lastScope } : undefined,
    isolatedIds,
    isolatedCategories: isolatedIds.length ? [...lastIsolatedCategories] : [],
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

async function reapplyPersistentHighlight(style: "primary" | "warn" = "primary") {
  if (!lastHighlightedIds.length || !viewerApi.highlightIds) return;
  await viewerApi.highlightIds(lastHighlightedIds, style);
}

async function rememberPersistentHighlight(ids: string[], style: "primary" | "warn" = "primary") {
  if (!ids.length || !viewerApi.highlightIds) return;
  const nextFocusIds = Array.from(new Set(ids.filter(Boolean)));
  lastHighlightedIds = nextFocusIds;
  lastSelectedId = nextFocusIds[0] ?? lastSelectedId ?? null;
  await viewerApi.highlightIds(lastHighlightedIds, style);
}

function getActiveHighlightFocusIds(): string[] {
  if (lastSelectedId && lastHighlightedIds.includes(lastSelectedId)) return [lastSelectedId];
  return lastHighlightedIds.slice(0, 1);
}

async function activateEntityFocus(
  entityId: string,
  opts?: {
    previousEntityId?: string | null;
    reasonPrefix?: string;
    highlightIds?: string[];
  }
) {
  if (!entityId || !viewerApi.highlightIds) return undefined;
  const switchingEntity = Boolean(opts?.previousEntityId && opts.previousEntityId !== entityId);
  const firstActivation = !lastSelectedId && !lastHighlightedIds.length;
  const needsHardwiredCenter =
    firstActivation ||
    switchingEntity ||
    lastSelectedId !== entityId ||
    !lastHighlightedIds.includes(entityId);

  await rememberPersistentHighlight(opts?.highlightIds?.length ? opts.highlightIds : [entityId], "primary");
  lastSelectedId = entityId;

  if (!needsHardwiredCenter) return undefined;

  const currentPose = await viewerApi.getCameraPose();
  const map = buildModelIdMapFromObjectIds([entityId]);
  if (!Object.keys(map).length) return undefined;
  const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
  const activeClass =
    (focus?.activeEntityId ? currentTaskGraph?.entities.byId[focus.activeEntityId]?.entityClass : undefined) ??
    currentTaskGraph?.intent.primaryClass;
  const isDoorTarget = typeof activeClass === "string" && activeClass.toUpperCase().includes("IFCDOOR");
  const focusBox = isDoorTarget && viewerApi.getDoorClearanceFocusBox
    ? await viewerApi.getDoorClearanceFocusBox([entityId])
    : await viewerApi.getSelectionWorldBox?.(map as any);
  if (
    !focusBox ||
    typeof focusBox !== "object" ||
    focusBox.isEmpty?.() ||
    !focusBox.min ||
    !focusBox.max
  ) {
    return undefined;
  }
  const center = {
    x: (focusBox.min.x + focusBox.max.x) / 2,
    y: (focusBox.min.y + focusBox.max.y) / 2,
    z: (focusBox.min.z + focusBox.max.z) / 2,
  };
  const delta = {
    x: center.x - currentPose.target.x,
    y: center.y - currentPose.target.y,
    z: center.z - currentPose.target.z,
  };
  const almostZero =
    Math.abs(delta.x) < 1e-6 &&
    Math.abs(delta.y) < 1e-6 &&
    Math.abs(delta.z) < 1e-6;
  if (!almostZero) {
    await viewerApi.setCameraPose(
      {
        eye: {
          x: currentPose.eye.x + delta.x,
          y: currentPose.eye.y + delta.y,
          z: currentPose.eye.z + delta.z,
        },
        target: { x: center.x, y: center.y, z: center.z },
      },
      true
    );
  }
  return {
    convergenceScore: 1,
    success: true,
    reason: `${opts?.reasonPrefix ?? (switchingEntity ? "entity-transition" : "entity-focus")}:center-only`,
    zoomPotentialExhausted: false,
  } satisfies NavMetrics;
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
        Boolean(bookmark.planCut?.enabled) &&
        bookmark.isolatedIds.length === 0 &&
        bookmark.hiddenIds.length === 0
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

  const isScopedStoreyPlanCutBookmark = Boolean(
    target.planCut?.enabled &&
      target.scope?.storeyId &&
      target.planCut.storeyId === target.scope.storeyId &&
      target.isolatedIds.length === 0
  );

  await viewerApi.resetVisibility();

  if (target.isolatedIds.length && viewerApi.isolate) {
    const isolateMap = buildModelIdMapFromObjectIds(target.isolatedIds);
    if (Object.keys(isolateMap).length) {
      await viewerApi.isolate(isolateMap);
    }
    if (target.scope?.storeyId) {
      lastScope = { storeyId: target.scope.storeyId };
    } else if (target.scope?.spaceId) {
      lastScope = { spaceId: target.scope.spaceId };
    } else {
      lastScope = {};
    }
  } else if (target.planCut?.enabled && target.scope?.storeyId) {
    lastScope = { storeyId: target.scope.storeyId };
  } else if (target.scope?.storeyId && viewerApi.isolateStorey) {
    await viewerApi.isolateStorey(target.scope.storeyId);
    lastScope = { storeyId: target.scope.storeyId };
  } else if (target.scope?.spaceId && viewerApi.isolateSpace) {
    await viewerApi.isolateSpace(target.scope.spaceId);
    lastScope = { spaceId: target.scope.spaceId };
  } else {
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

  if (!isScopedStoreyPlanCutBookmark && target.hiddenIds.length && viewerApi.hideIds) {
    await viewerApi.hideIds(target.hiddenIds);
  }

  if (target.highlightedIds.length && viewerApi.highlightIds) {
    await rememberPersistentHighlight(target.highlightedIds, "primary");
    lastSelectedId = target.selectedId ?? target.highlightedIds[0] ?? lastSelectedId;
  } else if (lastHighlightedIds.length) {
    await reapplyPersistentHighlight();
  }

  lastHiddenIds = isScopedStoreyPlanCutBookmark ? [] : [...target.hiddenIds];
  lastIsolatedCategories = isScopedStoreyPlanCutBookmark ? [] : [...target.isolatedCategories];
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

  await activateEntityFocus(nextFocus.activeEntityId, {
    previousEntityId: fromEntityId,
    reasonPrefix: "entity-transition",
  });

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

function clampOrbitDegrees(value: unknown, fallback: number): number {
  const raw = typeof value === "number" && isFinite(value) ? value : fallback;
  return Math.max(-MAX_ORBIT_DEGREES_PER_AXIS, Math.min(MAX_ORBIT_DEGREES_PER_AXIS, raw));
}

function normalizeOrbitParams(params: Extract<VlmFollowUp, { request: "ORBIT" }>["params"] | undefined, topLike: boolean) {
  const fallbackYaw = topLike ? 45 : 20;
  const fallbackPitch = topLike ? -30 : 0;
  const yawSource = params?.yawDegrees ?? params?.degrees;
  const pitchSource = params?.pitchDegrees;
  return {
    yawDegrees: clampOrbitDegrees(yawSource, fallbackYaw),
    pitchDegrees: clampOrbitDegrees(pitchSource, fallbackPitch),
  };
}

function buildOrbitPose(current: CameraPose, yawDegrees: number, pitchDegrees: number): CameraPose {
  const tx = current.target.x;
  const ty = current.target.y;
  const tz = current.target.z;
  const vx = current.eye.x - tx;
  const vy = current.eye.y - ty;
  const vz = current.eye.z - tz;
  const radius = Math.hypot(vx, vy, vz);

  if (!Number.isFinite(radius) || radius <= 1e-6) return current;

  const horizontal = Math.hypot(vx, vz);
  const yaw = horizontal > 1e-6 ? Math.atan2(vz, vx) : Math.PI / 4;
  const elevation = Math.asin(Math.max(-1, Math.min(1, vy / radius)));
  // Keep the orbit camera at or above the target level so confirmation views
  // never end up looking from underneath the inspected object.
  const minElevation = 0;
  const maxElevation = (89 * Math.PI) / 180;
  const nextYaw = yaw + (yawDegrees * Math.PI) / 180;
  const nextElevation = Math.max(
    minElevation,
    Math.min(maxElevation, elevation + (pitchDegrees * Math.PI) / 180)
  );
  const nextHorizontal = radius * Math.cos(nextElevation);

  return {
    eye: {
      x: tx + nextHorizontal * Math.cos(nextYaw),
      y: ty + radius * Math.sin(nextElevation),
      z: tz + nextHorizontal * Math.sin(nextYaw),
    },
    target: current.target,
  };
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
    case "ZOOM_IN":
    case "NEW_VIEW":
      return { request: "ORBIT", params: { yawDegrees: 20, pitchDegrees: 0, reason: "Repeated view/zoom follow-up; gather a bounded alternate angle." } };
    default:
      return { request: "NEW_VIEW", params: { reason: "Repeated followUp; changing view to gather new evidence." } };
  }
}

function getLatestSuccessfulActionForEntity(entityId?: string): VlmFollowUp["request"] | undefined {
  if (!entityId) return undefined;
  const entry = [...navigationActionLog]
    .reverse()
    .find((item) => item.activeEntityId === entityId && item.success);
  return entry?.action;
}

function chooseLowNoveltyAlternative(args: {
  requestedFollowUp: VlmFollowUp | undefined;
  context: EvidenceContext;
  lastViewPreset: StartPosePreset | null;
  stats: EntityEvidenceStat;
}): VlmFollowUp | undefined {
  const { requestedFollowUp, context, lastViewPreset, stats } = args;
  if (!requestedFollowUp) return undefined;

  const storeyId = context.scope?.storeyId ?? context.planCut?.storeyId ?? context.taskGraph?.activeStoreyId;
  const planCutMissing = !context.planCut?.enabled || context.floorContext?.missingLikely;
  const orbitAvailable = stats.orbitFollowUps < MAX_ORBIT_FOLLOW_UPS_PER_ENTITY;

  switch (requestedFollowUp.request) {
    case "ZOOM_IN":
      if (orbitAvailable) {
        return {
          request: "ORBIT",
          params: {
            yawDegrees: lastViewPreset === "top" ? 45 : 20,
            pitchDegrees: lastViewPreset === "top" ? -30 : 0,
            reason: "Low novelty after zoom; try a bounded alternate angle.",
          },
        };
      }
      if (lastViewPreset !== "top") return { request: "TOP_VIEW" };
      if (planCutMissing && storeyId) {
        return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
      }
      return undefined;
    case "ORBIT":
    case "NEW_VIEW":
    case "ISO_VIEW":
      if (lastViewPreset !== "top") return { request: "TOP_VIEW" };
      if (planCutMissing && storeyId) {
        return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
      }
      if (!context.planCut?.enabled) {
        return { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "WORLD_UP" } };
      }
      return undefined;
    case "TOP_VIEW":
      if (planCutMissing && storeyId) {
        return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
      }
      if (!context.planCut?.enabled) {
        return { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "WORLD_UP" } };
      }
      return orbitAvailable
        ? {
            request: "ORBIT",
            params: { yawDegrees: 25, pitchDegrees: 0, reason: "Low novelty after top view; gather side confirmation." },
          }
        : undefined;
    case "SET_VIEW_PRESET":
      if (requestedFollowUp.params.preset === "TOP") {
        if (planCutMissing && storeyId) {
          return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
        }
        if (!context.planCut?.enabled) {
          return { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "WORLD_UP" } };
        }
      }
      return undefined;
    case "ISOLATE_CATEGORY":
    case "HIDE_CATEGORY":
    case "ISOLATE_STOREY":
    case "ISOLATE_SPACE":
    case "HIDE_SELECTED":
    case "RESET_VISIBILITY":
    case "HIDE_IDS":
      if (lastViewPreset !== "top") return { request: "TOP_VIEW" };
      if (planCutMissing && storeyId) {
        return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
      }
      return undefined;
    case "SET_PLAN_CUT":
      if (storeyId) {
        return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
      }
      return lastViewPreset !== "top" ? { request: "TOP_VIEW" } : undefined;
    default:
      if (lastViewPreset !== "top") return { request: "TOP_VIEW" };
      if (planCutMissing && storeyId) {
        return { request: "SET_STOREY_PLAN_CUT", params: { storeyId, mode: "WORLD_UP" } };
      }
      return undefined;
  }
}

// Paper-inspired low-novelty anti-repeat logic:
// if a same-entity snapshot fails to add useful visual evidence, avoid spending
// more of the view budget on the same navigation pattern.
async function applyLowNoveltyFollowUpGuard(args: {
  step: number;
  decision: VlmDecision;
  context: EvidenceContext;
  activeEntityId?: string;
  activeStoreyId?: string;
  stats?: EntityEvidenceStat;
  lastViewPreset: StartPosePreset | null;
}): Promise<
  | { kind: "continue"; followUp: VlmFollowUp | undefined; controlNote?: string }
  | { kind: "finalize"; note: string }
> {
  const { step, decision, context, activeEntityId, activeStoreyId, stats, lastViewPreset } = args;
  const novelty = context.snapshotNovelty;
  const threshold = getPrototypeRuntimeSettings().snapshotNoveltyRedundancyThreshold;
  if (!activeEntityId || !stats || !novelty) {
    return { kind: "continue", followUp: decision.followUp };
  }

  const isLowNovelty =
    novelty.redundancyWarning || novelty.approximateNoveltyScore < threshold;
  if (!isLowNovelty) {
    return { kind: "continue", followUp: decision.followUp };
  }

  const repeatedLowNovelty =
    stats.recentLowNoveltyCount >= 2 || stats.recentRedundancyWarnings >= 2;
  const requestedFollowUp = decision.followUp;
  const requestedFamily = getLowNoveltyActionFamily(requestedFollowUp?.request);
  const lowNoveltyFamily = getLowNoveltyActionFamily(stats.lastLowNoveltyAction);
  const repeatsLowValuePattern = Boolean(
    requestedFollowUp &&
      stats.lastLowNoveltyAction &&
      (
        requestedFollowUp.request === stats.lastLowNoveltyAction ||
        (lowNoveltyFamily === "scope" && requestedFamily === "scope") ||
        (lowNoveltyFamily === "plan" && requestedFamily === "plan")
      )
  );

  const noveltyDescriptor = `snapshot novelty ${novelty.approximateNoveltyScore.toFixed(2)} (threshold ${threshold.toFixed(2)})`;
  if (repeatedLowNovelty) {
    const note =
      `Low-novelty anti-repeat finalized entity ${activeEntityId} as inconclusive: ${noveltyDescriptor}; ` +
      `additional navigation produced redundant evidence and required measurement could not be grounded.`;
    await recordNavigationControlEvent({
      step,
      requestedFollowUp,
      activeEntityId,
      activeStoreyId,
      note,
      evidenceRequirementsBeforeAction: context.evidenceRequirements,
      decisionSource: "anti_repeat",
      snapshotNoveltyBeforeAction: context.snapshotNovelty,
    });
    return { kind: "finalize", note };
  }

  if (requestedFollowUp && repeatsLowValuePattern) {
    const alternative = chooseLowNoveltyAlternative({
      requestedFollowUp,
      context,
      lastViewPreset,
      stats,
    });
    if (alternative && followUpKey(alternative) !== followUpKey(requestedFollowUp)) {
      return {
        kind: "continue",
        followUp: alternative,
        controlNote:
          `Low-novelty anti-repeat substituted ${requestedFollowUp.request} with ${alternative.request} after ${noveltyDescriptor}.`,
      };
    }

    const note =
      `Low-novelty anti-repeat suppressed ${requestedFollowUp.request} for entity ${activeEntityId}: ` +
      `${noveltyDescriptor}; no clearly useful alternate action remained.`;
    await recordNavigationControlEvent({
      step,
      requestedFollowUp,
      activeEntityId,
      activeStoreyId,
      note,
      evidenceRequirementsBeforeAction: context.evidenceRequirements,
      decisionSource: "anti_repeat",
      snapshotNoveltyBeforeAction: context.snapshotNovelty,
    });
    return { kind: "finalize", note };
  }

  return {
    kind: "continue",
    followUp: requestedFollowUp,
    controlNote:
      requestedFollowUp
        ? `Low-novelty context observed after ${noveltyDescriptor}; allowing ${requestedFollowUp.request} because it changes strategy.`
        : `Low-novelty context observed after ${noveltyDescriptor}.`,
  };
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
  minTargetAreaRatio = Math.max(HIGHLIGHT_TARGET_AREA_RATIO, HIGHLIGHT_NAVIGATION_DEFAULTS.targetAreaRatio),
  opts?: {
    enableOcclusion?: boolean;
    maxOcclusionRatio?: number;
    reasonPrefix?: string;
    useDoorClearanceFocusBox?: boolean;
  }
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
    isDoorTarget && opts?.useDoorClearanceFocusBox !== false && viewerApi.getDoorClearanceFocusBox
      ? await viewerApi.getDoorClearanceFocusBox(ids.slice(0, 1))
      : undefined;
  const m = await navigationAgent.navigateToSelection(map as any, {
    minTargetAreaRatio: targetAreaGoal,
    maxOcclusionRatio: opts?.maxOcclusionRatio,
    maxSteps: navProfile.maxSteps,
    zoomFactor: navProfile.zoomFactor,
    orbitDegrees: lastViewPreset === "top" ? 0 : navProfile.orbitDegrees,
    enableOcclusion: Boolean(opts?.enableOcclusion),
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
    reason: opts?.reasonPrefix ? `${opts.reasonPrefix}:${m.reason}` : m.reason,
    zoomPotentialExhausted,
  };
  return nav;
};

const recenterOnActiveHighlight = async (
  minTargetAreaRatio = Math.max(HIGHLIGHT_TARGET_AREA_RATIO, HIGHLIGHT_NAVIGATION_DEFAULTS.targetAreaRatio)
) => {
  if (!lastHighlightedIds.length) return undefined;
  return focusHighlightedIds(getActiveHighlightFocusIds(), minTargetAreaRatio);
};

if (f.request === "ISO_VIEW") {
  await viewerApi.setPresetView("iso", true);
  lastViewPreset = "iso";
  await reapplyPersistentHighlight();
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "iso" as const, nav };
}

if (f.request === "TOP_VIEW") {
  if (previousActionReason === "top") {
    return { didSomething: false, reason: "top-view-already-active" as const, nav: previousNav };
  }
  await viewerApi.setPresetView("top", true);
  lastViewPreset = "top";
  await reapplyPersistentHighlight();
  const nav = await recenterOnActiveHighlight(TOP_VIEW_TARGET_AREA_RATIO);
  return { didSomething: true, reason: "top" as const, nav };
}
// Set view preset follow-up
if (f.request === "SET_VIEW_PRESET") {
  const preset = f.params.preset;
  if (preset === "TOP") {
    await viewerApi.setPresetView("top", true);
    lastViewPreset = "top";
    await reapplyPersistentHighlight();
    const nav = await recenterOnActiveHighlight(TOP_VIEW_TARGET_AREA_RATIO);
    return { didSomething: true, reason: "top" as const, nav };
  }
  if (preset === "ISO") {
    await viewerApi.setPresetView("iso", true);
    lastViewPreset = "iso";
    await reapplyPersistentHighlight();
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
  if (ok) await reapplyPersistentHighlight();
  return { didSomething: ok, reason: ok ? "hide-category" as const : "hide-category-failed" as const };
}

if (f.request === "SHOW_CATEGORY") {
  if (!viewerApi.showCategory) {
    console.warn("[FollowUp] showCategory not wired");
    return { didSomething: false, reason: "show-category-not-wired" as const };
  }
  const ok = await viewerApi.showCategory(f.params.category);
  if (viewerApi.getHiddenIds) lastHiddenIds = await viewerApi.getHiddenIds();
  if (ok) await reapplyPersistentHighlight();
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

  await rememberPersistentHighlight(ids, "primary");
  lastSelectedId = ids[0] ?? lastSelectedId;
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

  await rememberPersistentHighlight(ids, "primary");
  lastSelectedId = ids[0] ?? lastSelectedId;
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
  await reapplyPersistentHighlight();
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
  lastIsolatedCategories = [];
  lastHiddenIds = [];
  await reapplyPersistentHighlight();
  const nav = await recenterOnActiveHighlight();
  return { didSomething: true, reason: "storey-plan-cut" as const, nav };
}

if (f.request === "CLEAR_PLAN_CUT") {
  if (!viewerApi.clearPlanCut) {
    console.warn("[FollowUp] clearPlanCut not wired");
    return { didSomething: false, reason: "plan-cut-clear-not-wired" as const };
  }
  await viewerApi.clearPlanCut();
  await reapplyPersistentHighlight();
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
  const previousEntityId = lastSelectedId;
  const selectedTargetId = targetIds[0] ?? lastSelectedId;
  const nav = selectedTargetId
    ? await activateEntityFocus(selectedTargetId, {
        previousEntityId,
        reasonPrefix: "highlight-ids",
        highlightIds: targetIds,
      })
    : undefined;
  return { didSomething: true, reason: "highlight" as const, nav };
}

// Get properties follow-up
if (f.request === "GET_PROPERTIES") {
  const ids = lastHighlightedIds.length ? lastHighlightedIds : pickHighlightCandidates(1);
  if (!ids.length || !viewerApi.highlightIds) {
    return { didSomething: false, reason: "highlight-candidates-empty" as const };
  }
  await rememberPersistentHighlight(ids.slice(0, 1), "primary");
  lastSelectedId = ids[0] ?? lastSelectedId;
  const nav = await focusHighlightedIds(ids.slice(0, 1));
  const props = viewerApi.getProperties ? await viewerApi.getProperties(ids[0]) : null;
  return {
    didSomething: true,
    reason: props ? "properties" as const : "properties-highlight-fallback" as const,
    nav,
    props: props ?? { objectId: ids[0], source: "highlighting-fallback" },
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


if (f.request === "ORBIT" || f.request === "NEW_VIEW") {
  const focus = currentTaskGraph ? getTaskGraphFocus(currentTaskGraph) : null;
  const activeEntityKey = focus?.activeEntityId ?? lastSelectedId ?? lastHighlightedIds[0] ?? "__run__";
  const stats = entityEvidenceStats.get(activeEntityKey) ?? makeDefaultEntityEvidenceStat();

  if (stats.orbitFollowUps >= MAX_ORBIT_FOLLOW_UPS_PER_ENTITY) {
    return { didSomething: false, reason: "orbit-limit-reached" as const, nav: previousNav };
  }

  const topLike = lastViewPreset === "top";
  const params =
    f.request === "ORBIT"
      ? normalizeOrbitParams(f.params, topLike)
      : normalizeOrbitParams(
          {
            yawDegrees: topLike ? 45 : 20,
            pitchDegrees: topLike ? -30 : 0,
            reason: f.params?.reason,
          },
          topLike
        );
  const pose = await viewerApi.getCameraPose();
  await viewerApi.setCameraPose(buildOrbitPose(pose, params.yawDegrees, params.pitchDegrees), true);
  lastViewPreset = null;
  stats.orbitFollowUps += 1;
  entityEvidenceStats.set(activeEntityKey, stats);
  const orbitMaxHighlightOcclusionRatio = getPrototypeRuntimeSettings().orbitMaxHighlightOcclusionRatio;
  const activeHighlightFocusIds = getActiveHighlightFocusIds();
  const hasActiveHighlight = activeHighlightFocusIds.length > 0;
  let nav: NavMetrics | undefined;

  if (hasActiveHighlight && navigationAgent?.measureSelection) {
    const map = buildModelIdMapFromObjectIds(activeHighlightFocusIds);
    const toNavMetrics = (m: {
      targetAreaRatio: number;
      occlusionRatio: number | null;
      success: boolean;
      reason: string;
    }): NavMetrics => ({
      projectedAreaRatio: m.targetAreaRatio,
      occlusionRatio: m.occlusionRatio ?? undefined,
      convergenceScore:
        typeof m.occlusionRatio === "number" && m.occlusionRatio <= orbitMaxHighlightOcclusionRatio ? 1 : 0,
      targetAreaGoal: HIGHLIGHT_NAVIGATION_DEFAULTS.targetAreaRatio,
      success: m.success && (m.occlusionRatio === null || m.occlusionRatio <= orbitMaxHighlightOcclusionRatio),
      reason: `orbit-occlusion-guard:${m.reason}`,
      zoomPotentialExhausted: false,
    });

    const measureCurrentOrbitView = async () =>
      toNavMetrics(await navigationAgent.measureSelection!(map as any, { enableOcclusion: true }));

    nav = await measureCurrentOrbitView();
    const yawDirection = params.yawDegrees < 0 ? -1 : 1;
    const pitchDirection = params.pitchDegrees === 0 ? 0 : params.pitchDegrees < 0 ? -1 : 1;
    const retryYawDegrees = yawDirection * MAX_ORBIT_DEGREES_PER_AXIS;
    const retryPitchDegrees = pitchDirection * MAX_ORBIT_DEGREES_PER_AXIS;

    for (
      let attempt = 1;
      typeof nav.occlusionRatio === "number" &&
      nav.occlusionRatio > orbitMaxHighlightOcclusionRatio &&
      attempt <= 3;
      attempt++
    ) {
      const retryPose = await viewerApi.getCameraPose();
      await viewerApi.setCameraPose(buildOrbitPose(retryPose, retryYawDegrees, retryPitchDegrees), true);
      stats.orbitFollowUps += 1;
      entityEvidenceStats.set(activeEntityKey, stats);
      nav = {
        ...(await measureCurrentOrbitView()),
        reason: `orbit-occlusion-guard:retry-${attempt}-of-3`,
      };
    }

    if (typeof nav.occlusionRatio === "number" && nav.occlusionRatio > orbitMaxHighlightOcclusionRatio) {
      return {
        didSomething: false,
        reason: "orbit-highlight-occlusion-unresolved-needs-different-followup" as const,
        nav: {
          ...nav,
          reason:
            "orbit-highlight-occlusion-unresolved-needs-different-followup: target likely remains heavily occluded; VLM should request HIDE_CATEGORY, HIDE_IDS, ISO_VIEW, TOP_VIEW/plan cut, or another non-orbit follow-up for a better view.",
        },
      };
    }
  } else {
    nav = await recenterOnActiveHighlight();
  }

  return {
    didSomething: true,
    reason: topLike ? "orbit-from-top" as const : "orbit" as const,
    nav,
  };
}

    
    if (f.request === "ZOOM_IN") {
  if (previousNav?.zoomPotentialExhausted) {
    return { didSomething: false, reason: "zoom-potential-exhausted" as const, nav: previousNav };
  }
  if (lastHighlightedIds.length) {
    const nav = await focusHighlightedIds(getActiveHighlightFocusIds());
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
  const nav = await focusHighlightedIds(getActiveHighlightFocusIds());
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
      await rememberPersistentHighlight(targetIds, "primary");
      lastSelectedId = targetIds[0] ?? lastSelectedId;
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
  await reapplyPersistentHighlight();

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
  await reapplyPersistentHighlight();
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
  await reapplyPersistentHighlight();
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
  await reapplyPersistentHighlight();

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
  await reapplyPersistentHighlight();

  return { didSomething: true, reason: "show-ids" as const };
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

    const runtimeSettings = getPrototypeRuntimeSettings();
    const maxSteps = Math.max(5, Math.min(30, params.maxSteps ?? runtimeSettings.maxComplianceSteps));

    // One rule per project: reset everything relevant
    await viewerApi.resetVisibility();
    await snapshotCollector.reset();
    lastScope = {};
    lastIsolatedCategories = [];
    lastHiddenIds = [];
    lastHighlightedIds = [];
    lastSelectedId = null;

    // Create a new compliance run id (DB is “decisions only” for now)
    activeRunId = makeRunId();
    navigationBookmarks = [];
    navigationActionLog = [];
    entityEvidenceStats = new Map<string, EntityEvidenceStat>();
    entitySemanticTrackers = new Map<string, EntitySemanticEvidenceTracker>();

    let lastActionReason: string | null = null;
    let pendingNav: NavMetrics | undefined = undefined;
    let lastEvidenceNav: NavMetrics | undefined = undefined;
    let lastFollowUpKey: string | null = null;
    let repeatedFollowUpCount = 0;

    // Apply deterministic start (optional)
    await applyDeterministicStart(params.deterministic);
    const metadataSeeded = await seedTaskGraphFromMetadata(taskGraph, params.deterministic);
    if (metadataSeeded) {
      lastActionReason = "metadata-seed";
      const initialFocus = getTaskGraphFocus(taskGraph);
      if (initialFocus.activeEntityId) {
        await activateEntityFocus(initialFocus.activeEntityId, {
          reasonPrefix: "initial-entity-focus",
        });
      }
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
    const evidenceWindow = clampMaxSnapshotsPerRequest(
      params.evidenceWindow ?? runtimeSettings.maxSnapshotsPerRequest
    );

    // Accumulate ALL decisions across steps so the caller can build a trace
    const allDecisions: VlmDecision[] = [];

    // Per-run evidence buffer (deterministic, in-order)
    const evidence: EvidenceItem[] = [];

    function pushEvidence(item: EvidenceItem) {
      evidence.push(item);
    }

    function getEvidenceWindow(activeEntityId?: string) {
      const sameEntityEvidence = activeEntityId
        ? evidence.filter((item) => item.context?.activeEntityId === activeEntityId)
        : [];
      const source = sameEntityEvidence.length ? sameEntityEvidence : evidence;
      const slice = source.slice(Math.max(0, source.length - evidenceWindow));
      const fullEvidenceViews = slice.map((item) => ({
        snapshotId: item.artifact.id,
        mode: item.artifact.mode,
        note: item.artifact.meta.note,
        nav: item.nav,
        context: item.context ?? (item.artifact.meta as any)?.context,
      }));
      const compactFallbackSnapshotIds: string[] = [];
      const compactEvidenceViews = slice.map((item) => {
        const fullContext =
          item.context ??
          ((item.artifact.meta as any)?.context as FullTraceEvidenceContext | undefined);
        if (!fullContext) {
          compactFallbackSnapshotIds.push(item.artifact.id);
          return {
            snapshotId: item.artifact.id,
            mode: item.artifact.mode,
            note: item.artifact.meta.note,
            nav: item.nav,
            context: undefined,
          };
        }
        const compactContext = buildCompactVlmEvidenceContext({
          snapshotId: item.artifact.id,
          note: item.artifact.meta.note,
          fullContext,
          nav: item.nav,
        });
        if (shouldFallbackToFullContext(compactContext)) {
          compactFallbackSnapshotIds.push(item.artifact.id);
          return {
            snapshotId: item.artifact.id,
            mode: item.artifact.mode,
            note: item.artifact.meta.note,
            nav: item.nav,
            context: fullContext,
          };
        }
        return {
          snapshotId: item.artifact.id,
          mode: item.artifact.mode,
          note: item.artifact.meta.note,
          nav: item.nav,
          context: compactContext,
        };
      });
      const useCompactContext = runtimeSettings.useCompactVlmContext;
      const promptEvidenceViews = useCompactContext ? compactEvidenceViews : fullEvidenceViews;
      const fullContextChars = JSON.stringify(fullEvidenceViews).length;
      const compactContextChars = JSON.stringify(compactEvidenceViews).length;
      return {
        artifacts: slice.map(s => s.artifact),
        evidenceViews: promptEvidenceViews,
        fullEvidenceViews,
        compactEvidenceViews,
        promptContextStats: {
          fullContextChars,
          compactContextChars,
          snapshotCount: slice.length,
          compactModeEnabled: runtimeSettings.useCompactVlmContext,
          usedCompactContext: useCompactContext && compactFallbackSnapshotIds.length === 0,
          ...(compactFallbackSnapshotIds.length ? { fullFallbackSnapshotIds: compactFallbackSnapshotIds } : {}),
        } satisfies PromptContextStats,
      };
    }

    function buildNavigationControlPromptSection(args: {
      activeEntityId?: string;
      currentStep: number;
    }): string {
      const { activeEntityId, currentStep } = args;
      if (!activeEntityId) return "";

      const tracker = entitySemanticTrackers.get(activeEntityId);
      const recentAction = [...navigationActionLog]
        .reverse()
        .find((entry) => entry.activeEntityId === activeEntityId && entry.step < currentStep);
      const recentEvidence = [...evidence]
        .reverse()
        .find(
          (item) =>
            item.context?.activeEntityId === activeEntityId &&
            typeof item.context?.step === "number" &&
            item.context.step < currentStep
        );
      const recentSemanticProgress =
        recentAction?.semanticEvidenceProgress ?? recentEvidence?.context?.semanticEvidenceProgress;
      const recentVisualNovelty =
        recentAction?.snapshotNoveltyBeforeAction ?? recentEvidence?.context?.snapshotNovelty;
      const suppressedFollowUp =
        recentAction?.suppressedFollowUp ??
        recentSemanticProgress?.suppressedFollowUp ??
        tracker?.suppressedFollowUp;
      const finalizationReason =
        recentAction?.finalizationReason ??
        recentSemanticProgress?.finalizationReason ??
        tracker?.finalizationReason;
      const exhaustedFamilies = Object.entries(tracker?.triedActionFamilyCounts ?? {})
        .filter(([family, count]) => {
          const budget =
            SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS[
              family as keyof typeof SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS
            ];
          return typeof budget === "number" && Number(count ?? 0) >= budget;
        })
        .map(([family]) => family as FollowUpActionFamily)
        .sort();
      const stagnatedFamilies = [...(tracker?.stagnatedActionFamilies ?? [])].sort();
      const shouldInclude = Boolean(
        suppressedFollowUp ||
          finalizationReason ||
          exhaustedFamilies.length ||
          stagnatedFamilies.length ||
          recentSemanticProgress?.semanticStagnationWarning ||
          recentSemanticProgress?.sameEntityRecurrenceWarning
      );
      if (!shouldInclude) return "";

      const lines = [
        "NAVIGATION_CONTROL:",
        `activeEntity=${activeEntityId}`,
      ];

      if (suppressedFollowUp) {
        lines.push(`lastSuppressedFollowUp=${suppressedFollowUp.request}`);
        if (suppressedFollowUp.family) {
          lines.push(`suppressedFamily=${suppressedFollowUp.family}`);
        }
        lines.push(`suppressionReason=${suppressedFollowUp.reason}`);
      }
      if (typeof recentVisualNovelty?.approximateNoveltyScore === "number") {
        lines.push(`lastVisualNovelty=${recentVisualNovelty.approximateNoveltyScore.toFixed(2)}`);
      }
      if (typeof recentSemanticProgress?.semanticProgressScore === "number") {
        lines.push(`lastSemanticProgress=${recentSemanticProgress.semanticProgressScore.toFixed(2)}`);
      }
      if (typeof recentSemanticProgress?.sameEntityRecurrenceScore === "number") {
        lines.push(`lastSameEntityRecurrence=${recentSemanticProgress.sameEntityRecurrenceScore.toFixed(2)}`);
      }
      if (recentSemanticProgress?.sameEntityRecurrenceWarning) {
        lines.push("sameEntityRecurrenceWarning=true");
      }
      if (recentSemanticProgress?.semanticStagnationWarning) {
        lines.push("semanticStagnationWarning=true");
      }
      if (exhaustedFamilies.length) {
        lines.push(`exhaustedFamilies=${exhaustedFamilies.join(",")}`);
      }
      if (stagnatedFamilies.length) {
        lines.push(`stagnatedFamilies=${stagnatedFamilies.join(",")}`);
      }
      if (finalizationReason) {
        lines.push(`finalizationReason=${finalizationReason}`);
      }
      lines.push(
        "instruction=Do not request suppressed, stagnated, or exhausted follow-ups again for this entity unless the missing evidence gaps materially changed."
      );

      return lines.join("\n");
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
const stopRequestBeforeStep = params.shouldStop?.() ?? "continue";
if (stopRequestBeforeStep === "stop" || stopRequestBeforeStep === "skip") {
  return {
    ok: false as const,
    reason: stopRequestBeforeStep === "skip" ? "user-skip-requested" as const : "user-stop-requested" as const,
    final: allDecisions.length > 0 ? allDecisions[allDecisions.length - 1] : undefined,
    decisions: allDecisions,
    snapshots: evidence.length,
  };
}
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
  await reapplyPersistentHighlight();

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
const currentFocusForBudget = getTaskGraphFocus(taskGraph);
const currentEntityStatsForBudget = currentFocusForBudget.activeEntityId
  ? entityEvidenceStats.get(currentFocusForBudget.activeEntityId)
  : undefined;
const orbitCallsForActiveEntity = currentEntityStatsForBudget?.orbitFollowUps ?? 0;
const activeEntityIdForSnapshot =
  currentFocusForBudget.activeEntityId ??
  lastSelectedId ??
  (lastHighlightedIds.length === 1 ? lastHighlightedIds[0] : undefined);

// capture current evidence context
const isolatedIds = flattenModelIdMap(viewerApi.getCurrentIsolateSelection?.() ?? null);

const context: EvidenceContext = {
  step,
  phase,
  viewPreset: lastViewPreset ?? undefined,
  cameraPose,
  activeEntityId: activeEntityIdForSnapshot,
  scope: (lastScope.storeyId || lastScope.spaceId) ? lastScope : undefined,
  isolatedCategories: isolatedIds.length && lastIsolatedCategories.length ? lastIsolatedCategories : undefined,
  isolatedIds,
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
  followUpBudget: {
    orbitCallsForActiveEntity,
    maxOrbitCallsPerEntity: MAX_ORBIT_FOLLOW_UPS_PER_ENTITY,
    orbitRemainingForActiveEntity: Math.max(0, MAX_ORBIT_FOLLOW_UPS_PER_ENTITY - orbitCallsForActiveEntity),
    orbitMaxHighlightOcclusionRatio: getPrototypeRuntimeSettings().orbitMaxHighlightOcclusionRatio,
  },
  taskGraph: summarizeTaskGraph(taskGraph),
  navigationHistory: summarizeNavigationHistory(),
};

const previousEvidence = evidence.length ? evidence[evidence.length - 1] : undefined;
const previousSameEntityEvidence = activeEntityIdForSnapshot
  ? [...evidence]
      .reverse()
      .find((item) => item.context?.activeEntityId === activeEntityIdForSnapshot)
  : undefined;
const snapshotNovelty = computeSnapshotNoveltyMetrics({
  current: {
    snapshotId: artifact.id,
    activeEntityId: activeEntityIdForSnapshot,
    viewPreset: context.viewPreset,
    cameraPose: context.cameraPose,
    scope: context.scope,
    highlightedIds: context.highlightedIds,
    planCut: context.planCut,
    nav: pendingNav,
  },
  previous: previousEvidence
    ? {
        snapshotId: previousEvidence.artifact.id,
        activeEntityId: previousEvidence.context?.activeEntityId,
        viewPreset: previousEvidence.context?.viewPreset,
        cameraPose: previousEvidence.context?.cameraPose ?? previousEvidence.artifact.meta.camera,
        scope: previousEvidence.context?.scope,
        highlightedIds: previousEvidence.context?.highlightedIds,
        planCut: previousEvidence.context?.planCut,
        nav: previousEvidence.nav,
      }
    : undefined,
  previousSameEntity: previousSameEntityEvidence
    ? {
        snapshotId: previousSameEntityEvidence.artifact.id,
        activeEntityId: previousSameEntityEvidence.context?.activeEntityId,
        viewPreset: previousSameEntityEvidence.context?.viewPreset,
        cameraPose:
          previousSameEntityEvidence.context?.cameraPose ?? previousSameEntityEvidence.artifact.meta.camera,
        scope: previousSameEntityEvidence.context?.scope,
        highlightedIds: previousSameEntityEvidence.context?.highlightedIds,
        planCut: previousSameEntityEvidence.context?.planCut,
        nav: previousSameEntityEvidence.nav,
      }
    : undefined,
});
context.snapshotNovelty = snapshotNovelty;
context.evidenceRequirements = deriveRuntimeEvidenceRequirements({
  context,
  nav: pendingNav,
  stats: currentEntityStatsForBudget,
});

// Keep the snapshot artifact self-contained for inspection-history replay.
// The viewer snapshot only includes lightweight HUD metadata; this runner
// context carries the actual restorable state: isolation, hidden IDs,
// highlights, camera pose, and plan-cut settings.
artifact.meta.context = {
  ...(artifact.meta.context ?? {}),
  ...context,
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

      const windowed = getEvidenceWindow(activeEntityIdForSnapshot);
      const promptTaskState = summarizeTaskGraph(taskGraph);
      const rulePromptForStep =
        step <= 1
          ? prompt
          : buildCompactFollowUpTaskPrompt({
              fullTaskPrompt: prompt,
              activeTaskTitle: promptTaskState.activeTask?.title,
              activeEntityId: promptTaskState.activeEntity?.id,
              activeEntityClass: promptTaskState.activeEntity?.class,
              activeStoreyId: promptTaskState.activeStoreyId,
              activeConcerns: promptTaskState.concerns,
            });
      const navigationControlPrompt = buildNavigationControlPromptSection({
        activeEntityId: activeEntityIdForSnapshot,
        currentStep: step,
      });
      const promptWithChecklist = [
        rulePromptForStep,
        buildTaskGraphPromptSection(taskGraph),
        navigationControlPrompt,
      ]
        .filter(Boolean)
        .join("\n\n");
      console.info("[VLM Prompt Context]", {
        step,
        fullContextChars: windowed.promptContextStats.fullContextChars,
        compactContextChars: windowed.promptContextStats.compactContextChars,
        snapshots: windowed.promptContextStats.snapshotCount,
        compactModeEnabled: windowed.promptContextStats.compactModeEnabled,
        usedCompactContext: windowed.promptContextStats.usedCompactContext,
        fullFallbackSnapshotIds: windowed.promptContextStats.fullFallbackSnapshotIds ?? [],
      });
      const decision = await vlmChecker.check({
        prompt: promptWithChecklist,
        artifacts: windowed.artifacts,
        evidenceViews: windowed.evidenceViews,
      });
      decision.meta.promptContextStats = windowed.promptContextStats;
      decision.meta.promptEvidenceViews = windowed.evidenceViews;
      decision.meta.taskPromptMode = step <= 1 ? "full_rule_text" : "compact_follow_up_summary";
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
        decision.followUp?.request === "WEB_FETCH" ? "supplemental web regulatory evidence requested" : "",
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
        thinking: decision.rationale,
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
      const stopRequestAfterDecision = params.shouldStop?.() ?? "continue";
      if (stopRequestAfterDecision === "stop" || stopRequestAfterDecision === "skip") {
        return {
          ok: false as const,
          reason: stopRequestAfterDecision === "skip" ? "user-skip-requested" as const : "user-stop-requested" as const,
          final: decision,
          decisions: allDecisions,
          snapshots: evidence.length,
        };
      }

      let followUpPlan = chooseFollowUpFromEvidenceRequirements({
        decision,
        context,
        lastViewPreset,
        nav: lastEvidenceNav,
        sameEntityHistory: activeEntityIdForSnapshot
          ? evidence.filter((item) => item.context?.activeEntityId === activeEntityIdForSnapshot)
          : undefined,
      });
      let guardedFollowUp = followUpPlan.followUp;
      let followUpDecisionSource: FollowUpDecisionSource = followUpPlan.source;
      let followUpDecisionReason = followUpPlan.reason;
      let evidenceRequirementsBeforeAction = mergeEvidenceRequirements(
        context.evidenceRequirements,
        followUpPlan.evidenceRequirements
      );
      let semanticEvidenceProgress: SemanticEvidenceProgress | undefined;
      let semanticSuppressedFollowUp: SuppressedFollowUpTrace | undefined;
      let lowNoveltyControlNote: string | undefined;
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
          ...makeDefaultEntityEvidenceStat(),
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
        const noveltyThreshold = runtimeSettings.snapshotNoveltyRedundancyThreshold;
        const latestNovelty = context.snapshotNovelty;
        const latestLowNovelty = Boolean(
          latestNovelty &&
            (latestNovelty.redundancyWarning || latestNovelty.approximateNoveltyScore < noveltyThreshold)
        );
        if (latestLowNovelty) {
          stats.recentLowNoveltyCount += 1;
          stats.recentRedundancyWarnings = latestNovelty?.redundancyWarning
            ? stats.recentRedundancyWarnings + 1
            : 0;
          stats.lastLowNoveltyAction = getLatestSuccessfulActionForEntity(activeEntityBeforeDecision);
        } else if (latestNovelty) {
          stats.recentLowNoveltyCount = 0;
          stats.recentRedundancyWarnings = 0;
          stats.lastLowNoveltyAction = undefined;
          stats.lastUsefulNoveltyScore = latestNovelty.approximateNoveltyScore;
        }
        entityEvidenceStats.set(activeEntityBeforeDecision, stats);
        const entityStepBudgetReached = stats.steps >= runtimeSettings.entityUncertainTerminationSteps;
        const hasConfidentFinalVerdict =
          (decision.verdict === "PASS" || decision.verdict === "FAIL") && decision.confidence >= minConfidence;
        const semanticTracker =
          entitySemanticTrackers.get(activeEntityBeforeDecision) ??
          makeDefaultSemanticTracker(activeEntityBeforeDecision);
        const currentDecisionEvidenceRequirements = deriveRuntimeEvidenceRequirements({
          context,
          decision,
          nav: lastEvidenceNav,
          stats,
        });
        const recurrenceMetrics = computeSameEntityRecurrenceMetrics({
          currentStep: step,
          current: {
            snapshotId: artifact.id,
            activeEntityId: activeEntityBeforeDecision,
            viewPreset: context.viewPreset,
            cameraPose: context.cameraPose,
            scope: context.scope,
            highlightedIds: context.highlightedIds,
            planCut: context.planCut,
            nav: lastEvidenceNav,
          },
          history: evidence,
        });
        semanticEvidenceProgress = assessSemanticEvidenceProgress({
          activeEntityId: activeEntityBeforeDecision,
          tracker: semanticTracker,
          missingEvidence: normalizeMissingEvidenceGaps([
            ...(decision.missingEvidence ?? []),
            ...(decision.visibility?.missingEvidence ?? []),
          ]),
          evidenceRequirementsStatus: currentDecisionEvidenceRequirements.status,
          recurrenceMetrics,
        });
        const updatedSemanticTracker = updateSemanticTrackerFromDecision({
          tracker: semanticTracker,
          progress: semanticEvidenceProgress,
          evidenceRequirementsStatus: currentDecisionEvidenceRequirements.status,
        });
        entitySemanticTrackers.set(activeEntityBeforeDecision, updatedSemanticTracker);
        context.normalizedEvidenceGaps = [...semanticEvidenceProgress.normalizedEvidenceGaps];
        context.semanticEvidenceProgress = {
          ...semanticEvidenceProgress,
          triedActionFamilies: [...updatedSemanticTracker.triedActionFamilies],
          triedActionFamilyCounts: { ...updatedSemanticTracker.triedActionFamilyCounts },
          lastActionFamily: updatedSemanticTracker.lastActionFamily,
          lastEvidenceProgressSummary: updatedSemanticTracker.lastEvidenceProgressSummary,
        };
        context.triedActionFamilies = [...updatedSemanticTracker.triedActionFamilies];
        artifact.meta.context = {
          ...(artifact.meta.context ?? {}),
          ...context,
        };
        followUpPlan = chooseFollowUpFromEvidenceRequirements({
          decision,
          context,
          lastViewPreset,
          nav: lastEvidenceNav,
          stats,
          evidenceRequirements: currentDecisionEvidenceRequirements,
          semanticTracker: updatedSemanticTracker,
          semanticProgress: semanticEvidenceProgress,
          sameEntityHistory: evidence.filter(
            (item) => item.context?.activeEntityId === activeEntityBeforeDecision
          ),
        });
        guardedFollowUp = followUpPlan.followUp;
        followUpDecisionSource = followUpPlan.source;
        followUpDecisionReason = followUpPlan.reason;
        evidenceRequirementsBeforeAction = mergeEvidenceRequirements(
          context.evidenceRequirements,
          followUpPlan.evidenceRequirements
        );
        semanticSuppressedFollowUp = followUpPlan.suppressedFollowUp;
        if (semanticEvidenceProgress) {
          context.semanticEvidenceProgress = {
            ...context.semanticEvidenceProgress,
            ...semanticEvidenceProgress,
            triedActionFamilies: [...updatedSemanticTracker.triedActionFamilies],
            triedActionFamilyCounts: { ...updatedSemanticTracker.triedActionFamilyCounts },
            lastActionFamily: updatedSemanticTracker.lastActionFamily,
            lastEvidenceProgressSummary: updatedSemanticTracker.lastEvidenceProgressSummary,
            suppressedFollowUp: cloneSuppressedFollowUp(semanticSuppressedFollowUp),
            finalizationReason: followUpPlan.finalizationReason,
          };
          context.suppressedFollowUp = cloneSuppressedFollowUp(semanticSuppressedFollowUp);
          context.finalizationReason = followUpPlan.finalizationReason;
          artifact.meta.context = {
            ...(artifact.meta.context ?? {}),
            ...context,
          };
        }

        if (
          decision.verdict === "UNCERTAIN" &&
          followUpPlan.finalizationReason &&
          (semanticEvidenceProgress?.semanticStagnationWarning ||
            semanticEvidenceProgress?.sameEntityRecurrenceWarning)
        ) {
          const finalizationReason = followUpPlan.finalizationReason;
          const trackerForFinalization = entitySemanticTrackers.get(activeEntityBeforeDecision);
          if (trackerForFinalization) {
            trackerForFinalization.finalizationReason = finalizationReason;
            trackerForFinalization.suppressedFollowUp = cloneSuppressedFollowUp(semanticSuppressedFollowUp);
            entitySemanticTrackers.set(activeEntityBeforeDecision, trackerForFinalization);
          }
          await recordNavigationControlEvent({
            step,
            requestedFollowUp: decision.followUp,
            activeEntityId: activeEntityBeforeDecision,
            activeStoreyId:
              context.scope?.storeyId ?? context.planCut?.storeyId ?? context.taskGraph?.activeStoreyId,
            note: finalizationReason,
            evidenceRequirementsBeforeAction,
            decisionSource: "anti_repeat",
            snapshotNoveltyBeforeAction: context.snapshotNovelty,
            semanticEvidenceProgress,
            suppressedFollowUp: semanticSuppressedFollowUp,
            finalizationReason,
          });
          markActiveEntityInconclusive(taskGraph, finalizationReason);
          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "semantic-evidence-stagnation";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? "Repeated navigation strategies did not reduce the same missing evidence gaps, so the runner finalized the current entity as inconclusive and advanced."
              : "Repeated navigation strategies did not reduce the same missing evidence gaps, so the current entity was finalized as inconclusive.",
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
            thinking: decision.rationale,
            followUpSummary: "Stopped because repeated views did not reduce missing evidence gaps.",
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

        const lowNoveltyGuard =
          decision.verdict === "UNCERTAIN" || decision.followUp
            ? await applyLowNoveltyFollowUpGuard({
                step,
                decision,
                context,
                activeEntityId: activeEntityBeforeDecision,
                activeStoreyId:
                  context.scope?.storeyId ?? context.planCut?.storeyId ?? context.taskGraph?.activeStoreyId,
                stats,
                lastViewPreset,
              })
            : { kind: "continue" as const, followUp: decision.followUp };

        if (lowNoveltyGuard.kind === "finalize") {
          markActiveEntityInconclusive(
            taskGraph,
            "Additional navigation produced low-novelty/redundant evidence; required measurement could not be grounded."
          );
          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "low-novelty-entity-finalized";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? "Additional navigation stayed low-novelty for the current entity, so the runner finalized it as inconclusive and advanced."
              : "Additional navigation stayed low-novelty for the current entity, so it was finalized as inconclusive.",
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
            thinking: decision.rationale,
            followUpSummary: lowNoveltyGuard.note,
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

        guardedFollowUp = lowNoveltyGuard.followUp;
        lowNoveltyControlNote = lowNoveltyGuard.controlNote;
        if (
          lowNoveltyGuard.controlNote &&
          lowNoveltyGuard.followUp &&
          followUpKey(lowNoveltyGuard.followUp) !== followUpKey(followUpPlan.followUp)
        ) {
          followUpDecisionSource = "anti_repeat";
          followUpDecisionReason = lowNoveltyGuard.controlNote;
        }

        if (
          decision.verdict === "UNCERTAIN" &&
          lastEvidenceNav?.zoomPotentialExhausted &&
          (!guardedFollowUp || guardedFollowUp.request === "ZOOM_IN")
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
            thinking: decision.rationale,
            followUpSummary: advanceResult.advanced
              ? "Focused zoom was exhausted, so the runner advanced to the next entity."
              : "Focused zoom was exhausted, so the current entity was marked inconclusive.",
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
            (stats.uncertainSteps >= runtimeSettings.entityUncertainTerminationSteps &&
              decision.confidence >= runtimeSettings.entityUncertainTerminationConfidence) ||
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
            thinking: decision.rationale,
            followUpSummary: advanceResult.advanced
              ? "Evidence was insufficient, so the runner advanced to the next entity."
              : "Evidence was insufficient, so the current entity was marked inconclusive.",
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

        if (entityStepBudgetReached && !hasConfidentFinalVerdict) {
          markActiveEntityInconclusive(
            taskGraph,
            `Per-entity step budget reached after ${stats.steps} evaluation step(s).`
          );
          const advanceResult = await advanceToNextEntity(taskGraph, activeEntityBeforeDecision);
          lastActionReason = advanceResult.restoredPreparedView
            ? "restore-storey-plan-cut-view"
            : "entity-step-budget-reached";
          params.onProgress?.({
            stage: "followup",
            step,
            summary: advanceResult.advanced
              ? `The current entity reached the per-entity step budget (${stats.steps}/${runtimeSettings.entityUncertainTerminationSteps}), so the runner advanced to the next entity.`
              : `The current entity reached the per-entity step budget (${stats.steps}/${runtimeSettings.entityUncertainTerminationSteps}), so it was marked inconclusive.`,
            taskGraph: summarizeTaskGraph(taskGraph),
            lastActionReason,
            verdict: decision.verdict,
            confidence: decision.confidence,
            thinking: decision.rationale,
            followUpSummary: advanceResult.advanced
              ? `The current entity hit its step budget, so the runner advanced to the next entity.`
              : `The current entity hit its step budget, so it was marked inconclusive.`,
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
          doorClearanceReadiness?.measurableLikely &&
          stats.topMeasurementReady &&
          stats.contextConfirmReady &&
          !guardedFollowUp
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
            thinking: decision.rationale,
            followUpSummary: advanceResult.advanced
              ? "The required evidence bundle was already collected, so the runner advanced to the next entity."
              : "The required evidence bundle was already collected, so the current entity was marked inconclusive.",
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

        if (!guardedFollowUp) {
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
            thinking: decision.rationale,
            followUpSummary: advanceResult.advanced
              ? "No additional follow-up was proposed, so the runner finalized this entity and moved on."
              : "No additional follow-up was proposed, so the current entity was finalized.",
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
            thinking: decision.rationale,
            followUpSummary: advanceResult.restoredPreparedView
              ? "The entity was decided and the prepared storey view was restored for the next entity."
              : "The entity was decided and the runner continued with the next entity.",
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
          thinking: decision.rationale,
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
const fuKey = followUpKey(guardedFollowUp);
if (fuKey && fuKey === lastFollowUpKey) repeatedFollowUpCount++;
else repeatedFollowUpCount = 0;
lastFollowUpKey = fuKey;

let followUpToRun = guardedFollowUp;
let executionDecisionSource = followUpDecisionSource;
let executionDecisionReason = followUpDecisionReason;

// If same followUp repeats, escalate instead of resetting
if (repeatedFollowUpCount >= REPEATED_FOLLOW_UPS_BEFORE_ESCALATION) {
  console.warn("[Compliance] repeating same followUp, escalating", guardedFollowUp);
  followUpToRun = escalateFollowUp(guardedFollowUp);
  executionDecisionSource = "anti_repeat";
  executionDecisionReason = `Repeated advisory follow-up ${guardedFollowUp?.request ?? "unknown"} was escalated to ${followUpToRun?.request ?? "none"} to avoid a loop.`;
  repeatedFollowUpCount = 0; // reset after escalation so we don't immediately loop
}

const acted = await executeFollowUpWithEvaluation({
  step,
  requestedFollowUp: guardedFollowUp,
  executedFollowUp: followUpToRun,
  previousActionReason: lastActionReason,
  previousNav: lastEvidenceNav,
  controlNote: lowNoveltyControlNote,
  evidenceRequirementsBeforeAction,
  decisionSource: executionDecisionSource,
  decisionReason: executionDecisionReason,
  snapshotNoveltyBeforeAction: context.snapshotNovelty,
  semanticEvidenceProgress,
  suppressedFollowUp: semanticSuppressedFollowUp,
});
lastActionReason = acted.reason;
pendingNav = (acted as any).nav ?? undefined;
updateTaskGraphFromFollowUpResult(taskGraph, followUpToRun, acted.didSomething, acted.reason);
syncEntityTasks();
params.onProgress?.({
  stage: "followup",
  step,
  summary: acted.didSomething
    ? `Executed follow-up ${followUpToRun?.request ?? "none"} to gather better evidence.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`
    : `Follow-up ${followUpToRun?.request ?? "none"} could not improve the current evidence.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`,
  taskGraph: summarizeTaskGraph(taskGraph),
  lastActionReason,
  thinking: decision.rationale,
  followUpSummary: acted.didSomething
    ? `Executed ${followUpToRun?.request ?? "no"} follow-up to gather better evidence.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`
    : `The ${followUpToRun?.request ?? "requested"} follow-up did not improve the current evidence.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`,
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

const fuKey = followUpKey(guardedFollowUp);
if (fuKey && fuKey === lastFollowUpKey) repeatedFollowUpCount++;
else repeatedFollowUpCount = 0;
lastFollowUpKey = fuKey;

let followUpToRun = guardedFollowUp;
let executionDecisionSource = followUpDecisionSource;
let executionDecisionReason = followUpDecisionReason;

// If same followUp repeats, escalate instead of resetting
if (repeatedFollowUpCount >= REPEATED_FOLLOW_UPS_BEFORE_ESCALATION) {
  console.warn("[Compliance] repeating same followUp, escalating", guardedFollowUp);
  followUpToRun = escalateFollowUp(guardedFollowUp);
  executionDecisionSource = "anti_repeat";
  executionDecisionReason = `Repeated advisory follow-up ${guardedFollowUp?.request ?? "unknown"} was escalated to ${followUpToRun?.request ?? "none"} to avoid a loop.`;
  repeatedFollowUpCount = 0; // reset after escalation so we don't immediately loop
}

const acted = await executeFollowUpWithEvaluation({
  step,
  requestedFollowUp: guardedFollowUp,
  executedFollowUp: followUpToRun,
  previousActionReason: lastActionReason,
  previousNav: lastEvidenceNav,
  controlNote: lowNoveltyControlNote,
  evidenceRequirementsBeforeAction,
  decisionSource: executionDecisionSource,
  decisionReason: executionDecisionReason,
  snapshotNoveltyBeforeAction: context.snapshotNovelty,
  semanticEvidenceProgress,
  suppressedFollowUp: semanticSuppressedFollowUp,
});
lastActionReason = acted.reason;
pendingNav = (acted as any).nav ?? undefined;
updateTaskGraphFromFollowUpResult(taskGraph, followUpToRun, acted.didSomething, acted.reason);
syncEntityTasks();
params.onProgress?.({
  stage: "followup",
  step,
  summary: acted.didSomething
    ? `Executed follow-up ${followUpToRun?.request ?? "none"} to refine the current task.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`
    : `Follow-up ${followUpToRun?.request ?? "none"} did not change the current state.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`,
  taskGraph: summarizeTaskGraph(taskGraph),
  lastActionReason,
  thinking: decision.rationale,
  followUpSummary: acted.didSomething
    ? `Executed ${followUpToRun?.request ?? "no"} follow-up to refine the current task.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`
    : `The ${followUpToRun?.request ?? "requested"} follow-up did not change the current state.${lowNoveltyControlNote ? ` ${lowNoveltyControlNote}` : ""}`,
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
return {
  start,
  getActiveRunId: () => activeRunId,
  getNavigationActions: () => navigationActionLog.map((entry) => ({
    ...entry,
    params: entry.params ? { ...entry.params } : undefined,
    requestedParams: entry.requestedParams ? { ...entry.requestedParams } : undefined,
    beforeState: entry.beforeState
      ? {
          cameraPose: entry.beforeState.cameraPose
            ? {
                eye: { ...entry.beforeState.cameraPose.eye },
                target: { ...entry.beforeState.cameraPose.target },
              }
            : undefined,
          highlightedIds: [...(entry.beforeState.highlightedIds ?? [])],
          planCut: entry.beforeState.planCut ? { ...entry.beforeState.planCut } : undefined,
        }
      : undefined,
    afterState: entry.afterState
      ? {
          cameraPose: entry.afterState.cameraPose
            ? {
                eye: { ...entry.afterState.cameraPose.eye },
                target: { ...entry.afterState.cameraPose.target },
              }
            : undefined,
          highlightedIds: [...(entry.afterState.highlightedIds ?? [])],
          planCut: entry.afterState.planCut ? { ...entry.afterState.planCut } : undefined,
        }
      : undefined,
    navigationMetrics: entry.navigationMetrics ? { ...entry.navigationMetrics } : undefined,
    evidenceRequirementsBeforeAction: entry.evidenceRequirementsBeforeAction
      ? {
          status: { ...entry.evidenceRequirementsBeforeAction.status },
          reasons: entry.evidenceRequirementsBeforeAction.reasons
            ? { ...entry.evidenceRequirementsBeforeAction.reasons }
            : undefined,
        }
      : undefined,
    chosenFollowUp: entry.chosenFollowUp
      ? {
          request: entry.chosenFollowUp.request,
          params: entry.chosenFollowUp.params ? { ...entry.chosenFollowUp.params } : undefined,
        }
      : undefined,
    snapshotNoveltyBeforeAction: entry.snapshotNoveltyBeforeAction
      ? { ...entry.snapshotNoveltyBeforeAction }
      : undefined,
    semanticEvidenceProgress: entry.semanticEvidenceProgress
      ? {
          ...entry.semanticEvidenceProgress,
          normalizedEvidenceGaps: [...entry.semanticEvidenceProgress.normalizedEvidenceGaps],
          previousEvidenceRequirementsStatus: entry.semanticEvidenceProgress.previousEvidenceRequirementsStatus
            ? { ...entry.semanticEvidenceProgress.previousEvidenceRequirementsStatus }
            : undefined,
          currentEvidenceRequirementsStatus: entry.semanticEvidenceProgress.currentEvidenceRequirementsStatus
            ? { ...entry.semanticEvidenceProgress.currentEvidenceRequirementsStatus }
            : undefined,
          triedActionFamilies: [...(entry.semanticEvidenceProgress.triedActionFamilies ?? [])],
          triedActionFamilyCounts: entry.semanticEvidenceProgress.triedActionFamilyCounts
            ? { ...entry.semanticEvidenceProgress.triedActionFamilyCounts }
            : undefined,
          suppressedFollowUp: cloneSuppressedFollowUp(entry.semanticEvidenceProgress.suppressedFollowUp),
        }
      : undefined,
    suppressedFollowUp: cloneSuppressedFollowUp(entry.suppressedFollowUp),
  })),
  parseCustomPose,
}; }

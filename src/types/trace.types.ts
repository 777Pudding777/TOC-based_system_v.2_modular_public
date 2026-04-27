/**
 * src/types/trace.types.ts
 * TypeScript interfaces for conversation trace logging.
 * Stores complete VLM interaction traces for reproducibility and reporting.
 *
 * @module trace.types
 */

import type { VlmDecision, VlmFollowUp, VlmVerdict } from "../modules/vlmChecker";
import type { SnapshotArtifact } from "../modules/snapshotCollector";
import type { EvidenceRequirementsSnapshot } from "./evidenceRequirements.types";
import type { ComplianceRule } from "./rule.types";

export type FollowUpActionFamily =
  | "plan_measurement"
  | "context_angle"
  | "focus"
  | "scope"
  | "occlusion_or_context_cleanup"
  | "regulatory_grounding"
  | "property_measurement"
  | "restore"
  | "reset";

export interface SuppressedFollowUpTrace {
  request: VlmFollowUp["request"];
  family?: FollowUpActionFamily;
  reason: string;
}

export interface SemanticEvidenceProgressTrace {
  normalizedEvidenceGaps: string[];
  evidenceGapsChanged: boolean;
  resolvedGapCount: number;
  newGapCount: number;
  unchangedGapCount: number;
  semanticProgressScore: number;
  semanticStagnationWarning: boolean;
  sameEntityRecurrenceScore?: number;
  sameEntityRecurrenceWarning?: boolean;
  sameEntityRecurrenceComparedSnapshotId?: string;
  sameEntityRecurrenceStepDelta?: number;
  sameEntityRecurrenceViewSimilarity?: number;
  sameEntityRecurrenceDecayWeight?: number;
  sameEntityRecurrenceFailureWeight?: number;
  repeatedEvidenceGapCount: number;
  previousEvidenceRequirementsStatus?: Record<string, boolean>;
  currentEvidenceRequirementsStatus?: Record<string, boolean>;
  triedActionFamilies?: FollowUpActionFamily[];
  triedActionFamilyCounts?: Partial<Record<FollowUpActionFamily, number>>;
  lastActionFamily?: FollowUpActionFamily;
  lastEvidenceProgressSummary?: string;
  suppressedFollowUp?: SuppressedFollowUpTrace;
  finalizationReason?: string;
}

/**
 * Camera pose for snapshot context
 */
export interface CameraPoseTrace {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

/**
 * Plan-cut state captured for audit and replay traces
 */
export interface PlanCutStateTrace {
  enabled?: boolean;
  height?: number;
  absoluteHeight?: number;
  thickness?: number;
  mode?: string;
  source?: string;
  storeyId?: string;
}

/**
 * Lightweight navigation state snapshot captured before/after deterministic follow-ups.
 */
export interface NavigationStateTrace {
  cameraPose?: CameraPoseTrace;
  highlightedIds?: string[];
  planCut?: PlanCutStateTrace;
}

/**
 * Navigation action executed during inspection
 */
export interface NavigationAction {
  /** Step number in sequence */
  step: number;
  /** Action type from VlmFollowUp */
  action: VlmFollowUp["request"];
  /** Original follow-up type requested by the VLM before normalization/escalation */
  requestedAction?: VlmFollowUp["request"];
  /** Active entity under inspection when the follow-up ran */
  activeEntityId?: string;
  /** Active storey under inspection when available */
  activeStoreyId?: string;
  /** Action parameters */
  params?: Record<string, unknown>;
  /** Original parameters before normalization/escalation */
  requestedParams?: Record<string, unknown>;
  /** Reason for this action */
  reason?: string;
  /** Timestamp of action */
  timestamp: string;
  /** Success status */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Deterministic no-op/failure cause from the runner */
  noOpReason?: string;
  /** Viewer state before executing the follow-up */
  beforeState?: NavigationStateTrace;
  /** Viewer state after executing the follow-up */
  afterState?: NavigationStateTrace;
  /** Deterministic navigation metrics from the action result */
  navigationMetrics?: {
    targetAreaRatio?: number;
    projectedAreaRatio?: number;
    occlusionRatio?: number;
    convergenceScore?: number;
    targetAreaGoal?: number;
    zoomExhausted?: boolean;
    success?: boolean;
    reason?: string;
  };
  /** Generalized evidence-requirement state before the action was chosen */
  evidenceRequirementsBeforeAction?: EvidenceRequirementsSnapshot;
  /** Explicit follow-up that the runtime ultimately chose */
  chosenFollowUp?: {
    request: VlmFollowUp["request"];
    params?: Record<string, unknown>;
  };
  /** Which layer decided the follow-up that was logged */
  decisionSource?: "runtime_planner" | "vlm_advisory" | "provider_override" | "anti_repeat";
  /** Human-readable explanation for the chosen follow-up */
  decisionReason?: string;
  /** Paper-inspired deterministic evaluation summary for navigation auditability */
  evaluationSummary?: string;
  /** Local visual novelty state at the moment the action was chosen */
  snapshotNoveltyBeforeAction?: SnapshotNoveltyMetrics;
  /** Semantic evidence stagnation / anti-cycle metadata */
  semanticEvidenceProgress?: SemanticEvidenceProgressTrace;
  /** Classified family of the executed or suppressed follow-up */
  actionFamily?: FollowUpActionFamily;
  /** Advisory/runtime follow-up suppressed by semantic anti-cycle logic */
  suppressedFollowUp?: SuppressedFollowUpTrace;
  /** Reason the entity was finalized without another follow-up */
  finalizationReason?: string;
}

/**
 * Lightweight, deterministic snapshot novelty heuristic.
 * This is intentionally conservative and paper-inspired rather than a full
 * next-best-view or reconstruction metric.
 */
export interface SnapshotNoveltyMetrics {
  /** Snapshot used as the baseline for comparison, when available */
  comparedToSnapshotId?: string;
  /** Active entity used for the baseline comparison, when available */
  comparedEntityId?: string;
  /** Whether the immediately previous snapshot was already focused on the same entity */
  sameEntityAsPrevious: boolean;
  /** Whether the stored view preset changed relative to the comparison snapshot */
  viewPresetChanged: boolean;
  /** Whether the camera pose changed beyond a conservative threshold */
  cameraMoved: boolean;
  /** Whether yaw/pitch changed enough to suggest a meaningful reorientation */
  yawPitchChanged: boolean;
  /** Whether plan-cut state changed */
  planCutChanged: boolean;
  /** Whether highlighted IDs changed */
  highlightedIdsChanged: boolean;
  /** Whether scoped storey/space changed */
  scopeChanged: boolean;
  /** Whether projected target area changed materially, if available */
  projectedAreaChanged?: boolean;
  /** Whether occlusion changed materially, if available */
  occlusionChanged?: boolean;
  /** Approximate deterministic novelty score in the range [0, 1] */
  approximateNoveltyScore: number;
  /** Warning that the snapshot is likely redundant for the current entity */
  redundancyWarning: boolean;
}

/**
 * Snapshot metadata for trace
 */
export interface SnapshotTrace {
  /** Unique snapshot ID */
  snapshotId: string;
  /** Reason for taking snapshot */
  reason: string;
  /** Camera pose at time of snapshot */
  cameraPose: CameraPoseTrace;
  /** Timestamp */
  timestamp: string;
  /** Snapshot mode */
  mode: SnapshotArtifact["mode"];
  /** Currently isolated element IDs */
  isolatedElements?: string[];
  /** Currently hidden element IDs */
  hiddenElements?: string[];
  /** Plan cut applied */
  planCut?: { height: number; thickness?: number };
  /** Active entity under inspection when the snapshot was captured */
  activeEntityId?: string;
  /** Lightweight novelty / redundancy heuristic */
  novelty?: SnapshotNoveltyMetrics;
  /** Semantic evidence progress derived from this snapshot's decision */
  semanticEvidenceProgress?: SemanticEvidenceProgressTrace;
  /** Base64 image data (embedded in trace for export) */
  imageBase64?: string;
}

/**
 * VLM prompt with full context
 */
export interface VlmPromptTrace {
  /** Step number */
  step: number;
  /** Full prompt text sent to VLM */
  promptText: string;
  /** Origin of the prompt content */
  promptSource?: "rule_library" | "custom_user_prompt";
  /** Human-readable source label (rule title or custom prompt) */
  promptSourceLabel?: string;
  /** Original source text before coupling/wrapping */
  sourceText?: string;
  /** Web sources used while grounding this step (if any) */
  webSourcesUsed?: Array<{
    sourceType: WebEvidenceRecord["sourceType"];
    url: string;
    via?: WebEvidenceRecord["via"];
  }>;
  /** Rule context included in prompt */
  ruleContext: {
    ruleId: string;
    ruleTitle: string;
    ruleDescription: string;
    evaluationCriteria: ComplianceRule["evaluationCriteria"];
    visualEvidence: ComplianceRule["visualEvidence"];
  };
  /** Snapshot IDs referenced in prompt */
  snapshotIds: string[];
  /** Timestamp of prompt generation */
  timestamp: string;
  /** Model used for this prompt */
  modelId: string;
}

/**
 * VLM response with structured decision
 */
export interface VlmResponseTrace {
  /** Step number (matches VlmPromptTrace.step) */
  step: number;
  /** Full decision from VLM */
  decision: VlmDecision;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** Timestamp of response */
  timestamp: string;
  /** Raw response text (if available) */
  rawResponse?: string;
}

/**
 * Evaluation metrics for a single step
 */
export interface StepMetrics {
  /** Step number */
  step: number;
  /** Snapshot capture time in ms */
  snapshotCaptureTimeMs?: number;
  /** VLM response time in ms */
  vlmResponseTimeMs: number;
  /** Confidence score from VLM */
  confidence: number;
  /** Verdict for this step */
  verdict: VlmVerdict;
  /** Any failure notes */
  failureNotes?: string;
}

/**
 * Overall inspection metrics
 */
export interface InspectionMetrics {
  /** Total number of snapshots taken */
  totalSnapshots: number;
  /** Total number of VLM calls */
  totalVlmCalls: number;
  /** Total navigation steps */
  totalNavigationSteps: number;
  /** Total inspection duration in ms */
  totalDurationMs: number;
  /** Average VLM response time in ms */
  avgVlmResponseTimeMs: number;
  /** Average confidence score */
  avgConfidence: number;
  /** Final verdict */
  finalVerdict: VlmVerdict;
  /** Final confidence */
  finalConfidence: number;
  /** Number of uncertain steps */
  uncertainSteps: number;
  /** Failure notes collected during inspection */
  failureNotes: string[];
  /** Total tokens used by compliance-check VLM calls */
  complianceTokensUsed?: number;
}

/**
 * Secondary judge result created after primary VLM checks and before report generation.
 */
export interface JudgeTaskVerdict {
  /** Human-readable task label */
  taskLabel: string;
  /** Entity ID if the judged task maps to a specific model entity */
  entityId?: string;
  /** First inspection step included in this judge verdict */
  stepStart?: number;
  /** Last inspection step included in this judge verdict */
  stepEnd?: number;
  /** Judge verdict for this task/entity */
  verdict: VlmVerdict;
  /** Judge confidence for this task/entity */
  confidence: number;
  /** Evidence-grounded reasoning */
  reasoning: string;
  /** Snapshot IDs the judge relied on */
  evidenceSnapshotIds: string[];
}

export interface JudgeReport {
  /** Time the judge pass was created */
  createdAtIso: string;
  /** Provider used for the independent judge call */
  provider: string;
  /** Same model ID as the primary VLM configuration */
  modelId: string;
  /** Overall judge verdict */
  verdict: VlmVerdict;
  /** Overall judge confidence */
  confidence: number;
  /** Evidence-grounded judge rationale */
  rationale: string;
  /** Per-task/per-entity verdicts when identifiable */
  taskVerdicts: JudgeTaskVerdict[];
  /** Places the user can inspect manually to finish unresolved checks */
  suggestionsForUser: string[];
  /** Debug review of primary VLM decisions and possible improvements */
  debuggingAndSuggestions: {
    primaryDecisionAssessment: string;
    possibleMistakes: string[];
    capabilityNotes: string[];
    improvementSuggestions: string[];
  };
  /** Non-fatal judge error if the secondary call failed */
  error?: string;
}

/**
 * Scene state at a point in time
 */
export interface SceneState {
  /** Step number represented by this scene state */
  step?: number;
  /** Snapshot associated with this state, if any */
  snapshotId?: string;
  /** Human-readable state label */
  label?: string;
  /** Action or reason that produced this state */
  action?: string;
  /** Current camera pose */
  cameraPose: CameraPoseTrace;
  /** Current view preset (if applicable) */
  viewPreset?: "iso" | "top" | "front" | "custom";
  /** Currently isolated storey */
  isolatedStorey?: string;
  /** Currently isolated space */
  isolatedSpace?: string;
  /** Currently isolated categories */
  isolatedCategories?: string[];
  /** Exact isolated element IDs */
  isolatedIds?: string[];
  /** Hidden element IDs */
  hiddenIds?: string[];
  /** Highlighted element IDs */
  highlightedIds?: string[];
  /** Plan cut state */
  planCut?: PlanCutStateTrace;
  /** Active entity under inspection when available */
  activeEntityId?: string;
  /** Lightweight novelty / redundancy heuristic */
  novelty?: SnapshotNoveltyMetrics;
  /** Semantic evidence progress derived from the step decision */
  semanticEvidenceProgress?: SemanticEvidenceProgressTrace;
}

/**
 * Stressed finding for reports
 */
export interface StressedFinding {
  /** Type: PASS, FAIL, or WARNING */
  type: "PASS" | "FAIL" | "WARNING";
  /** Summary message (e.g., "Corridor is too narrow") */
  message: string;
  /** Detailed explanation */
  details: string;
  /** Related snapshot IDs */
  snapshotIds: string[];
  /** Confidence of this finding */
  confidence: number;
  /** Step number where this was found */
  step: number;
}

/**
 * Complete conversation trace for an inspection run
 */
export interface ConversationTrace {
  /** Unique trace ID */
  traceId: string;
  /** Run ID this trace belongs to */
  runId: string;
  /** Rule being checked */
  rule: {
    id: string;
    title: string;
    description: string;
    category: string;
    severity: string;
  };
  /** Model information */
  model: {
    id: string;
    provider: string;
    name: string;
  };
  /** Inspection started timestamp */
  startedAt: string;
  /** Inspection completed timestamp */
  completedAt?: string;
  /** Status */
  status: "in_progress" | "completed" | "failed" | "aborted";

  /** All prompts sent to VLM */
  prompts: VlmPromptTrace[];
  /** All responses from VLM */
  responses: VlmResponseTrace[];
  /** All snapshots taken */
  snapshots: SnapshotTrace[];
  /** All navigation actions */
  navigationActions: NavigationAction[];
  /** Scene states at each step */
  sceneStates: SceneState[];
  /** Per-step metrics */
  stepMetrics: StepMetrics[];
  /** Overall metrics */
  metrics?: InspectionMetrics;
  /** Stressed findings */
  stressedFindings: StressedFinding[];
  /** Final verdict */
  finalVerdict?: VlmVerdict;
  /** Final confidence */
  finalConfidence?: number;
  /** Final rationale */
  finalRationale?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Regulatory/web evidence injected into VLM context */
  webEvidence?: WebEvidenceRecord[];
  /** Independent secondary judge pass over the pre-report evidence */
  judgeReport?: JudgeReport;
}

/**
 * Trace export format
 */
export interface TraceExport {
  /** Export version */
  version: "1.0.0";
  /** Export timestamp */
  exportedAt: string;
  /** Application info */
  application: {
    name: string;
    version: string;
  };
  /** The trace data */
  trace: ConversationTrace;
}
/**
 * Structured record for web evidence fetched during inspection
 */
export interface WebEvidenceRecord {
  /** Step in checker loop when evidence was fetched */
  step: number;
  /** Evidence source class */
  sourceType: "WEB_FETCH" | "TAVILY_SEARCH";
  /** Canonical source URL */
  url: string;
  /** Retrieval timestamp */
  fetchedAt: string;
  /** Success status */
  ok: boolean;
  /** Extracted text length */
  chars: number;
  /** Cache source if reused */
  fromCache?: "memory" | "localStorage";
  /** Transport/backend used */
  via?: "tavily/extract" | "tavily/search" | "proxy";
  /** Search query if this came from search fallback */
  query?: string;
  /** Optional result title */
  title?: string;
  /** Exact extracted text injected into VLM context */
  text: string;
  /** Optional reduced text if extraction was truncated */
  reducedText?: string;
  /* Optional headings extracted for context reduction */
  reductionHeadings?: string[];
  /* Optional rationale for any text reduction performed */
  reductionRationale?: string;
  /* Optional error message if text extraction failed or was reduced */
  reductionError?: string;
  /** Error text if retrieval failed */
  error?: string;
}

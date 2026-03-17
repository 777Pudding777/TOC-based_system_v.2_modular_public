/**
 * src/types/trace.types.ts
 * TypeScript interfaces for conversation trace logging.
 * Stores complete VLM interaction traces for reproducibility and reporting.
 *
 * @module trace.types
 */

import type { VlmDecision, VlmFollowUp, VlmVerdict } from "../modules/vlmChecker";
import type { SnapshotArtifact } from "../modules/snapshotCollector";
import type { ComplianceRule } from "./rule.types";

/**
 * Camera pose for snapshot context
 */
export interface CameraPoseTrace {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

/**
 * Navigation action executed during inspection
 */
export interface NavigationAction {
  /** Step number in sequence */
  step: number;
  /** Action type from VlmFollowUp */
  action: VlmFollowUp["request"];
  /** Action parameters */
  params?: Record<string, unknown>;
  /** Reason for this action */
  reason?: string;
  /** Timestamp of action */
  timestamp: string;
  /** Success status */
  success: boolean;
  /** Error message if failed */
  error?: string;
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
}

/**
 * Scene state at a point in time
 */
export interface SceneState {
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
  /** Hidden element IDs */
  hiddenIds?: string[];
  /** Highlighted element IDs */
  highlightedIds?: string[];
  /** Plan cut state */
  planCut?: { height: number; thickness?: number; mode?: string };
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
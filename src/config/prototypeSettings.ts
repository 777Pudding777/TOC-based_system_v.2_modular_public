// src/config/prototypeSettings.ts
// Centralized prototype tuning values for the settings

/**
 * Default maximum number of compliance-checking steps per run.
 * The runner still clamps against its hard internal upper bound.
 */
export const DEFAULT_MAX_COMPLIANCE_STEPS = 15;

/**
 * Existing repeated follow-up handling:
 * after this many identical follow-up repeats, the runner escalates
 * to a different action instead of repeating the same follow-up again.
 */
export const REPEATED_FOLLOW_UPS_BEFORE_ESCALATION = 1;

/**
 * Per-entity safeguard: after this many UNCERTAIN evaluations on the same
 * entity, the runner may stop spending more steps on that entity and move on.
 */
export const ENTITY_UNCERTAIN_TERMINATION_STEPS = 6;

/**
 * Minimum confidence for treating an UNCERTAIN result as sufficiently stable
 * to terminate the current entity as inconclusive and continue elsewhere.
 */
export const ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE = 0.7;

/**
 * Stronger anti-loop safeguard: if the same entity keeps producing the same
 * uncertain workflow signature this many times in a row, stop or advance.
 */
export const ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS = 2;

/**
 * Maximum number of snapshot images the OpenRouter VLM adapter can include
 * in a single request.
 */
export const DEFAULT_MAX_SNAPSHOTS_PER_REQUEST = 4;

/**
 * Maximum number of characters to keep from Tavily-grounded fetched text.
 */
export const DEFAULT_TAVILY_MAX_CHARS = 20000;

/**
 * Maximum number of characters to keep from reduced Tavily/regulatory text.
 */
export const DEFAULT_REDUCED_TAVILY_MAX_CHARS = 3500;

export type PrototypeRuntimeSettings = {
  maxComplianceSteps: number;
  entityUncertainTerminationSteps: number;
  entityUncertainTerminationConfidence: number;
  maxSnapshotsPerRequest: number;
  reducedTavilyMaxChars: number;
  orbitMaxHighlightOcclusionRatio: number;
  snapshotNoveltyRedundancyThreshold: number;
  useCompactVlmContext: boolean;
};

export const DEFAULT_PROTOTYPE_RUNTIME_SETTINGS: PrototypeRuntimeSettings = {
  maxComplianceSteps: DEFAULT_MAX_COMPLIANCE_STEPS,
  entityUncertainTerminationSteps: ENTITY_UNCERTAIN_TERMINATION_STEPS,
  entityUncertainTerminationConfidence: ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE,
  maxSnapshotsPerRequest: DEFAULT_MAX_SNAPSHOTS_PER_REQUEST,
  reducedTavilyMaxChars: DEFAULT_REDUCED_TAVILY_MAX_CHARS,
  orbitMaxHighlightOcclusionRatio: 0.2,
  snapshotNoveltyRedundancyThreshold: 0.2,
  useCompactVlmContext: true,
};

const PROTOTYPE_RUNTIME_SETTING_RANGES = {
  maxComplianceSteps: { min: 5, max: 30 },
  entityUncertainTerminationSteps: { min: 3, max: 10 },
  entityUncertainTerminationConfidence: { min: 0, max: 1 },
  maxSnapshotsPerRequest: { min: 1, max: 10 },
  reducedTavilyMaxChars: { min: 500, max: 10000 },
  orbitMaxHighlightOcclusionRatio: { min: 0, max: 1 },
  snapshotNoveltyRedundancyThreshold: { min: 0, max: 1 },
} as const;

let runtimeSettings: PrototypeRuntimeSettings = { ...DEFAULT_PROTOTYPE_RUNTIME_SETTINGS };
type NumericPrototypeRuntimeSettingKey = Exclude<keyof PrototypeRuntimeSettings, "useCompactVlmContext">;

export const MAX_SNAPSHOTS_PER_REQUEST_RANGE =
  PROTOTYPE_RUNTIME_SETTING_RANGES.maxSnapshotsPerRequest;

function clampSetting<K extends keyof PrototypeRuntimeSettings>(
  key: K,
  value: PrototypeRuntimeSettings[K]
): PrototypeRuntimeSettings[K] {
  if (key === "useCompactVlmContext") {
    return Boolean(value) as PrototypeRuntimeSettings[K];
  }

  const numericKey = key as NumericPrototypeRuntimeSettingKey;
  const range = PROTOTYPE_RUNTIME_SETTING_RANGES[numericKey];
  const fallbackValue = DEFAULT_PROTOTYPE_RUNTIME_SETTINGS[numericKey];
  const numericValue =
    typeof value === "number" && Number.isFinite(value) ? value : fallbackValue;
  const clamped = Math.max(range.min, Math.min(range.max, numericValue));
  return (
    key === "entityUncertainTerminationConfidence" ||
    key === "orbitMaxHighlightOcclusionRatio" ||
    key === "snapshotNoveltyRedundancyThreshold"
      ? clamped
      : Math.round(clamped)
  ) as PrototypeRuntimeSettings[K];
}

export function getPrototypeRuntimeSettings(): PrototypeRuntimeSettings {
  return { ...runtimeSettings };
}

export function updatePrototypeRuntimeSettings(
  updates: Partial<PrototypeRuntimeSettings>
): PrototypeRuntimeSettings {
  const next = { ...runtimeSettings };
  for (const [key, value] of Object.entries(updates)) {
    const typedKey = key as keyof PrototypeRuntimeSettings;
    if (typedKey === "useCompactVlmContext") {
      next.useCompactVlmContext = clampSetting("useCompactVlmContext", value as boolean);
      continue;
    }
    const numericKey = typedKey as NumericPrototypeRuntimeSettingKey;
    next[numericKey] = clampSetting(numericKey, value as PrototypeRuntimeSettings[typeof numericKey]);
  }
  runtimeSettings = next;
  return getPrototypeRuntimeSettings();
}

export function resetPrototypeRuntimeSettings(): PrototypeRuntimeSettings {
  runtimeSettings = { ...DEFAULT_PROTOTYPE_RUNTIME_SETTINGS };
  return getPrototypeRuntimeSettings();
}

export function clampMaxSnapshotsPerRequest(value?: number): number {
  return clampSetting(
    "maxSnapshotsPerRequest",
    value ?? DEFAULT_MAX_SNAPSHOTS_PER_REQUEST
  );
}

export type HighlightAnnotationMode = "worded" | "color_legend";

/**
 * Viewer-side annotation rendering defaults for highlighted elements.
 * Note: WebGL line width support varies by platform/browser, but we still keep
 * this centralized so the prototype can evolve consistently.
 */
export const HIGHLIGHT_ANNOTATION_DEFAULTS = {
  mode: "color_legend" as HighlightAnnotationMode,
  lineWidth: 50,
  generalMarkerScale: 1,
  doorMarkerRadius: 0.12,
  doorMarkerRadiusTop: 0.075,
  cameraOverlayBias: 0.05,
} as const;

/**
 * Desired minimum screen area ratio for a focused highlighted entity in
 * snapshot-driven inspection views.
 * Example: 0.10 means roughly 10% of the image area.
 */
export const HIGHLIGHT_TARGET_AREA_RATIO = 0.03;

/**
 * Tuning for entity-focused inspection zoom.
 */
export const HIGHLIGHT_NAVIGATION_DEFAULTS = {
  targetAreaRatio: 0.03,
  maxSteps: 10,
  zoomFactor: 0.19,
  orbitDegrees: 10,
} as const;

/**
 * If focused navigation has already reached roughly this fraction of the
 * requested target area, further generic ZOOM_IN requests should usually stop.
 */
export const ZOOM_IN_EXHAUSTION_AREA_FACTOR = 0.9;

/**
 * Conservative top-view framing target used after focused/orbit navigation.
 * This keeps plan snapshots from becoming so close that the target clips or
 * fills the image, while still centering the active entity.
 */
export const TOP_VIEW_TARGET_AREA_RATIO = 0.012;

/**
 * Per-entity limit for focused ORBIT follow-ups. Orbit views are intended as
 * final confirmation angles once the target is already centered/highlighted,
 * not as an unbounded exploration loop.
 */
export const MAX_ORBIT_FOLLOW_UPS_PER_ENTITY = 3;

/**
 * Safety limit for each ORBIT angle component requested by the VLM.
 * Keep this at or below 90 degrees so one call cannot jump to a wholly unrelated view.
 */
export const MAX_ORBIT_DEGREES_PER_AXIS = 90;

/**
 * Maximum allowed estimated occlusion ratio for a highlighted object after an
 * ORBIT/NEW_VIEW confirmation move. Example: 0.2 means no more than 20%.
 */
export const ORBIT_MAX_HIGHLIGHT_OCCLUSION_RATIO =
  DEFAULT_PROTOTYPE_RUNTIME_SETTINGS.orbitMaxHighlightOcclusionRatio;

/**
 * Conservative per-entity budgets for semantic anti-cycle follow-up families.
 * These are intentionally static prototype constants so the semantic
 * stagnation logic stays easy to audit and reverse.
 */
export const SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS = {
  plan_measurement: 2,
  context_angle: 2,
  focus: 2,
  scope: 1,
  occlusion_or_context_cleanup: 1,
  regulatory_grounding: 1,
  property_measurement: 1,
} as const;

/**
 * History-aware recurrence control for same-entity view states.
 * Geometric decay keeps recent recurrences dominant while allowing older
 * same-entity states to matter less over time.
 */
export const SAME_ENTITY_RECURRENCE_DECAY = 0.75;

/**
 * Threshold above which the current same-entity snapshot is treated as a
 * recurrence of an older semantically unproductive view state.
 */
export const SAME_ENTITY_RECURRENCE_WARNING_THRESHOLD = 0.65;

/**
 * Weighted similarity model used by the same-entity recurrence score.
 * The weights sum to 1.0 and emphasize preset/camera/plan-cut similarity.
 */
export const SAME_ENTITY_RECURRENCE_WEIGHTS = {
  viewPreset: 0.22,
  camera: 0.28,
  planCut: 0.18,
  scope: 0.12,
  highlight: 0.08,
  projectedArea: 0.07,
  occlusion: 0.05,
} as const;

/**
 * Less aggressive framing profile for elongated elements like ramps.
 * The goal is to preserve the full run, top/bottom transitions, and nearby
 * context instead of filling the frame like a compact object.
 */
export const RAMP_NAVIGATION_DEFAULTS = {
  targetAreaRatio: 0.008,
  maxSteps: 8,
  zoomFactor: 0.08,
  orbitDegrees: 4,
} as const;

/**
 * Door-clearance specific framing and readiness defaults.
 */
export const DOOR_CLEARANCE_DEFAULTS = {
  focusTargetAreaRatio: 0.08,
  pullSideDepthMeters: 1.524,
  pushSideDepthMeters: 1.219,
  latchSideMeters: 0.457,
} as const;

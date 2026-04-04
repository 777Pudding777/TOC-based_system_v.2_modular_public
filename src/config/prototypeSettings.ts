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

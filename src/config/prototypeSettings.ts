// src/config/prototypeSettings.ts
// Centralized prototype tuning values for the settings

/**
 * Default maximum number of compliance-checking steps per run.
 * The runner still clamps against its hard internal upper bound.
 */
export const DEFAULT_MAX_COMPLIANCE_STEPS = 6;

/**
 * Existing repeated follow-up handling:
 * after this many identical follow-up repeats, the runner escalates
 * to a different action instead of repeating the same follow-up again.
 */
export const REPEATED_FOLLOW_UPS_BEFORE_ESCALATION = 2;

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
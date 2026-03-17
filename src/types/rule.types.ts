/**
 * src/types/rule.types.ts
 * TypeScript interfaces for the Solibri-based Rule Library
 * These types support VLM-based visual compliance checking in IFC/BIM models
 */

/**
 * Severity level of a rule violation
 */
export type RuleSeverity = 'critical' | 'moderate' | 'low';

/**
 * Category of the rule based on building domain
 */
export type RuleCategory = 
  | 'accessibility'
  | 'safety'
  | 'circulation'
  | 'egress'
  | 'building_envelope';

/**
 * Evidence that a VLM should look for when evaluating a rule
 */
export interface VisualEvidence {
  /** What to look for in the image */
  lookFor: string[];
  /** What indicates a pass */
  passIndicators: string[];
  /** What indicates a fail */
  failIndicators: string[];
  /** What indicates uncertainty requiring more investigation */
  uncertainIndicators: string[];
}

/**
 * Evaluation criteria for determining pass/fail/uncertain
 */
export interface EvaluationCriteria {
  /** Conditions that result in PASS verdict */
  pass: string[];
  /** Conditions that result in FAIL verdict */
  fail: string[];
  /** Conditions that result in UNCERTAIN verdict */
  uncertain: string[];
}

/**
 * Navigation hints to help the VLM agent find optimal viewpoints
 */
export interface NavigationHints {
  /** Recommended preset views (ISO, TOP, FRONT, etc.) */
  recommendedViews: string[];
  /** Recommended camera distance/zoom level */
  zoomLevel?: 'close' | 'medium' | 'far';
  /** Whether to isolate specific component categories */
  isolateCategories?: string[];
  /** Whether to use plan cut for better visibility */
  usePlanCut?: boolean;
  /** Recommended plan cut height if applicable */
  planCutHeight?: string;
  /** Additional navigation tips */
  tips: string[];
}

/**
 * Template for describing a finding/violation
 */
export interface FindingTemplate {
  /** Template for pass finding */
  pass: string;
  /** Template for fail finding */
  fail: string;
  /** Template for uncertain finding */
  uncertain: string;
  /** Placeholders that can be filled in the template */
  placeholders?: string[];
}

/**
 * Information about why this rule is suitable for VLM checking
 */
export interface VisualSuitability {
  /** Is this rule suitable for VLM-based visual checking? */
  isSuitable: boolean;
  /** Confidence level (0-1) that VLM can evaluate this accurately */
  confidence: number;
  /** Reasoning for suitability assessment */
  reasoning: string;
  /** What makes this rule visual vs. metadata-based */
  visualAspects: string[];
  /** Limitations or challenges for VLM evaluation */
  limitations?: string[];
}

/**
 * Reference to original Solibri rule documentation
 */
export interface RuleSource {
  /** Solibri rule ID (e.g., "SOL-208") */
  solibriId: string;
  /** Full rule title from Solibri */
  solibriTitle: string;
  /** URL to Solibri documentation */
  documentationUrl: string;
  /** Version or date of rule specification */
  version?: string;
}

/**
 * Dimensional requirements that can be checked visually
 */
export interface DimensionalRequirements {
  /** Parameter name (e.g., "Minimum Door Width") */
  parameter: string;
  /** Typical value or range (e.g., "32 inches", "800-900mm") */
  typicalValue: string;
  /** Reference standard (e.g., "ADA", "IBC 2021", "ICC A117.1") */
  referenceStandard?: string;
  /** Is this measurable from visual inspection? */
  visuallyMeasurable: boolean;
}

/**
 * Complete rule definition for VLM-based checking
 */
export interface ComplianceRule {
  /** Unique identifier for this rule in our system */
  id: string;
  /** Human-readable title */
  title: string;
  /** Natural language description of what this rule checks */
  description: string;
  /** Rule category */
  category: RuleCategory;
  /** Default severity level */
  severity: RuleSeverity;
  /** Source reference to Solibri */
  source: RuleSource;
  /** Visual suitability assessment */
  visualSuitability: VisualSuitability;
  /** What visual evidence to look for */
  visualEvidence: VisualEvidence;
  /** How to evaluate pass/fail/uncertain */
  evaluationCriteria: EvaluationCriteria;
  /** Navigation hints for optimal viewing */
  navigationHints: NavigationHints;
  /** Templates for describing findings */
  findingTemplates: FindingTemplate;
  /** Dimensional requirements (if applicable) */
  dimensionalRequirements?: DimensionalRequirements[];
  /** Tags for filtering/search */
  tags: string[];
  /** Is this rule currently active/enabled? */
  enabled: boolean;
  /** Additional notes or context */
  notes?: string;
}

/**
 * Collection of rules organized by category
 */
export interface RuleLibrary {
  /** Version of the rule library schema */
  version: string;
  /** Last updated timestamp */
  lastUpdated: string;
  /** All available rules */
  rules: ComplianceRule[];
  /** Metadata about the library */
  metadata: {
    totalRules: number;
    enabledRules: number;
    categories: RuleCategory[];
    description: string;
  };
}

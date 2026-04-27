export type EvidenceRequirementKey =
  | "targetVisible"
  | "targetFocused"
  | "planMeasurementNeeded"
  | "planMeasurementReady"
  | "contextViewNeeded"
  | "contextViewReady"
  | "obstructionContextNeeded"
  | "dimensionReferenceNeeded"
  | "regulatoryClauseNeeded"
  | "occlusionProblem"
  | "lowNoveltyOrRepeatedView"
  | "bothSidesOrSurroundingsNeeded";

export type EvidenceRequirementsStatus = Partial<Record<EvidenceRequirementKey, boolean>>;

export type EvidenceRequirementReasonMap = Partial<Record<EvidenceRequirementKey, string>>;

export interface EvidenceRequirementsSnapshot {
  status: EvidenceRequirementsStatus;
  reasons?: EvidenceRequirementReasonMap;
}

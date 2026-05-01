import type { ComplianceRule } from "../types/rule.types";

export type RegulatoryPromptSource = "rule_library" | "custom_user_prompt" | "unknown";

export type RegulatoryGroundingAssessment = {
  promptSource: RegulatoryPromptSource;
  hasUsableLocalGrounding: boolean;
  requiresExternalFetchByDefault: boolean;
  hasDimensionalThresholds: boolean;
  hasReferenceStandards: boolean;
  hasEvaluationCriteria: boolean;
};

export type RegulatoryGroundingSummary = {
  promptSource: RegulatoryPromptSource;
  hasUsableLocalGrounding: boolean;
  hasExternalWebEvidence: boolean;
  missingRegulatoryContext: boolean;
  regulatoryBasisLabel: string;
  webEvidenceLabel: string;
};

const DIMENSIONAL_THRESHOLD_PATTERN =
  /\b\d+(?:\.\d+)?\s?(?:mm|cm|m|in|ft|%)\b|\b\d+(?:\.\d+)?"/i;
const REFERENCE_STANDARD_PATTERN =
  /\b(ada|icc|ibc|a117(?:\.1)?|nfpa|din|en\s?\d+|iso\s?\d+|section|sec\.|clause|standard|code|edition)\b/i;
const CLAUSE_GAP_PATTERN =
  /\b(clause|section|threshold|standard|definition|edition|exception|reference)\b/i;
const YEAR_PATTERN = /\b(19|20)\d{2}\b/;

export function inferPromptSource(prompt: string): RegulatoryPromptSource {
  const text = String(prompt ?? "");
  if (/SOURCE:\s*RULE_LIBRARY/i.test(text)) return "rule_library";
  if (/SOURCE:\s*CUSTOM_USER_PROMPT/i.test(text)) return "custom_user_prompt";
  return "unknown";
}

function extractSourcePromptText(prompt: string): string {
  const match = String(prompt ?? "").match(
    /SOURCE_PROMPT_TEXT:\s*([\s\S]*?)(?:\n\nAllowedSources|\n\nREGULATORY_CONTEXT|\n\nDYNAMIC_CHECKLIST|$)/i
  );
  if (match?.[1]) return match[1].trim();
  return String(prompt ?? "").trim();
}

function extractRegulatoryContextBlock(prompt: string): string {
  const match = String(prompt ?? "").match(/REGULATORY_CONTEXT:\s*([\s\S]*?)(?:\n\nDYNAMIC_CHECKLIST|$)/i);
  return match?.[1]?.trim() ?? "";
}

function assessTextGrounding(text: string): Pick<
  RegulatoryGroundingAssessment,
  "hasDimensionalThresholds" | "hasReferenceStandards"
> & {
  hasClauseReference: boolean;
  hasEditionReference: boolean;
} {
  const normalized = String(text ?? "");
  return {
    hasDimensionalThresholds: DIMENSIONAL_THRESHOLD_PATTERN.test(normalized),
    hasReferenceStandards: REFERENCE_STANDARD_PATTERN.test(normalized),
    hasClauseReference: /\b(section|sec\.|clause|chapter|code)\b/i.test(normalized),
    hasEditionReference: YEAR_PATTERN.test(normalized),
  };
}

export function assessRuleRegulatoryGrounding(rule: ComplianceRule): RegulatoryGroundingAssessment {
  const joinedDimensionalText = (rule.dimensionalRequirements ?? [])
    .map((item) => `${item.parameter} ${item.typicalValue} ${item.referenceStandard ?? ""}`)
    .join(" ");
  const joinedCriteriaText = [
    ...(rule.evaluationCriteria.pass ?? []),
    ...(rule.evaluationCriteria.fail ?? []),
    ...(rule.evaluationCriteria.uncertain ?? []),
  ].join(" ");
  const joinedReferenceText = `${rule.description} ${rule.notes ?? ""} ${rule.tags.join(" ")} ${joinedDimensionalText}`;
  const textSignals = assessTextGrounding(`${joinedCriteriaText} ${joinedReferenceText}`);
  const hasEvaluationCriteria =
    Boolean(rule.evaluationCriteria.pass?.length) ||
    Boolean(rule.evaluationCriteria.fail?.length) ||
    Boolean(rule.evaluationCriteria.uncertain?.length);

  const hasUsableLocalGrounding =
    hasEvaluationCriteria || textSignals.hasDimensionalThresholds || textSignals.hasReferenceStandards;

  return {
    promptSource: "rule_library",
    hasUsableLocalGrounding,
    requiresExternalFetchByDefault: !hasUsableLocalGrounding,
    hasDimensionalThresholds: textSignals.hasDimensionalThresholds,
    hasReferenceStandards: textSignals.hasReferenceStandards,
    hasEvaluationCriteria,
  };
}

export function assessPromptRegulatoryGrounding(prompt: string): RegulatoryGroundingAssessment {
  const promptSource = inferPromptSource(prompt);
  const sourceText = extractSourcePromptText(prompt);
  const regulatoryBlock = extractRegulatoryContextBlock(prompt);
  const sourceSignals = assessTextGrounding(sourceText);
  const blockSignals = assessTextGrounding(regulatoryBlock);
  const hasEvaluationCriteria = /EVALUATION CRITERIA:/i.test(sourceText);

  if (promptSource === "rule_library") {
    const hasExplicitLocalRuleContext = /LOCAL_RULE_CONTEXT:\s*provided_from_rule_library/i.test(regulatoryBlock);
    const hasUsableLocalGrounding =
      hasExplicitLocalRuleContext ||
      hasEvaluationCriteria ||
      sourceSignals.hasDimensionalThresholds ||
      sourceSignals.hasReferenceStandards;

    return {
      promptSource,
      hasUsableLocalGrounding,
      requiresExternalFetchByDefault: !hasUsableLocalGrounding,
      hasDimensionalThresholds: sourceSignals.hasDimensionalThresholds,
      hasReferenceStandards: sourceSignals.hasReferenceStandards,
      hasEvaluationCriteria,
    };
  }

  const hasExplicitPromptGrounding = /LOCAL_PROMPT_CONTEXT:\s*user_provided_thresholds_or_clause_text/i.test(
    regulatoryBlock
  );
  const hasUsableLocalGrounding =
    hasExplicitPromptGrounding ||
    (sourceSignals.hasDimensionalThresholds &&
      (sourceSignals.hasReferenceStandards || sourceSignals.hasClauseReference || sourceSignals.hasEditionReference)) ||
    (blockSignals.hasDimensionalThresholds &&
      (blockSignals.hasReferenceStandards || blockSignals.hasClauseReference || blockSignals.hasEditionReference));

  return {
    promptSource,
    hasUsableLocalGrounding,
    requiresExternalFetchByDefault: !hasUsableLocalGrounding,
    hasDimensionalThresholds: sourceSignals.hasDimensionalThresholds || blockSignals.hasDimensionalThresholds,
    hasReferenceStandards: sourceSignals.hasReferenceStandards || blockSignals.hasReferenceStandards,
    hasEvaluationCriteria: false,
  };
}

export function buildRegulatoryContextBlock(args: {
  prompt: string;
  regulatoryContext: string;
}): string {
  const assessment = assessPromptRegulatoryGrounding(args.prompt);
  const externalContext = String(args.regulatoryContext ?? "").trim();
  const externalBlock = externalContext ? ["", externalContext] : [];

  if (assessment.promptSource === "rule_library" && assessment.hasUsableLocalGrounding) {
    return [
      "LOCAL_RULE_CONTEXT: provided_from_rule_library",
      "WEB_FETCH_REQUIRED: false unless local rule thresholds are insufficient",
      "REGULATORY_BASIS: local interpreted ruleLibrary entry",
      `EXTERNAL_WEB_EVIDENCE: ${externalContext ? "attached_below" : "none_fetched"}`,
      "DISTINCTION_NOTE: absence of external web evidence does not mean absence of regulatory context",
      ...externalBlock,
    ].join("\n");
  }

  if (assessment.promptSource === "rule_library") {
    return [
      "LOCAL_RULE_CONTEXT: present_but_insufficient_for_complete_grounding",
      "WEB_FETCH_REQUIRED: true if local rule thresholds, definitions, or exceptions remain insufficient",
      "REGULATORY_BASIS: ruleLibrary entry requires supplemental clause grounding",
      `EXTERNAL_WEB_EVIDENCE: ${externalContext ? "attached_below" : "none_fetched"}`,
      ...externalBlock,
    ].join("\n");
  }

  if (assessment.promptSource === "custom_user_prompt" && assessment.hasUsableLocalGrounding) {
    return [
      "LOCAL_PROMPT_CONTEXT: user_provided_thresholds_or_clause_text",
      "WEB_FETCH_REQUIRED: false unless prompt-supplied grounding is still insufficient",
      "REGULATORY_BASIS: custom prompt supplied local grounding",
      `EXTERNAL_WEB_EVIDENCE: ${externalContext ? "attached_below" : "none_fetched"}`,
      ...externalBlock,
    ].join("\n");
  }

  if (externalContext) {
    return [
      "LOCAL_PROMPT_CONTEXT: none_authoritative",
      "WEB_FETCH_REQUIRED: satisfied_for_current_step",
      "REGULATORY_BASIS: external web evidence",
      "EXTERNAL_WEB_EVIDENCE: attached_below",
      "",
      externalContext,
    ].join("\n");
  }

  return [
    "REGULATORY_STATUS: no_authoritative_regulatory_context_provided_or_fetched_yet",
    "WEB_FETCH_REQUIRED: true only if clause text, thresholds, or definitions are missing",
    "REGULATORY_BASIS: pending",
    "EXTERNAL_WEB_EVIDENCE: none_fetched",
  ].join("\n");
}

export function summarizePromptRegulatoryGrounding(args: {
  promptText: string;
  promptSource?: RegulatoryPromptSource;
  hasExternalWebEvidence?: boolean;
}): RegulatoryGroundingSummary {
  const assessment = assessPromptRegulatoryGrounding(args.promptText);
  const promptSource = args.promptSource ?? assessment.promptSource;
  const regulatoryBlock = extractRegulatoryContextBlock(args.promptText);
  const hasExternalWebEvidence =
    Boolean(args.hasExternalWebEvidence) || /WEB_EVIDENCE:/i.test(regulatoryBlock) || /EXTERNAL_WEB_EVIDENCE:\s*attached_below/i.test(regulatoryBlock);

  if (promptSource === "rule_library" && assessment.hasUsableLocalGrounding) {
    return {
      promptSource,
      hasUsableLocalGrounding: true,
      hasExternalWebEvidence,
      missingRegulatoryContext: false,
      regulatoryBasisLabel: "Local ruleLibrary context",
      webEvidenceLabel: hasExternalWebEvidence ? "Fetched and injected" : "None fetched",
    };
  }

  if (promptSource === "rule_library") {
    return {
      promptSource,
      hasUsableLocalGrounding: false,
      hasExternalWebEvidence,
      missingRegulatoryContext: !hasExternalWebEvidence,
      regulatoryBasisLabel: hasExternalWebEvidence
        ? "RuleLibrary context supplemented by web evidence"
        : "RuleLibrary context present but supplemental clause grounding is still needed",
      webEvidenceLabel: hasExternalWebEvidence ? "Fetched and injected" : "None fetched",
    };
  }

  if (assessment.hasUsableLocalGrounding) {
    return {
      promptSource,
      hasUsableLocalGrounding: true,
      hasExternalWebEvidence,
      missingRegulatoryContext: false,
      regulatoryBasisLabel: "Prompt-provided local thresholds or clause text",
      webEvidenceLabel: hasExternalWebEvidence ? "Fetched and injected" : "None fetched",
    };
  }

  if (hasExternalWebEvidence) {
    return {
      promptSource,
      hasUsableLocalGrounding: false,
      hasExternalWebEvidence: true,
      missingRegulatoryContext: false,
      regulatoryBasisLabel: "External web evidence",
      webEvidenceLabel: "Fetched and injected",
    };
  }

  return {
    promptSource,
    hasUsableLocalGrounding: false,
    hasExternalWebEvidence: false,
    missingRegulatoryContext: true,
    regulatoryBasisLabel: "Missing regulatory context",
    webEvidenceLabel: "None fetched",
  };
}

export function hasExplicitRegulatoryGapText(values: Array<string | undefined>): boolean {
  return values.some((value) => CLAUSE_GAP_PATTERN.test(String(value ?? "")));
}

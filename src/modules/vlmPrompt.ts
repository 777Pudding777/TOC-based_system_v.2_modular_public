// src/modules/vlmPrompt.ts
import type { EvidenceView, VlmFollowUp, VlmVerdict } from "./vlmChecker";

export type VlmDecisionJson = {
  verdict: VlmVerdict;
  confidence: number; // 0..1
  rationale: string;

  // Separate: VLM describes what it can/can't see; it must refer to nav metrics if provided.
  visibility: {
    isRuleTargetVisible: boolean;
    occlusionAssessment: "LOW" | "MEDIUM" | "HIGH";
    missingEvidence?: string[];
  };

  followUp?: VlmFollowUp;

  evidence: {
    snapshotIds: string[]; // must equal the input evidence order (subset allowed but must be from list)
    note?: string;
  };
};

export function buildDeterministicVlmPrompt(args: {
  ruleText: string;
  evidenceViews: EvidenceView[];
  allowedFollowUps: VlmFollowUp["request"][];
  step: number;
  maxSteps: number;
  minConfidence: number;
}) {
  // Deterministic JSON payload (stable key ordering by construction)
  const payload = {
    ruleText: args.ruleText,
    step: args.step,
    maxSteps: args.maxSteps,
    minConfidence: args.minConfidence,
    evidenceViews: args.evidenceViews.map(v => ({
      snapshotId: v.snapshotId,
      mode: v.mode,
      note: v.note ?? "",
      nav: v.nav ?? null, // nav metrics come from navigation, not the VLM
    })),
    allowedFollowUps: args.allowedFollowUps,
    outputSchema: {
      verdict: ["PASS", "FAIL", "UNCERTAIN"],
      confidence: "number(0..1)",
      rationale: "string",
      visibility: {
        isRuleTargetVisible: "boolean",
        occlusionAssessment: ["LOW", "MEDIUM", "HIGH"],
        missingEvidence: "string[] optional",
      },
      followUp: "optional VlmFollowUp",
      evidence: {
        snapshotIds: "string[] from evidenceViews.snapshotId",
        note: "string optional",
      },
    },
  };

  // Provider-agnostic instruction block: no tool calls assumed.
  // Determinism rules: no extra keys, JSON only, no markdown, no explanations outside JSON.
  const system = [
    "You are a compliance vision-language model for IFC model snapshots.",
    "Return ONLY valid JSON. No markdown. No extra keys.",
    "Be deterministic: use ONLY the provided ruleText + evidenceViews + nav metrics.",
    "Do NOT infer hidden geometry. If something is not visible or is occluded, say UNCERTAIN and request a follow-up.",
    "Navigation metrics (projectedAreaRatio, occlusionRatio, convergenceScore) are authoritative for visibility/occlusion; do not guess them.",
    "Choose verdict:",
    "- PASS: rule clearly satisfied in visible evidence.",
    "- FAIL: rule clearly violated in visible evidence.",
    "- UNCERTAIN: evidence insufficient/occluded/ambiguous.",
    "Confidence meaning:",
    "- 0.0 = no confidence, 1.0 = absolute confidence.",
    "If verdict is UNCERTAIN OR confidence < minConfidence, request exactly one followUp from allowedFollowUps when helpful.",
    "If no followUp would help, omit followUp.",
    "For ISOLATE_CATEGORY, always use IFC class names like IfcDoor, IfcStair, IfcSlab (not “doors”, “stairs”).",
    "For NAVIGATE_TO, do not invent locations; only request if you think a better view would help.",
    "In evidence.note, briefly explain which parts of the evidence were most relevant to your decision.",
  ].join("\n");

  const user = JSON.stringify(payload);

  return { system, user };
}

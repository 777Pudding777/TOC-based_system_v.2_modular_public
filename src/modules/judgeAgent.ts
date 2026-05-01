// src/modules/judgeAgent.ts
import { summarizePromptRegulatoryGrounding } from "./regulatoryContext";
// Fresh secondary judge pass over the completed primary VLM evidence bundle.

import type {
  ConversationTrace,
  JudgeConfidenceAssessment,
  JudgeEvidenceSupport,
  JudgeRecommendedCorrection,
  JudgeReport,
  JudgeTaskVerdict,
} from "../types/trace.types";

type JudgeProviderConfig =
  | { provider: "mock" }
  | {
      provider: "openai";
      openai: {
        apiKey?: string;
        model?: string;
        endpoint?: string;
        requestTimeoutMs?: number;
      };
    }
  | {
      provider: "openrouter";
      openrouter: {
        apiKey?: string;
        model?: string;
        endpoint?: string;
        requestTimeoutMs?: number;
        appTitle?: string;
        appReferer?: string;
      };
    };

type JudgeImage = {
  snapshotId: string;
  dataUrl: string;
};

const MAX_TEXT_FIELD_CHARS = 450;
const MAX_PROMPT_EXCERPT_CHARS = 700;
const MAX_WEB_EVIDENCE_CHARS = 800;

function clamp01(value: unknown): number {
  const n = typeof value === "number" && isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeVerdict(value: unknown): "PASS" | "FAIL" | "UNCERTAIN" {
  return value === "PASS" || value === "FAIL" || value === "UNCERTAIN" ? value : "UNCERTAIN";
}

function normalizeEvidenceSupport(value: unknown): JudgeEvidenceSupport {
  return value === "SUPPORTED" || value === "PARTIALLY_SUPPORTED" || value === "UNSUPPORTED"
    ? value
    : "PARTIALLY_SUPPORTED";
}

function normalizeConfidenceAssessment(value: unknown): JudgeConfidenceAssessment {
  return value === "JUSTIFIED" || value === "OVERCONFIDENT" || value === "UNDERCONFIDENT"
    ? value
    : "JUSTIFIED";
}

function normalizeRecommendedCorrection(value: unknown): JudgeRecommendedCorrection | undefined {
  return value === "KEEP" || value === "DOWNGRADE_TO_UNCERTAIN" || value === "REVIEW_REQUIRED"
    ? value
    : undefined;
}

function normalizeStringArray(value: unknown, maxItems = 4, maxChars = 220): string[] {
  return Array.isArray(value)
    ? value.map((item) => truncateText(item, maxChars)).filter(Boolean).slice(0, maxItems)
    : [];
}

function normalizeTaskVerdicts(value: unknown): JudgeTaskVerdict[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).map((item: any, index) => ({
    taskLabel: truncateText(item?.taskLabel ?? `Task ${index + 1}`, 120),
    entityId: typeof item?.entityId === "string" ? item.entityId : undefined,
    stepStart: typeof item?.stepStart === "number" && isFinite(item.stepStart) ? item.stepStart : undefined,
    stepEnd: typeof item?.stepEnd === "number" && isFinite(item.stepEnd) ? item.stepEnd : undefined,
    verdict: normalizeVerdict(item?.verdict),
    confidence: clamp01(item?.confidence),
    reasoning: truncateText(item?.reasoning, 280),
    evidenceSnapshotIds: normalizeStringArray(item?.evidenceSnapshotIds, 4, 80),
  }));
}

function getLatestPrimaryDecision(trace: ConversationTrace) {
  return trace.responses[trace.responses.length - 1]?.decision;
}

function getDecisionMissingEvidence(trace: ConversationTrace): string[] {
  const decision = getLatestPrimaryDecision(trace);
  return Array.from(
    new Set([...(decision?.missingEvidence ?? []), ...(decision?.visibility?.missingEvidence ?? [])].map(String))
  );
}

function hasRegulatoryEvidence(trace: ConversationTrace): boolean {
  return (trace.webEvidence ?? []).some((entry) => entry.ok && Boolean(entry.reducedText ?? entry.text));
}

function listPendingEvidenceRequirements(trace: ConversationTrace): string[] {
  const status = getLatestPrimaryDecision(trace)?.evidenceRequirementsStatus ?? {};
  const pending: string[] = [];
  const latestPrompt = trace.prompts[trace.prompts.length - 1];
  const regulatoryGrounding = summarizePromptRegulatoryGrounding({
    promptText: latestPrompt?.promptText ?? "",
    promptSource: latestPrompt?.promptSource,
    hasExternalWebEvidence: hasRegulatoryEvidence(trace),
  });

  if (status.contextViewNeeded === true && status.contextViewReady === false) pending.push("Context view required but not ready.");
  if (status.planMeasurementNeeded === true && status.planMeasurementReady === false) {
    pending.push("Plan measurement evidence required but not ready.");
  }
  if (status.regulatoryClauseNeeded === true && !hasRegulatoryEvidence(trace)) {
    pending.push(
      regulatoryGrounding.hasUsableLocalGrounding
        ? "Supplemental external regulatory clause evidence was required but absent."
        : "Authoritative regulatory grounding was required but absent."
    );
  }
  if (status.dimensionReferenceNeeded === true) pending.push("Dimension reference evidence is still required.");
  if (status.obstructionContextNeeded === true && status.occlusionProblem === true) {
    pending.push("Occlusion or obstruction context remains unresolved.");
  }
  if (status.bothSidesOrSurroundingsNeeded === true) pending.push("Both sides or surrounding context are still required.");
  if (status.targetVisible === false) pending.push("Primary target was not clearly visible.");
  if (status.targetFocused === false) pending.push("Primary target was not sufficiently focused.");

  return pending.slice(0, 6);
}

function buildFallbackEvidenceCritique(trace: ConversationTrace): Pick<
  JudgeReport,
  "evidenceSupport" | "confidenceAssessment" | "contradictionFlags" | "recommendedCorrection"
> {
  const decision = getLatestPrimaryDecision(trace);
  const verdict = decision?.verdict ?? trace.finalVerdict ?? "UNCERTAIN";
  const confidence = clamp01(decision?.confidence ?? trace.finalConfidence ?? 0.5);
  const missingEvidence = getDecisionMissingEvidence(trace);
  const citedSnapshotIds = decision?.evidence?.snapshotIds ?? [];
  const availableSnapshotIds = new Set(trace.snapshots.map((snapshot) => snapshot.snapshotId));
  const missingCitations = citedSnapshotIds.filter((id) => !availableSnapshotIds.has(id));
  const contradictionFlags: string[] = [];

  // CRITIC-inspired verification fallback: verify the primary claim directly
  // against the recorded trace evidence bundle when structured judge output is incomplete.
  if (verdict !== "UNCERTAIN" && citedSnapshotIds.length === 0) {
    contradictionFlags.push("Primary verdict cites no supporting snapshot IDs.");
  }
  if (missingCitations.length) {
    contradictionFlags.push(`Primary verdict cites snapshot IDs missing from trace: ${missingCitations.join(", ")}.`);
  }
  if (verdict !== "UNCERTAIN" && missingEvidence.length) {
    contradictionFlags.push(`Primary verdict leaves unresolved missing evidence: ${missingEvidence.slice(0, 3).join(", ")}.`);
  }
  contradictionFlags.push(...listPendingEvidenceRequirements(trace));

  const uniqueFlags = Array.from(new Set(contradictionFlags)).slice(0, 6);

  let evidenceSupport: JudgeEvidenceSupport = "SUPPORTED";
  if (!decision || (verdict !== "UNCERTAIN" && citedSnapshotIds.length === 0) || missingCitations.length) {
    evidenceSupport = "UNSUPPORTED";
  } else if (uniqueFlags.length || missingEvidence.length || verdict === "UNCERTAIN") {
    evidenceSupport = "PARTIALLY_SUPPORTED";
  }

  let confidenceAssessment: JudgeConfidenceAssessment = "JUSTIFIED";
  if (
    confidence >= 0.75 &&
    (evidenceSupport !== "SUPPORTED" || missingEvidence.length > 0 || uniqueFlags.length > 0)
  ) {
    confidenceAssessment = "OVERCONFIDENT";
  } else if (confidence <= 0.35 && evidenceSupport === "SUPPORTED" && uniqueFlags.length === 0) {
    confidenceAssessment = "UNDERCONFIDENT";
  }

  let recommendedCorrection: JudgeRecommendedCorrection = "KEEP";
  if (verdict !== "UNCERTAIN" && (evidenceSupport === "UNSUPPORTED" || confidenceAssessment === "OVERCONFIDENT")) {
    recommendedCorrection = "DOWNGRADE_TO_UNCERTAIN";
  } else if (uniqueFlags.length) {
    recommendedCorrection = "REVIEW_REQUIRED";
  }

  return {
    evidenceSupport,
    confidenceAssessment,
    contradictionFlags: uniqueFlags,
    recommendedCorrection,
  };
}

function normalizeJudgeReport(
  parsed: any,
  trace: ConversationTrace,
  fallback: Pick<JudgeReport, "provider" | "modelId">
): JudgeReport {
  const critiqueFallback = buildFallbackEvidenceCritique(trace);
  return {
    createdAtIso: new Date().toISOString(),
    provider: fallback.provider,
    modelId: fallback.modelId,
    verdict: normalizeVerdict(parsed?.verdict),
    confidence: clamp01(parsed?.confidence),
    rationale: truncateText(parsed?.rationale, 700),
    taskVerdicts: normalizeTaskVerdicts(parsed?.taskVerdicts),
    suggestionsForUser: normalizeStringArray(parsed?.suggestionsForUser, 4, 240),
    debuggingAndSuggestions: {
      primaryDecisionAssessment: truncateText(parsed?.debuggingAndSuggestions?.primaryDecisionAssessment, 450),
      possibleMistakes: normalizeStringArray(parsed?.debuggingAndSuggestions?.possibleMistakes, 4, 220),
      capabilityNotes: normalizeStringArray(parsed?.debuggingAndSuggestions?.capabilityNotes, 3, 220),
      improvementSuggestions: normalizeStringArray(parsed?.debuggingAndSuggestions?.improvementSuggestions, 4, 220),
    },
    evidenceSupport: normalizeEvidenceSupport(parsed?.evidenceSupport ?? critiqueFallback.evidenceSupport),
    confidenceAssessment: normalizeConfidenceAssessment(
      parsed?.confidenceAssessment ?? critiqueFallback.confidenceAssessment
    ),
    contradictionFlags: normalizeStringArray(parsed?.contradictionFlags ?? critiqueFallback.contradictionFlags, 6, 220),
    recommendedCorrection: normalizeRecommendedCorrection(
      parsed?.recommendedCorrection ?? critiqueFallback.recommendedCorrection
    ),
  };
}

function ensureDataUrl(base64: string): string {
  return base64.startsWith("data:image/") ? base64 : `data:image/png;base64,${base64}`;
}

function collectImages(trace: ConversationTrace): JudgeImage[] {
  const citedIds = new Set<string>();
  for (const response of trace.responses) {
    for (const id of response.decision.evidence?.snapshotIds ?? []) {
      citedIds.add(id);
    }
  }

  const cited = trace.snapshots.filter((snapshot) => citedIds.has(snapshot.snapshotId) && Boolean(snapshot.imageBase64));
  const fallback = trace.snapshots.filter((snapshot) => Boolean(snapshot.imageBase64));
  const images = cited.length ? cited : fallback;

  return images
    .map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      dataUrl: ensureDataUrl(String(snapshot.imageBase64)),
    }));
}

function truncateText(value: unknown, maxChars = MAX_TEXT_FIELD_CHARS): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}... [truncated]` : text;
}

function parseChecklistValue(promptText: string, key: string): string | undefined {
  const match = String(promptText ?? "").match(new RegExp(`^${key}=([^\\n]+)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function getStepActiveEntity(trace: ConversationTrace, step: number): string | undefined {
  const prompt = trace.prompts.find((item) => item.step === step);
  const entity = parseChecklistValue(prompt?.promptText ?? "", "activeEntity");
  return entity && entity !== "none" ? entity : undefined;
}

function promptExcerpt(promptText: string): string {
  const sourceMatch = promptText.match(/SOURCE_PROMPT_TEXT:\s*([\s\S]*?)(?:\n\nDYNAMIC_CHECKLIST|\n\nAllowedSources|\n\nREGULATORY_CONTEXT|$)/i);
  const regulatoryMatch = promptText.match(/REGULATORY_CONTEXT:\s*([\s\S]*?)(?:\n\nDYNAMIC_CHECKLIST|$)/i);
  return [
    sourceMatch?.[1] ? `sourceRule: ${truncateText(sourceMatch[1], MAX_PROMPT_EXCERPT_CHARS)}` : "",
    regulatoryMatch?.[1] ? `regulatoryContext: ${truncateText(regulatoryMatch[1], MAX_PROMPT_EXCERPT_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function compactTraceForJudge(trace: ConversationTrace) {
  const promptByStep = new Map(trace.prompts.map((prompt) => [prompt.step, prompt]));
  const judgeImages = collectImages(trace);
  const judgeImageIds = new Set(judgeImages.map((image) => image.snapshotId));
  const latestPrompt = trace.prompts[trace.prompts.length - 1];
  const latestDecision = getLatestPrimaryDecision(trace);
  const latestMissingEvidence = getDecisionMissingEvidence(trace);
  const regulatoryGrounding = summarizePromptRegulatoryGrounding({
    promptText: latestPrompt?.promptText ?? "",
    promptSource: latestPrompt?.promptSource,
    hasExternalWebEvidence: hasRegulatoryEvidence(trace),
  });

  return {
    reviewInstructions: {
      sourceOfTruth:
        "Attached snapshots, cited snapshot IDs, rule/regulatory excerpt, and concrete evidence notes. Primary verdicts are claims to audit, not facts.",
      omittedAsNoise:
        "Camera poses, target coordinates, navigation metrics, scene states, and full raw prompts were removed.",
    },
    rule: {
      title: trace.rule.title,
      description: truncateText(trace.rule.description, 900),
      category: trace.rule.category,
    },
    ruleExcerpt: latestPrompt ? promptExcerpt(latestPrompt.promptText) : "",
    regulatoryGrounding: {
      basis: regulatoryGrounding.regulatoryBasisLabel,
      webEvidence: regulatoryGrounding.webEvidenceLabel,
      promptSource: regulatoryGrounding.promptSource,
      hasUsableLocalGrounding: regulatoryGrounding.hasUsableLocalGrounding,
      missingRegulatoryContext: regulatoryGrounding.missingRegulatoryContext,
      distinction:
        "Local ruleLibrary context counts as regulatory grounding for predefined checks even when no external web evidence was fetched.",
    },
    primaryClaimsToAudit: {
      verdict: latestDecision?.verdict ?? trace.finalVerdict,
      confidence: latestDecision?.confidence ?? trace.finalConfidence,
      rationale: truncateText(latestDecision?.rationale ?? trace.finalRationale),
      citedSnapshotIds: latestDecision?.evidence?.snapshotIds ?? [],
      missingEvidence: latestMissingEvidence.slice(0, 5),
      evidenceRequirementsStatus: latestDecision?.evidenceRequirementsStatus ?? {},
    },
    decisionClaims: trace.responses.slice(-6).map((response) => {
      const prompt = promptByStep.get(response.step);
      const decision = response.decision;
      return {
        step: response.step,
        activeTask: parseChecklistValue(prompt?.promptText ?? "", "activeTask"),
        activeEntity: parseChecklistValue(prompt?.promptText ?? "", "activeEntity"),
        activeStorey: parseChecklistValue(prompt?.promptText ?? "", "activeStorey"),
        primaryClaim: `${decision.verdict} (${Math.round((decision.confidence ?? 0) * 100)}%)`,
        primaryRationale: truncateText(decision.rationale, 350),
        missingEvidence: Array.from(
          new Set([...(decision.missingEvidence ?? []), ...(decision.visibility?.missingEvidence ?? [])])
        )
          .map((item) => truncateText(item, 220))
          .slice(0, 4),
        evidenceRequirementsStatus: decision.evidenceRequirementsStatus ?? {},
        webSourcesUsed: (prompt?.webSourcesUsed ?? []).slice(0, 3),
        evidence: {
          snapshotIds: decision.evidence?.snapshotIds ?? [],
          note: truncateText(decision.evidence?.note, 320),
        },
      };
    }),
    snapshots: trace.snapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      note: truncateText(snapshot.reason, 220),
      imageAttached: judgeImageIds.has(snapshot.snapshotId),
    })),
    regulatoryEvidence: (trace.webEvidence ?? [])
      .filter((entry) => entry.ok)
      .slice(-3)
      .map((entry) => ({
        title: entry.title,
        url: entry.url,
        excerpt: truncateText(entry.reducedText ?? entry.text, MAX_WEB_EVIDENCE_CHARS),
      })),
    regulatoryEvidenceSummary: {
      requiredByPrimary: latestDecision?.evidenceRequirementsStatus?.regulatoryClauseNeeded === true,
      availableCount: (trace.webEvidence ?? []).filter((entry) => entry.ok).length,
      pendingEvidenceRequirements: listPendingEvidenceRequirements(trace),
    },
  };
}

function buildCompactJudgePrompt(trace: ConversationTrace): string {
  const outputShape = {
    verdict: "UNCERTAIN",
    confidence: 0.5,
    rationale: "Short evidence-grounded verdict explanation.",
    taskVerdicts: [
      {
        taskLabel: "Task 1",
        entityId: "",
        verdict: "UNCERTAIN",
        confidence: 0.5,
        reasoning: "Short evidence-grounded task/entity explanation.",
        evidenceSnapshotIds: [],
      },
    ],
    suggestionsForUser: ["Manual check location/action."],
    debuggingAndSuggestions: {
      primaryDecisionAssessment: "Whether primary claims were justified.",
      possibleMistakes: [],
      capabilityNotes: [],
      improvementSuggestions: [],
    },
    evidenceSupport: "PARTIALLY_SUPPORTED",
    confidenceAssessment: "JUSTIFIED",
    contradictionFlags: ["Short evidence contradiction or unresolved requirement."],
    recommendedCorrection: "KEEP",
  };

  return [
    "You are the secondary JUDGE agent for a BIM compliance inspection.",
    "Source of truth: attached snapshots, rule/regulatory excerpt, snapshot notes, and concrete evidence notes.",
    "Primary VLM verdicts are CLAIMS TO AUDIT, not facts. Re-evaluate them from evidence and disagree when needed.",
    "CRITIC-inspired verification logic: explicitly verify whether the primary claim is actually supported by the trace bundle before accepting it.",
    "You may estimate measurements from visible references: each primary viewer grid cell is 1 m x 1 m, and visible HUD/object dimensions are explicit measurement evidence. Use pixel proportions against those references when helpful, and state uncertainty if the view is too distorted.",
    "Ignore missing low-level viewer data: camera coordinates, target positions, navigation metrics, scene states, and raw prompts were intentionally removed as noise.",
    "Distinguish three regulatory states: local ruleLibrary context, fetched external web evidence, and genuinely missing regulatory context.",
    "For SOURCE: RULE_LIBRARY checks, absence of web evidence does not mean absence of regulatory grounding if local ruleLibrary context was already provided.",
    "Return ONLY one valid minified JSON object. No markdown, no code fences, no prose outside JSON.",
    "Keep it concise: rationale <= 90 words; max 4 taskVerdicts; each reasoning <= 35 words; max 3 suggestions; max 3 possibleMistakes.",
    "EVIDENCE_CRITIQUE:",
    "1) Check whether the primary verdict is supported by the cited snapshot IDs and attached images.",
    "2) Check whether missingEvidence or evidenceRequirementsStatus contradict the primary verdict.",
    "3) Check whether regulatory grounding was genuinely missing, or whether local ruleLibrary context already covered the requirement without fetched web evidence.",
    "4) Check whether the primary confidence is justified by the actual evidence strength.",
    "5) Set evidenceSupport to SUPPORTED, PARTIALLY_SUPPORTED, or UNSUPPORTED.",
    "6) Set confidenceAssessment to JUSTIFIED, OVERCONFIDENT, or UNDERCONFIDENT.",
    "7) Fill contradictionFlags with short concrete contradictions or unresolved evidence gaps.",
    "8) Set recommendedCorrection to KEEP, DOWNGRADE_TO_UNCERTAIN, or REVIEW_REQUIRED.",
    "9) If evidence is weak or contradictory, prefer UNCERTAIN over preserving a confident PASS or FAIL.",
    "JSON_SHAPE:",
    JSON.stringify(outputShape),
    "EVIDENCE_PACKET_JSON:",
    JSON.stringify(compactTraceForJudge(trace)),
  ].join("\n");
}

function buildJudgePrompt(trace: ConversationTrace): string {
  return buildCompactJudgePrompt(trace);
  return [
"You are the secondary JUDGE agent for a BIM compliance inspection.",
"You are a fresh, stateless call and must not assume or rely on any prior conversation history.",
"You must evaluate strictly and exclusively based on the provided evidence, structured data, and attached snapshot images. Do NOT infer, assume, or introduce information that is not explicitly present.",
"You must resolve ambiguity where possible: if the primary VLM hesitated or avoided a conclusion, you are required to make the most evidence-supported judgment. Only return UNCERTAIN when evidence is genuinely insufficient, and explicitly state what is missing.",
"For entity/task-based checks, evaluate each identifiable entity or task independently and consistently. Do not merge unrelated entities or skip partially evaluable ones.",
"Maintain strict evidence-grounding: every verdict, confidence score, and explanation must directly correspond to provided compliance evidence, cited snapshot IDs, extracted properties, and regulatory excerpts.",
"Do not ask for or rely on low-level camera coordinates, target positions, navigation metrics, or viewer internals; these were intentionally removed as noise.",
"Confidence must reflect evidential strength (not intuition):\n- High (0.75–1.0): clear, direct, and sufficient evidence\n- Medium (0.4–0.74): partial or indirect evidence\n- Low (0.0–0.39): weak or minimal evidence",
"Do NOT repeat or paraphrase the primary VLM blindly—critically evaluate it.",
"Return ONLY one valid JSON object. Do not use markdown, code fences, comments, trailing commas, or TypeScript syntax.",
"Use this exact JSON key structure:",
JSON.stringify(
  {
    verdict: "UNCERTAIN",
    confidence: 0.5,
    rationale: "Evidence-grounded overall verdict explanation.",
    taskVerdicts: [
      {
        taskLabel: "Task 1",
        entityId: "optional entity id or empty string",
        verdict: "UNCERTAIN",
        confidence: 0.5,
        reasoning: "Evidence-grounded task/entity explanation.",
        evidenceSnapshotIds: ["snapshot id"],
      },
    ],
    suggestionsForUser: ["Manual inspection suggestion with reason."],
    debuggingAndSuggestions: {
      primaryDecisionAssessment: "Assessment of whether the primary VLM decisions were justified.",
      possibleMistakes: ["Potential primary VLM mistake, or empty array if none."],
      capabilityNotes: ["Capability limitation or note."],
      improvementSuggestions: ["Concrete improvement suggestion."],
    },
  },
  null,
  2
),
"Required content:",
"1) Verdict: Produce a final, evidence-based judgment using all provided pre-report data. Resolve uncertainty where possible.",
"2) Suggestions for the user: Provide concrete, actionable guidance on where and how the user can manually verify or complete unresolved checks (e.g., specific views, elements, or properties to inspect).",
"3) Debugging and suggestions: Critically assess whether the primary VLM decisions were justified based on evidence, identify likely errors or weak reasoning, and evaluate whether a better judgment could have been achieved within the agent’s capabilities.",
"",
"PRE_REPORT_EVIDENCE_JSON:",
    JSON.stringify(compactTraceForJudge(trace), null, 2),
  ].join("\n");
}

function coerceAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as any;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (typeof p.output_text === "string") return p.output_text;
          if (p.json && typeof p.json === "object") return JSON.stringify(p.json);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    const c = content as any;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
    if (typeof c.output_text === "string") return c.output_text;
    if (c.json && typeof c.json === "object") return JSON.stringify(c.json);
  }
  return "";
}

function pickOpenRouterAssistantContent(responseJson: any): unknown {
  const choice = responseJson?.choices?.[0];
  const message = choice?.message;
  const toolCallArgs = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .map((toolCall: any) => toolCall?.function?.arguments)
        .find((args: unknown) => args !== undefined && args !== null)
    : undefined;

  return (
    message?.parsed ??
    message?.json ??
    toolCallArgs ??
    message?.content ??
    message?.reasoning ??
    choice?.text ??
    ""
  );
}

function extractJson(text: string): any | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const tagged = trimmed.match(/<json>\s*([\s\S]*?)\s*<\/json>/i)?.[1]?.trim();
  const candidates = [trimmed, fenced, tagged].filter((item): item is string => Boolean(item));
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function parseModelJson(content: unknown): any | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const direct = content as any;
    if (direct.verdict || direct.rationale || direct.debuggingAndSuggestions) return direct;
    if (direct.json && typeof direct.json === "object") return direct.json;
  }

  const text = coerceAssistantText(content);
  return text ? extractJson(text) : null;
}

function inferVerdictFromText(text: string, fallback: ConversationTrace): "PASS" | "FAIL" | "UNCERTAIN" {
  const upper = text.toUpperCase();
  const explicit = upper.match(/\b(VERDICT|JUDGE VERDICT|FINAL VERDICT)\s*[:=-]\s*(PASS|FAIL|UNCERTAIN)\b/);
  if (explicit?.[2]) return normalizeVerdict(explicit[2]);
  if (/\bFAIL\b/.test(upper)) return "FAIL";
  if (/\bPASS\b/.test(upper)) return "PASS";
  if (/\bUNCERTAIN\b/.test(upper)) return "UNCERTAIN";
  return fallback.finalVerdict ?? "UNCERTAIN";
}

function inferConfidenceFromText(text: string, fallback: ConversationTrace): number {
  const percent = text.match(/\bconfidence\s*[:=-]?\s*(\d{1,3})\s*%/i);
  if (percent?.[1]) return clamp01(Number(percent[1]) / 100);
  const decimal = text.match(/\bconfidence\s*[:=-]?\s*(0?\.\d+|1(?:\.0+)?)\b/i);
  if (decimal?.[1]) return clamp01(Number(decimal[1]));
  return clamp01(fallback.finalConfidence ?? 0.5);
}

function splitSentences(text: string, maxItems: number): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function looksLikeFailedJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /"taskVerdicts"|"debuggingAndSuggestions"|"suggestionsForUser"/.test(trimmed);
}

function summarizeFallbackRationale(text: string, trace: ConversationTrace): string {
  if (!text) {
    return trace.finalRationale
      ? `Judge delivery failed. Primary claim retained for review: ${truncateText(trace.finalRationale, 220)}`
      : "Judge delivery failed and no parseable judge rationale was available.";
  }

  if (looksLikeFailedJson(text)) {
    return (
      "Judge returned malformed or truncated JSON, so raw output was hidden from the report. " +
      "Use the primary evidence snapshots and rule excerpt below to manually audit the primary claims."
    );
  }

  return truncateText(splitSentences(text, 2).join(" "), 450);
}

function synthesizeJudgeReportFromText(args: {
  trace: ConversationTrace;
  provider: string;
  modelId: string;
  content: unknown;
  repairError?: unknown;
}): JudgeReport {
  const text = coerceAssistantText(args.content).trim();
  const primaryLast = args.trace.responses[args.trace.responses.length - 1]?.decision;
  const rationale = summarizeFallbackRationale(text, args.trace);
  const critique = buildFallbackEvidenceCritique(args.trace);

  return {
    createdAtIso: new Date().toISOString(),
    provider: args.provider,
    modelId: args.modelId,
    verdict: inferVerdictFromText(text, args.trace),
    confidence: inferConfidenceFromText(text, args.trace),
    rationale,
    taskVerdicts: primaryLast
      ? [
          {
            taskLabel: "Primary final decision review",
            entityId: "",
            verdict: primaryLast.verdict,
            confidence: primaryLast.confidence,
            reasoning: primaryLast.rationale,
            evidenceSnapshotIds: primaryLast.evidence?.snapshotIds ?? [],
          },
        ]
      : [],
    suggestionsForUser: [
      "Review the snapshot IDs cited by the primary final decision and compare them with the rule requirement.",
      "Inspect highlighted/isolated elements and their IFC properties manually if the judge rationale says the target class or measurement is missing.",
    ].filter(Boolean),
    debuggingAndSuggestions: {
      primaryDecisionAssessment: text
        ? "The judge returned a natural-language assessment instead of strict JSON, so the report preserved that assessment as the judge rationale."
        : "The judge did not return parseable JSON or usable natural-language text; the primary decision was retained.",
      possibleMistakes: [],
      capabilityNotes: [
        "OpenRouter/model output did not satisfy the strict judge JSON contract.",
        ...(args.repairError instanceof Error ? [`JSON repair also failed: ${args.repairError.message}`] : []),
      ],
      improvementSuggestions: [
        "Use a model with stronger JSON-mode compliance for the judge pass or reduce the evidence bundle size if responses are being truncated.",
      ],
    },
    evidenceSupport: critique.evidenceSupport,
    confidenceAssessment: critique.confidenceAssessment,
    contradictionFlags: critique.contradictionFlags,
    recommendedCorrection: critique.recommendedCorrection,
  };
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: any }> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(`Request timed out after ${timeoutMs}ms.`), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  } catch (error: any) {
    if (error?.name === "AbortError" || ctrl.signal.aborted) {
      return {
        ok: false,
        status: 408,
        json: {
          error: {
            message:
              typeof ctrl.signal.reason === "string"
                ? ctrl.signal.reason
                : `Judge request timed out after ${timeoutMs}ms.`,
          },
        },
      };
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

function openRouterHeaders(cfg: JudgeProviderConfig & { provider: "openrouter" }) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.openrouter.apiKey}`,
    ...(cfg.openrouter.appReferer ? { "HTTP-Referer": cfg.openrouter.appReferer } : {}),
    ...(cfg.openrouter.appTitle ? { "X-Title": cfg.openrouter.appTitle } : {}),
  };
}

async function repairJudgeJsonWithOpenRouter(args: {
  config: JudgeProviderConfig & { provider: "openrouter" };
  endpoint: string;
  timeoutMs: number;
  prompt: string;
  invalidContent: unknown;
}) {
  const invalidText = coerceAssistantText(args.invalidContent);
  const body = {
    model: args.config.openrouter.model,
    temperature: 0,
    top_p: 1,
    max_tokens: 1_200,
    messages: [
      {
        role: "system",
        content:
          "You are a JSON repair assistant. Return ONLY one valid JSON object with no markdown, no code fences, and no prose outside JSON.",
      },
      {
        role: "user",
        content:
          "The previous judge response was not parseable as JSON. Convert it into the required judge JSON structure. If a field is missing, infer it only from the provided response and evidence prompt; otherwise use an empty array/string or UNCERTAIN.\n\n" +
          "REQUIRED STRUCTURE:\n" +
          '{"verdict":"UNCERTAIN","confidence":0.5,"rationale":"","taskVerdicts":[],"suggestionsForUser":[],"debuggingAndSuggestions":{"primaryDecisionAssessment":"","possibleMistakes":[],"capabilityNotes":[],"improvementSuggestions":[]},"evidenceSupport":"PARTIALLY_SUPPORTED","confidenceAssessment":"JUSTIFIED","contradictionFlags":[],"recommendedCorrection":"KEEP"}\n\n' +
          "ORIGINAL JUDGE PROMPT:\n" +
          args.prompt.slice(0, 40_000) +
          "\n\nINVALID RESPONSE:\n" +
          invalidText.slice(0, 20_000),
      },
    ],
    response_format: { type: "json_object" },
  };

  const { ok, status, json } = await fetchJsonWithTimeout(
    args.endpoint,
    {
      method: "POST",
      headers: openRouterHeaders(args.config),
      body: JSON.stringify(body),
    },
    args.timeoutMs
  );

  if (!ok) throw new Error(json?.error?.message ?? `Judge OpenRouter JSON repair failed (${status}).`);
  const content = pickOpenRouterAssistantContent(json);
  const parsed = parseModelJson(content);
  if (!parsed) throw new Error("Judge OpenRouter JSON repair response did not contain valid JSON.");
  return parsed;
}

async function judgeWithOpenRouter(config: JudgeProviderConfig & { provider: "openrouter" }, trace: ConversationTrace) {
  const cfg = config.openrouter;
  if (!cfg.apiKey) throw new Error("Judge agent missing OpenRouter apiKey.");
  if (!cfg.model) throw new Error("Judge agent missing OpenRouter model.");

  const endpoint = cfg.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = Math.max(5_000, Math.min(180_000, cfg.requestTimeoutMs ?? 90_000));
  const prompt = buildJudgePrompt(trace);
  const images = collectImages(trace);
  const body = {
    model: cfg.model,
    temperature: 0,
    top_p: 1,
    max_tokens: 1_500,
    messages: [
      {
        role: "system",
        content: "Return ONLY valid JSON. No markdown. No prose outside JSON. No code fences.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
        ],
      },
    ],
    response_format: { type: "json_object" },
  };

  const { ok, status, json } = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: openRouterHeaders(config),
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!ok) {
    return synthesizeJudgeReportFromText({
      trace,
      provider: "openrouter",
      modelId: cfg.model,
      content: json?.error?.message ?? `Judge OpenRouter request failed (${status}).`,
    });
  }
  const content = pickOpenRouterAssistantContent(json);
  let parsed = parseModelJson(content);
  if (!parsed) {
    try {
      parsed = await repairJudgeJsonWithOpenRouter({ config, endpoint, timeoutMs, prompt, invalidContent: content });
    } catch (repairError) {
      return synthesizeJudgeReportFromText({
        trace,
        provider: "openrouter",
        modelId: cfg.model,
        content,
        repairError,
      });
    }
  }
  return normalizeJudgeReport(parsed, trace, { provider: "openrouter", modelId: cfg.model });
}

async function judgeWithOpenAi(config: JudgeProviderConfig & { provider: "openai" }, trace: ConversationTrace) {
  const cfg = config.openai;
  if (!cfg.apiKey) throw new Error("Judge agent missing OpenAI apiKey.");
  if (!cfg.model) throw new Error("Judge agent missing OpenAI model.");

  const endpoint = cfg.endpoint ?? "https://api.openai.com/v1/responses";
  const timeoutMs = Math.max(5_000, Math.min(180_000, cfg.requestTimeoutMs ?? 90_000));
  const prompt = buildJudgePrompt(trace);
  const images = collectImages(trace);
  const body = {
    model: cfg.model,
    store: false,
    temperature: 0,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl, detail: "high" })),
        ],
      },
    ],
    text: { format: { type: "json_object" } },
  };

  const { ok, status, json } = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!ok) {
    return synthesizeJudgeReportFromText({
      trace,
      provider: "openai",
      modelId: cfg.model,
      content: json?.error?.message ?? `Judge OpenAI request failed (${status}).`,
    });
  }
  const content =
    json?.output_text ??
    json?.output?.flatMap?.((item: any) => item?.content ?? [])?.find?.((part: any) => part?.text)?.text ??
    json?.output?.[0]?.content?.[0]?.text ??
    "";
  const parsed = parseModelJson(content);
  if (!parsed) {
    return synthesizeJudgeReportFromText({
      trace,
      provider: "openai",
      modelId: cfg.model,
      content,
    });
  }
  return normalizeJudgeReport(parsed, trace, { provider: "openai", modelId: cfg.model });
}

function judgeWithMock(trace: ConversationTrace): JudgeReport {
  const critique = buildFallbackEvidenceCritique(trace);
  return {
    createdAtIso: new Date().toISOString(),
    provider: "mock",
    modelId: trace.model.id,
    verdict: trace.finalVerdict ?? "UNCERTAIN",
    confidence: trace.finalConfidence ?? 0,
    rationale: trace.finalRationale ?? "Mock judge mirrored the primary final decision.",
    taskVerdicts: [],
    suggestionsForUser: ["Review the referenced snapshots and VLM rationale manually for the final compliance decision."],
    debuggingAndSuggestions: {
      primaryDecisionAssessment: "Mock judge cannot independently reassess evidence.",
      possibleMistakes: [],
      capabilityNotes: ["Mock mode does not perform a real secondary model call."],
      improvementSuggestions: ["Use OpenRouter or OpenAI mode to enable an independent judge pass."],
    },
    evidenceSupport: critique.evidenceSupport,
    confidenceAssessment: critique.confidenceAssessment,
    contradictionFlags: critique.contradictionFlags,
    recommendedCorrection: critique.recommendedCorrection,
  };
}

function getConfigModelId(config: JudgeProviderConfig): string {
  if (config.provider === "openrouter") return config.openrouter.model ?? "openrouter-unknown";
  if (config.provider === "openai") return config.openai.model ?? "openai-unknown";
  return "mock";
}

type EntityJudgeSlice = {
  entityId: string;
  stepStart: number;
  stepEnd: number;
  trace: ConversationTrace;
};

function buildEntityJudgeSlices(trace: ConversationTrace): EntityJudgeSlice[] {
  const groups: Array<{ entityId: string; steps: number[] }> = [];

  for (const response of trace.responses) {
    const entityId = getStepActiveEntity(trace, response.step);
    if (!entityId) continue;

    const current = groups[groups.length - 1];
    if (current?.entityId === entityId) {
      current.steps.push(response.step);
    } else {
      groups.push({ entityId, steps: [response.step] });
    }
  }

  const distinctEntities = new Set(groups.map((group) => group.entityId));
  if (distinctEntities.size <= 1) return [];

  return groups.map((group) => {
    const stepSet = new Set(group.steps);
    const promptSlice = trace.prompts.filter((prompt) => stepSet.has(prompt.step));
    const responseSlice = trace.responses.filter((response) => stepSet.has(response.step));
    const snapshotIds = new Set<string>();

    for (const prompt of promptSlice) {
      for (const id of prompt.snapshotIds ?? []) snapshotIds.add(id);
    }
    for (const response of responseSlice) {
      for (const id of response.decision.evidence?.snapshotIds ?? []) snapshotIds.add(id);
    }

    const snapshotSlice = trace.snapshots.filter((snapshot) => snapshotIds.has(snapshot.snapshotId));
    const finalDecision = responseSlice[responseSlice.length - 1]?.decision;
    const stepStart = Math.min(...group.steps);
    const stepEnd = Math.max(...group.steps);

    return {
      entityId: group.entityId,
      stepStart,
      stepEnd,
      trace: {
        ...trace,
        traceId: `${trace.traceId}:${group.entityId}:${stepStart}-${stepEnd}`,
        prompts: promptSlice,
        responses: responseSlice,
        snapshots: snapshotSlice.length ? snapshotSlice : trace.snapshots,
        sceneStates: [],
        navigationActions: [],
        stepMetrics: trace.stepMetrics.filter((metric) => stepSet.has(metric.step)),
        finalVerdict: finalDecision?.verdict,
        finalConfidence: finalDecision?.confidence,
        finalRationale: finalDecision?.rationale,
      },
    };
  });
}

function summarizeAggregateVerdict(reports: JudgeReport[]): Pick<JudgeReport, "verdict" | "confidence" | "rationale"> {
  if (reports.some((report) => report.verdict === "FAIL")) {
    const failing = reports.filter((report) => report.verdict === "FAIL");
    return {
      verdict: "FAIL",
      confidence: Math.max(...failing.map((report) => report.confidence)),
      rationale: `${failing.length} judged entity/entities failed. See per-entity judge sections below.`,
    };
  }
  if (reports.some((report) => report.verdict === "UNCERTAIN")) {
    const uncertain = reports.filter((report) => report.verdict === "UNCERTAIN");
    return {
      verdict: "UNCERTAIN",
      confidence: Math.max(...uncertain.map((report) => report.confidence)),
      rationale: `${uncertain.length} judged entity/entities remained uncertain. See per-entity judge sections below.`,
    };
  }
  return {
    verdict: "PASS",
    confidence: reports.length ? Math.min(...reports.map((report) => report.confidence)) : 0,
    rationale: "All judged entity sections passed.",
  };
}

function combineEntityJudgeReports(args: {
  config: JudgeProviderConfig;
  slices: EntityJudgeSlice[];
  reports: JudgeReport[];
}): JudgeReport {
  const summary = summarizeAggregateVerdict(args.reports);
  const taskVerdicts = args.reports.map((report, index) => {
    const slice = args.slices[index];
    return {
      taskLabel: `Entity ${index + 1}: ${slice.entityId}`,
      entityId: slice.entityId,
      stepStart: slice.stepStart,
      stepEnd: slice.stepEnd,
      verdict: report.verdict,
      confidence: report.confidence,
      reasoning: report.rationale,
      evidenceSnapshotIds: Array.from(
        new Set(report.taskVerdicts.flatMap((task) => task.evidenceSnapshotIds ?? []))
      ),
    };
  });
  const evidenceSupport: JudgeEvidenceSupport = args.reports.some((report) => report.evidenceSupport === "UNSUPPORTED")
    ? "UNSUPPORTED"
    : args.reports.some((report) => report.evidenceSupport === "PARTIALLY_SUPPORTED")
      ? "PARTIALLY_SUPPORTED"
      : "SUPPORTED";
  const confidenceAssessment: JudgeConfidenceAssessment = args.reports.some(
    (report) => report.confidenceAssessment === "OVERCONFIDENT"
  )
    ? "OVERCONFIDENT"
    : args.reports.some((report) => report.confidenceAssessment === "UNDERCONFIDENT")
      ? "UNDERCONFIDENT"
      : "JUSTIFIED";
  const contradictionFlags = Array.from(new Set(args.reports.flatMap((report) => report.contradictionFlags))).slice(0, 8);
  const recommendedCorrection: JudgeRecommendedCorrection =
    args.reports.some((report) => report.recommendedCorrection === "DOWNGRADE_TO_UNCERTAIN")
      ? "DOWNGRADE_TO_UNCERTAIN"
      : args.reports.some((report) => report.recommendedCorrection === "REVIEW_REQUIRED")
        ? "REVIEW_REQUIRED"
        : "KEEP";

  return {
    createdAtIso: new Date().toISOString(),
    provider: args.reports[0]?.provider ?? args.config.provider,
    modelId: args.reports[0]?.modelId ?? getConfigModelId(args.config),
    verdict: summary.verdict,
    confidence: summary.confidence,
    rationale: summary.rationale,
    taskVerdicts,
    suggestionsForUser: Array.from(new Set(args.reports.flatMap((report) => report.suggestionsForUser))).slice(0, 6),
    debuggingAndSuggestions: {
      primaryDecisionAssessment:
        "Primary VLM verdicts were judged per entity as claims against the sliced entity evidence, not accepted as source-of-truth.",
      possibleMistakes: Array.from(
        new Set(args.reports.flatMap((report) => report.debuggingAndSuggestions.possibleMistakes))
      ).slice(0, 6),
      capabilityNotes: Array.from(
        new Set(args.reports.flatMap((report) => report.debuggingAndSuggestions.capabilityNotes))
      ).slice(0, 4),
      improvementSuggestions: Array.from(
        new Set(args.reports.flatMap((report) => report.debuggingAndSuggestions.improvementSuggestions))
      ).slice(0, 6),
    },
    evidenceSupport,
    confidenceAssessment,
    contradictionFlags,
    recommendedCorrection,
  };
}

async function judgeSingleTrace(trace: ConversationTrace, config: JudgeProviderConfig): Promise<JudgeReport> {
  try {
    if (config.provider === "openrouter") return await judgeWithOpenRouter(config, trace);
    if (config.provider === "openai") return await judgeWithOpenAi(config, trace);
    return judgeWithMock(trace);
  } catch (error) {
    return synthesizeJudgeReportFromText({
      trace,
      provider: config.provider,
      modelId: getConfigModelId(config),
      content: error instanceof Error ? error.message : String(error),
      repairError: error,
    });
  }
}

export async function runJudgeAgent(trace: ConversationTrace, config: JudgeProviderConfig): Promise<JudgeReport> {
  const entitySlices = buildEntityJudgeSlices(trace);
  if (entitySlices.length > 1) {
    const reports: JudgeReport[] = [];
    for (const slice of entitySlices) {
      const report = await judgeSingleTrace(slice.trace, config);
      reports.push({
        ...report,
        taskVerdicts: report.taskVerdicts.length
          ? report.taskVerdicts.map((task) => ({
              ...task,
              entityId: task.entityId || slice.entityId,
              stepStart: task.stepStart ?? slice.stepStart,
              stepEnd: task.stepEnd ?? slice.stepEnd,
            }))
          : [
              {
                taskLabel: `Entity ${slice.entityId}`,
                entityId: slice.entityId,
                stepStart: slice.stepStart,
                stepEnd: slice.stepEnd,
                verdict: report.verdict,
                confidence: report.confidence,
                reasoning: report.rationale,
                evidenceSnapshotIds: [],
              },
            ],
      });
    }
    return combineEntityJudgeReports({ config, slices: entitySlices, reports });
  }

  return judgeSingleTrace(trace, config);
}

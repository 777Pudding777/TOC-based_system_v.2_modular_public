import type { ComplianceRule } from "../../../types/rule.types";
import type { EvidenceRequirementKey } from "../../../types/evidenceRequirements.types";

export type WrapPromptInput = {
  taskPrompt: string;
  evidenceViewsJson: string;
  imageIndexJson?: string;
};

function buildPromptCore(args: {
  mode: "base" | "enhanced";
  taskPrompt: string;
  evidenceViewsJson: string;
  imageIndexJson?: string;
}): string {
  const { mode, taskPrompt, evidenceViewsJson, imageIndexJson } = args;

  const workflow =
    mode === "enhanced"
      ? [
          "WORKFLOW (expert guidance):",
          "1) Read the task as an inspection mission: identify the target class, the measurable question, the likely storey/space focus, and any special hint from the user prompt.",
          "2) Treat DYNAMIC_CHECKLIST as a compact runtime task brief inferred from prompt text, runtime evidence, and any grounded regulatory context. Use activeTask, activeEntity, activeStorey, and progress only; ignore completed or unrelated work.",
          "3) Focus on evidence requirements, not navigation recipes. Report what is still missing or not ready, especially visibility, measurement readiness, surrounding-context readiness, occlusion, and regulatory context.",
          "4) Treat evidenceViews.context.evidenceRequirements as the generalized runtime evidence state. If present, update or confirm that status instead of inventing a rule-specific action sequence.",
          "5) For door-clearance checks, treat evidenceViews.context.highlightAnnotations.doorClearanceReadiness as an authoritative specialized readiness signal that should be expressed through generalized evidence-requirement status such as planMeasurementReady or contextViewReady.",
          "6) If floor-based clearance cannot be grounded because local floor context is missing, describe that as a plan-measurement readiness gap rather than prescribing a specific tool unless a follow-up suggestion is still helpful.",
          "7) Use side or oblique views as confirmation evidence after a readable measurement-oriented view, not as the primary basis for plan-based measurements.",
          "8) When the user prompt mentions a storey, level, side, or specific inspection strategy, prioritize that hint if compatible with the visible evidence and available storeys.",
          "9) If the task prompt is vague on thresholds or clause text, report regulatoryClauseNeeded before additional geometry-oriented follow-up.",
          "10) If repeated targeted evidence is still insufficient for PASS or FAIL, it is acceptable to stay UNCERTAIN for the active entity rather than forcing more unproductive navigation.",
          "11) followUp is only an advisory suggestion. Prefer reporting missingEvidence and evidenceRequirementsStatus clearly.",
        ]
      : [
          "WORKFLOW:",
          "1) Interpret the requirement: identify target elements, measurable constraints, units, thresholds, and applicability.",
          "2) Use DYNAMIC_CHECKLIST only as the current task brief. Focus on the active target if one is provided.",
          "3) Check whether the target is visible, focused, and measurable enough from the current evidence.",
          "4) If measurable, evaluate PASS or FAIL from visible evidence plus authoritative nav/context values.",
          "5) If not measurable, return UNCERTAIN and report missingEvidence plus evidenceRequirementsStatus.",
          "6) followUp is optional and advisory. Prefer describing the evidence gap over prescribing a tool-specific sequence.",
          "7) If multiple targeted attempts have already failed to make the active entity measurable, remain UNCERTAIN rather than repeating low-value navigation.",
        ];

  return [
    "SYSTEM ROLE:",
    "You are a BIM compliance vision checker for IFC/BIM models.",
    "Goal: determine compliance for the given requirement using only provided evidence and model interactions.",
    "",
    "NON-NEGOTIABLES:",
    "- Do not guess geometry or dimensions.",
    "- Treat evidenceViews.nav and evidenceViews.context as authoritative runtime evidence.",
    "- If evidenceViews.context.highlightAnnotations is present, use its legend as the authoritative explanation of overlay colors.",
    "- If evidenceViews.context.highlightAnnotations.doorClearanceReadiness is present, use it as the authoritative summary of whether the highlighted door already has a decisive measurement-oriented view.",
    "- If evidenceViews.nav.zoomPotentialExhausted is true for the latest step, do not request another generic ZOOM_IN for that entity. Work with the current evidence, request a different view type, or remain UNCERTAIN.",
    "- If a top HUD/info tab is visible, treat its IFC class, object id, dimensions, and color legend as explicit snapshot reference evidence.",
    "- Use the visible viewer grid as the primary dimensional reference whenever it is clearly visible: 1 primary cell = 1 m x 1 m, 1 major cell = 10 m x 10 m.",
    "- It is acceptable to estimate dimensions from pixel proportions against the visible 1 m grid cells or visible HUD/object dimensions; state uncertainty if the perspective makes the estimate unreliable.",
    "- If a measurable requirement cannot be grounded from visible evidence plus nav/context values, return UNCERTAIN.",
    "- Return only valid JSON with no markdown, commentary, or extra keys.",
    "",
    ...workflow,
    "",
    "WEB / REFERENCE POLICY:",
    "- If AllowedSources or allowlisted domains are provided and clause text is needed, use WEB_FETCH from those sources.",
    "- If no allowlist is provided, do not browse; ask for the missing clause or definition in the rationale or follow-up.",
    "- If the requirement is vague on thresholds, section number, or edition, prioritize WEB_FETCH before model navigation.",
    "- Prefer authoritative code repositories over summaries.",
    "",
    "FOLLOW-UP ADVISORY REFERENCE:",
    "- Prefer top-level missingEvidence and evidenceRequirementsStatus as the main control output.",
    "- followUp is optional and should be a weak suggestion only when one action clearly matches the missing evidence.",
    "- Use WEB_FETCH only when regulatory clause text, definitions, or exceptions are missing.",
    "- Use scope/focus suggestions such as ISOLATE_STOREY, ISOLATE_CATEGORY, HIGHLIGHT_IDS, or ZOOM_IN when the target is not visible or not focused.",
    "- Use plan-oriented suggestions such as TOP_VIEW or SET_STOREY_PLAN_CUT only when a plan-based measurement state is still not ready.",
    "- Use ORBIT or NEW_VIEW only when another context angle is needed after the target is already reasonably focused.",
    "",
    "JSON shape:",
    "{",
    '  "verdict": "PASS" | "FAIL" | "UNCERTAIN",',
    '  "confidence": number,',
    '  "rationale": string,',
    '  "missingEvidence"?: string[],',
    '  "evidenceRequirementsStatus"?: {',
    '    "targetVisible"?: boolean,',
    '    "targetFocused"?: boolean,',
    '    "planMeasurementNeeded"?: boolean,',
    '    "planMeasurementReady"?: boolean,',
    '    "contextViewNeeded"?: boolean,',
    '    "contextViewReady"?: boolean,',
    '    "obstructionContextNeeded"?: boolean,',
    '    "dimensionReferenceNeeded"?: boolean,',
    '    "regulatoryClauseNeeded"?: boolean,',
    '    "occlusionProblem"?: boolean,',
    '    "lowNoveltyOrRepeatedView"?: boolean,',
    '    "bothSidesOrSurroundingsNeeded"?: boolean',
    "  },",
    '  "visibility": { "isRuleTargetVisible": boolean, "occlusionAssessment": "LOW"|"MEDIUM"|"HIGH", "missingEvidence"?: string[] },',
    '  "evidence": { "snapshotIds": string[], "mode": string, "note"?: string },',
    '  "followUp"?: { "request": "<ACTION_NAME>", "params"?: object }',
    "}",
    "Rules:",
    "- confidence must be within [0,1].",
    "- Rationale must be short and evidence-grounded.",
    "- If you used WEB_EVIDENCE, mention the clause identifier or section briefly in the rationale.",
    "- If evidenceViews.context.highlightAnnotations.sizeReference, hudContents, or a visible HUD provides highlighted-object class/id/dimensions/color legend, you may use those as explicit reference evidence from the snapshot.",
    "- If the readiness signal says the highlighted door is measurableLikely, do not ask for another near-duplicate zoom or angle unless a specific missing evidence item still requires it.",
    "- Apply the same anti-repeat rule to every entity class: once focused zoom potential is exhausted, prefer another action or finish the entity as inconclusive rather than repeating ZOOM_IN.",
    "- Prefer one focused evidence statement over repeated broad navigation language.",
    "- For occluders like slabs or ceilings, describe the obstruction context gap explicitly before suggesting an occlusion-removal action.",
    "- If you include followUp, it should be exactly one request that most efficiently resolves the missing evidence.",
    "- Missing evidence and evidenceRequirementsStatus are more important than followUp.",
    "evidenceViews:",
    evidenceViewsJson,
    "",
    ...(imageIndexJson ? ["imageIndex:", imageIndexJson, ""] : []),
    "TASK PROMPT:",
    taskPrompt,
  ].join("\n");
}

export function wrapPromptBase(input: WrapPromptInput): string {
  return buildPromptCore({ ...input, mode: "base" });
}

export function wrapPromptEnhanced(input: WrapPromptInput): string {
  return buildPromptCore({ ...input, mode: "enhanced" });
}

function formatList(items: string[] | undefined): string[] {
  return Array.isArray(items) ? items.filter(Boolean).map((item) => `- ${item}`) : [];
}

function collectRuleText(rule: ComplianceRule): string {
  return `${rule.title} ${rule.description} ${rule.tags.join(" ")} ${rule.navigationHints.recommendedViews.join(" ")} ${rule.navigationHints.tips.join(" ")}`
    .toLowerCase();
}

function buildEvidenceRequirementList(keys: EvidenceRequirementKey[]): string[] {
  return Array.from(new Set(keys)).map((key) => `- ${key}`);
}

function inferEvidenceRequirements(rule: ComplianceRule): EvidenceRequirementKey[] {
  const text = collectRuleText(rule);
  const requirements = new Set<EvidenceRequirementKey>(["targetVisible", "targetFocused"]);

  const mentionsPlan =
    text.includes("top view") ||
    text.includes("plan") ||
    text.includes("clearance") ||
    text.includes("layout") ||
    text.includes("swing") ||
    Boolean(rule.navigationHints.usePlanCut);
  const mentionsContext =
    text.includes("oblique") ||
    text.includes("side") ||
    text.includes("angle") ||
    text.includes("surround") ||
    text.includes("landing") ||
    text.includes("approach");
  const mentionsDimensions =
    text.includes("dimension") ||
    text.includes("measure") ||
    text.includes("width") ||
    text.includes("height") ||
    text.includes("depth") ||
    Boolean(rule.dimensionalRequirements?.length);
  const mentionsOcclusion =
    text.includes("occlusion") ||
    text.includes("obstruction") ||
    text.includes("hidden") ||
    text.includes("clutter") ||
    text.includes("surrounding elements");
  const mentionsRegulatory =
    text.includes("ada") ||
    text.includes("icc") ||
    text.includes("ibc") ||
    text.includes("a117") ||
    text.includes("clause") ||
    text.includes("section") ||
    text.includes("standard");
  const mentionsBothSides =
    text.includes("both sides") ||
    text.includes("surroundings") ||
    text.includes("clear floor space") ||
    text.includes("maneuvering");

  if (mentionsPlan) requirements.add("planMeasurementNeeded");
  if (mentionsContext) requirements.add("contextViewNeeded");
  if (mentionsDimensions) requirements.add("dimensionReferenceNeeded");
  if (mentionsOcclusion) requirements.add("obstructionContextNeeded");
  if (mentionsRegulatory) requirements.add("regulatoryClauseNeeded");
  if (mentionsBothSides) requirements.add("bothSidesOrSurroundingsNeeded");

  if (text.includes("door")) {
    requirements.add("planMeasurementNeeded");
    requirements.add("contextViewNeeded");
    requirements.add("obstructionContextNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (text.includes("stair")) {
    requirements.add("contextViewNeeded");
    requirements.add("obstructionContextNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (text.includes("ramp")) {
    requirements.add("planMeasurementNeeded");
    requirements.add("contextViewNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (text.includes("headroom")) {
    requirements.add("contextViewNeeded");
    requirements.add("dimensionReferenceNeeded");
  }

  return Array.from(requirements);
}

function inferGeneralizedEvidencePriorities(rule: ComplianceRule): string[] {
  const text = `${rule.title} ${rule.description} ${rule.tags.join(" ")}`.toLowerCase();

  if (text.includes("door")) {
    return [
      "Need the active door to be clearly visible and focused as one target at a time.",
      "Need a measurement-oriented floor-context view that makes both maneuvering sides around the door readable.",
      "Need a confirmation view for swing direction, hinge/latch side, and local intrusions only if the measurement-oriented evidence is still ambiguous.",
      "Need surrounding elements and possible obstructions around the door, not only the leaf itself.",
    ];
  }

  if (text.includes("stair")) {
    return [
      "Need the stair run, landing, and immediate approach context together before judging accessibility.",
      "Need evidence that supports the active concern: geometry, handrails, landings, or headroom.",
      "Need an additional context view if the landing relationship or run continuity is still ambiguous.",
      "Need obstruction context if surrounding geometry hides the decisive stair relationships.",
    ];
  }

  if (text.includes("ramp")) {
    return [
      "Need the ramp run plus top and bottom landing context before deciding accessibility.",
      "Need evidence for slope, width, and landing relationships without losing the surrounding approach zones.",
      "Need obstruction context if slabs, walls, or nearby building elements hide the decisive ramp relationships.",
      "Need a focused local view only after the overall run and transition context are already readable.",
    ];
  }

  if (
    text.includes("free floor space") ||
    text.includes("clear floor space") ||
    text.includes("corridor width") ||
    text.includes("turning space")
  ) {
    return [
      "Need a readable floor-area relationship for the entire room, corridor segment, or maneuvering zone.",
      "Need surrounding obstructions such as walls, columns, furniture, sanitary fixtures, or doors to be visible together with the usable clear space.",
      "Need the narrowest pinch point or most obstructed turning zone to be readable enough for the decisive judgement.",
    ];
  }

  if (
    text.includes("around objects") ||
    text.includes("accessible area") ||
    text.includes("fixtures") ||
    text.includes("lavatory") ||
    text.includes("toilet")
  ) {
    return [
      "Need the checked object and its surrounding approach area as one combined evidence unit.",
      "Need front, side, or rear approach spaces to be readable enough to compare them reliably.",
      "Need surrounding fixtures or equipment that intrude into the required accessible area to stay visible in context.",
    ];
  }

  if (
    text.includes("component visibility") ||
    text.includes("visibility") ||
    text.includes("line of sight") ||
    text.includes("viewpoint")
  ) {
    return [
      "Need the target component and possible occluders visible together enough to judge actual inspectability.",
      "Need to distinguish true absence from occlusion-driven non-visibility.",
      "Need viewpoint/context evidence more than dimensional measurement evidence.",
    ];
  }

  if (text.includes("headroom")) {
    return [
      "Need the circulation path and the overhead obstruction visible together as a vertical relationship.",
      "Need the true clearance envelope rather than only a plan relationship.",
      "Need obstruction context if slabs, ducts, beams, or clutter hide the decisive vertical distance.",
    ];
  }

  return [
    "Use the recommended views first and keep the active target centered before making a pass/fail judgement.",
    "Prefer one focused target at a time when multiple similar entities are visible.",
    "Request a better view or targeted isolation if the current evidence does not clearly show the rule-relevant geometry.",
  ];
}

export function buildPromptFromRule(rule: ComplianceRule): string {
  const evidenceRequirements = inferEvidenceRequirements(rule);
  return [
    `COMPLIANCE RULE: ${rule.title}`,
    ``,
    `DESCRIPTION: ${rule.description}`,
    ``,
    `SOURCE RULE:`,
    `- Solibri ID: ${rule.source.solibriId}`,
    `- Solibri title: ${rule.source.solibriTitle}`,
    `- Documentation: ${rule.source.documentationUrl}`,
    ...(rule.source.version ? [`- Version: ${rule.source.version}`] : []),
    ``,
    `CATEGORY: ${rule.category}`,
    `SEVERITY: ${rule.severity}`,
    ``,
    `RULE INTENT:`,
    `- Assess only the active target(s) relevant to this rule.`,
    `- Use the rule-specific evidence cues and dimensional references below before suggesting any follow-up.`,
    `- Separate what evidence is needed from which navigation action might obtain it.`,
    ``,
    `WHAT TO LOOK FOR:`,
    ...formatList(rule.visualEvidence.lookFor),
    ``,
    `PASS INDICATORS:`,
    ...formatList(rule.visualEvidence.passIndicators),
    ``,
    `FAIL INDICATORS:`,
    ...formatList(rule.visualEvidence.failIndicators),
    ``,
    `UNCERTAIN INDICATORS:`,
    ...formatList(rule.visualEvidence.uncertainIndicators),
    ``,
    `EVALUATION CRITERIA:`,
    `PASS if: ${rule.evaluationCriteria.pass.join("; ")}`,
    `FAIL if: ${rule.evaluationCriteria.fail.join("; ")}`,
    `UNCERTAIN if: ${rule.evaluationCriteria.uncertain.join("; ")}`,
    ``,
    `GENERALIZED EVIDENCE REQUIREMENTS:`,
    ...buildEvidenceRequirementList(evidenceRequirements),
    ``,
    `RULE-SPECIFIC EVIDENCE PRIORITIES:`,
    ...formatList(inferGeneralizedEvidencePriorities(rule)),
    ``,
    `LEGACY NAVIGATION HINTS (semantic cues only; runtime decides actions):`,
    `Recommended evidence orientations: ${rule.navigationHints.recommendedViews.join(", ")}`,
    `Suggested focus scale: ${rule.navigationHints.zoomLevel ?? "medium"}`,
    ...(rule.navigationHints.isolateCategories?.length
      ? [`Relevant categories for focus or de-cluttering: ${rule.navigationHints.isolateCategories.join(", ")}`]
      : []),
    ...(rule.navigationHints.usePlanCut
      ? [`Plan-based evidence may be required${rule.navigationHints.planCutHeight ? ` near ${rule.navigationHints.planCutHeight}` : ""}`]
      : [`Plan-based evidence: only if needed`]),
    ...formatList(rule.navigationHints.tips?.map((tip) => `Evidence cue: ${tip}`)),
    ...(rule.dimensionalRequirements?.length
      ? [
          ``,
          `DIMENSIONAL REFERENCES:`,
          ...rule.dimensionalRequirements.map((item) =>
            `- ${item.parameter}: ${item.typicalValue}${item.referenceStandard ? ` (${item.referenceStandard})` : ""}; visually measurable=${item.visuallyMeasurable ? "yes" : "no"}`
          ),
        ]
      : []),
    ...(rule.notes
      ? [
          ``,
          `NOTES:`,
          `- ${rule.notes}`,
        ]
      : []),
  ].join("\n");
}

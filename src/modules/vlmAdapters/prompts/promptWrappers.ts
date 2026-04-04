import type { ComplianceRule } from "../../../types/rule.types";

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
          "3) Prefer the cheapest decisive view sequence. For repeated door checks this means: switch to TOP_VIEW, prepare a storey-aware plan cut for the active storey, reuse that prepared top/plan-cut setup for other doors on the same storey, then highlight and inspect doors one-by-one.",
          "3a) For door-clearance checks, treat evidenceViews.context.highlightAnnotations.doorClearanceReadiness as the authoritative readiness signal for whether the current highlighted door is finally measurable.",
          "4) If the active entity is still too small, request HIGHLIGHT_IDS or ZOOM_IN before asking for broader scene changes.",
          "5) If floor-based clearance cannot be grounded because local floor context is missing, treat evidenceViews.context.floorContext as authoritative and prefer SET_STOREY_PLAN_CUT for the active storey.",
          "6) Use side or oblique views as confirmation views after a readable measurement-oriented view, not as the first choice for plan-based measurements.",
          "7) When the user prompt mentions a storey, level, side, or specific inspection strategy, prioritize that hint if compatible with the visible evidence and available storeys.",
          "8) If the task prompt is vague on thresholds or clause text, prioritize WEB_FETCH before additional model navigation.",
          "9) If repeated targeted evidence is still insufficient for PASS or FAIL, it is acceptable to stay UNCERTAIN for the active entity rather than forcing more unproductive navigation.",
          "10) Choose one best next action only if the current evidence is insufficient.",
        ]
      : [
          "WORKFLOW:",
          "1) Interpret the requirement: identify target elements, measurable constraints, units, thresholds, and applicability.",
          "2) Use DYNAMIC_CHECKLIST only as the current task brief. It may already reflect prompt intent and grounded regulatory context, so focus on the active target if one is provided and reuse current top-view/storey-plan-cut setup for later entities on the same storey instead of re-requesting it.",
          "3) Check whether the target is visible and measurable enough from the current evidence.",
          "3a) For doors, a decisive measurement view is a centered TOP_VIEW with storey plan cut active and both clearance sides visible around the highlighted door. Use the readiness signal if present.",
          "4) If measurable, evaluate PASS or FAIL from visible evidence plus authoritative nav/context values.",
          "5) If not measurable, return UNCERTAIN and choose one best follow-up action.",
          "6) If multiple targeted attempts have already failed to make the active entity measurable, remain UNCERTAIN rather than repeating low-value navigation.",
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
    "FOLLOW-UP ACTION REFERENCE:",
    "- ISO_VIEW: use for overall 3D context.",
    "- TOP_VIEW: use for plan-based checks such as clearances, layouts, and swings.",
    "- NEW_VIEW: use for a different angle when the current view is inconclusive.",
    "- ZOOM_IN: use to make the active target and its immediate context readable.",
    "- ISOLATE_STOREY / ISOLATE_SPACE / ISOLATE_CATEGORY: use to narrow scope.",
    "- HIGHLIGHT_IDS: preferred way to focus the active target.",
    "- HIDE_CATEGORY / HIDE_IDS: use to remove occluders.",
    "- SET_STOREY_PLAN_CUT / SET_PLAN_CUT: use when plan-based geometry is hidden or floor context is missing.",
    "- RESTORE_VIEW: use to return to a previous captured viewpoint or saved navigation bookmark when you want to retry from a known good state.",
    "- WEB_FETCH: use when regulatory clause text is missing.",
    "",
    "JSON shape:",
    "{",
    '  "verdict": "PASS" | "FAIL" | "UNCERTAIN",',
    '  "confidence": number,',
    '  "rationale": string,',
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
    "- Prefer one focused action over repeated broad navigation.",
    "- For occluders like slabs or ceilings, prefer HIDE_CATEGORY rather than listing many ids.",
    "- followUp should be exactly one request that most efficiently resolves the missing evidence.",
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

function inferRuleSpecificSteps(rule: ComplianceRule): string[] {
  const text = `${rule.title} ${rule.description} ${rule.tags.join(" ")}`.toLowerCase();

  if (text.includes("door")) {
    return [
      "Work storey-wise when multiple doors exist: prepare TOP view and a storey-aware plan cut once for the current storey, then complete one highlighted door before moving to the next door on that same storey.",
      "Prefer TOP view plus storey plan cut for measurement. Highlight the active door and only then zoom if the door plus its surrounding maneuvering floor area are still not readable.",
      "Judge clearance from a centered top snapshot in the storey plan cut first. Reuse that prepared same-storey top/plan-cut context for the next door instead of rebuilding it.",
      "Use an oblique side or angled snapshot only after the plan view, mainly to confirm swing direction, hinge side, latch side, and possible local intrusions.",
      "Do not bulk-judge all visible doors together. Decide the currently highlighted door first, then continue with the next door.",
    ];
  }

  if (text.includes("stair")) {
    return [
      "Treat stair accessibility as a transition check, not a single-object close-up: keep the stair plus the landing and approach area on the current storey visible before judging compliance.",
      "Start with an isometric or side-oriented view to understand the full stair run and how it connects storeys, then use closer side/front views for risers, treads, landings, and handrails.",
      "For accessibility-focused stair checks, inspect the current storey landing first, then inspect the connected landing/storey, instead of isolating only the stair body and losing approach context.",
      "Use the most revealing angle for the active concern: side for riser/tread geometry, front or oblique for handrails, top/plan-cut for landing and approach area, and low/upward views for headroom conflicts.",
      "Prefer a new angle or storey-aware plan cut before making a dimensional judgement from a partially occluded stair.",
    ];
  }

  if (text.includes("ramp")) {
    return [
      "Treat ramp accessibility as a run-plus-context check: include the ramp run, top landing, bottom landing, and immediate approach floor area before deciding slope or accessibility.",
      "Work storey-wise when multiple ramps or ramp segments exist, but do not over-zoom into a single small patch of the ramp or isolate away the landing context needed for accessibility.",
      "Prefer an isometric or side-oriented view first so the full ramp run, top/bottom transitions, and nearby occluders are visible together for slope reasoning.",
      "Use top or shallow oblique views plus storey-aware plan cuts to verify width, landings, and clear floor space at the top and bottom of the ramp.",
      "If the current storey view shows only one transition, inspect that landing first and then move to the connected storey/landing rather than forcing one tight snapshot to explain both ends.",
      "If the ramp run is hidden by slabs, walls, or surrounding building elements, request a section-style or storey-aware plan cut before trying tighter zooms.",
      "Use close zooms only for local details such as handrails, landing edges, or small obstructions after the full ramp geometry and both transitions are already understood.",
    ];
  }

  if (
    text.includes("free floor space") ||
    text.includes("clear floor space") ||
    text.includes("corridor width") ||
    text.includes("turning space")
  ) {
    return [
      "Treat this as a plan-based space check: start with TOP view and prefer a storey-aware plan cut so the usable floor area is readable.",
      "Keep the entire room, corridor segment, or maneuvering zone in frame before zooming into local obstructions.",
      "Prioritize walls, columns, furniture, sanitary fixtures, and doors that intrude into the clear floor or turning area.",
      "Use the narrowest pinch point or most obstructed turning zone as the decisive focus for PASS or FAIL.",
      "If clearance edges are still ambiguous, prefer plan cut or targeted hiding of overhead clutter before requesting more oblique views.",
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
      "Treat the checked object and its surrounding approach area as one unit: keep the object plus front/side clearance zone visible together.",
      "Prefer TOP view with a storey-aware plan cut first so front, side, and rear approach spaces can be compared clearly.",
      "Highlight the target object before zooming so the VLM reasons about one accessible-area condition at a time.",
      "Check whether walls, adjacent fixtures, furniture, or other equipment intrude into the required approach space.",
      "Use oblique or front views only as confirmation after the plan-based clearance relationship is already visible.",
    ];
  }

  if (
    text.includes("component visibility") ||
    text.includes("visibility") ||
    text.includes("line of sight") ||
    text.includes("viewpoint")
  ) {
    return [
      "Treat this as a viewpoint-and-occlusion check rather than a dimensional measurement task.",
      "Start from ISO or a user-relevant viewing direction and keep both the target component and possible occluders visible together.",
      "Prefer NEW_VIEW, ISO_VIEW, HIDE_CATEGORY, or HIDE_IDS when the target is hidden behind walls, slabs, or other large geometry.",
      "Only isolate narrowly if it helps confirm whether the original scene visibility failure is caused by occlusion versus absence.",
      "Base PASS or FAIL on whether the target is meaningfully inspectable from the current viewpoint, not just barely present in frame.",
    ];
  }

  if (text.includes("headroom")) {
    return [
      "Treat headroom as a vertical clearance check: use SIDE, FRONT, or ISO views that show the circulation path and the overhead obstruction together.",
      "Keep the walking path, stair, or ramp in frame with beams, ducts, soffits, or sloped ceilings that may reduce vertical clearance.",
      "Prefer elevation-like views before plan views because plan alone usually cannot show the decisive overhead relationship.",
      "Use targeted hiding of slabs or MEP clutter only when they prevent reading the true clearance envelope.",
      "Judge FAIL when an overhead element clearly intrudes into the required accessible route height, and stay UNCERTAIN when the vertical distance cannot be grounded visually.",
    ];
  }

  return [
    "Use the recommended views first and keep the active target centered before making a pass/fail judgement.",
    "Prefer one focused target at a time when multiple similar entities are visible.",
    "Request a better view or targeted isolation if the current evidence does not clearly show the rule-relevant geometry.",
  ];
}

export function buildPromptFromRule(rule: ComplianceRule): string {
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
    `- Use the rule-specific evidence cues and dimensional references below before asking for a new action.`,
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
    `RULE-SPECIFIC INSPECTION STEPS:`,
    ...formatList(inferRuleSpecificSteps(rule)),
    ``,
    `NAVIGATION HINTS:`,
    `Recommended views: ${rule.navigationHints.recommendedViews.join(", ")}`,
    `Zoom level: ${rule.navigationHints.zoomLevel ?? "medium"}`,
    ...(rule.navigationHints.isolateCategories?.length
      ? [`Prefer isolated categories: ${rule.navigationHints.isolateCategories.join(", ")}`]
      : []),
    ...(rule.navigationHints.usePlanCut
      ? [`Plan cut: recommended${rule.navigationHints.planCutHeight ? ` at ${rule.navigationHints.planCutHeight}` : ""}`]
      : [`Plan cut: only if needed`]),
    ...formatList(rule.navigationHints.tips),
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

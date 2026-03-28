import type { VlmDecision, VlmFollowUp } from "./vlmChecker";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";

export type ComplianceTask = {
  id: string;
  entityId?: string;
  entityClass?: string;
  title: string;
  description: string;
  status: TaskStatus;
  required: boolean;
  dependsOn?: string[];
  evidenceNotes: string[];
};

export type TaskGraphState = {
  profile: "generic" | "door";
  tasks: ComplianceTask[];
  history: string[];
  entities: {
    trackedIds: string[];
  };
};

function hasKeywords(input: string, keywords: string[]): boolean {
  const normalized = input.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function createTask(
  id: string,
  title: string,
  description: string,
  required = true,
  dependsOn?: string[],
  entity?: { entityId?: string; entityClass?: string }
): ComplianceTask {
  return {
    id,
    entityId: entity?.entityId,
    entityClass: entity?.entityClass,
    title,
    description,
    status: "pending",
    required,
    dependsOn,
    evidenceNotes: [],
  };
}

function canStartTask(task: ComplianceTask, state: TaskGraphState): boolean {
  if (!task.dependsOn?.length) return true;
  const completed = new Set(state.tasks.filter((x) => x.status === "done").map((x) => x.id));
  return task.dependsOn.every((dep) => completed.has(dep));
}

function setTaskStatus(state: TaskGraphState, taskId: string, status: TaskStatus, note?: string) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = status;
  if (note) task.evidenceNotes.push(note);
}

function markFirstRunnableInProgress(state: TaskGraphState) {
  const active = state.tasks.some((task) => task.status === "in_progress");
  if (active) return;

  const next = state.tasks.find((task) => task.status === "pending" && canStartTask(task, state));
  if (next) {
    next.status = "in_progress";
  }
}

function genericTasks(): ComplianceTask[] {
  return [
    createTask("target_identification", "Identify target elements", "Find the rule target object(s) in the model evidence."),
    createTask("visibility_validation", "Validate visibility", "Confirm targets are visible enough for reliable compliance measurement.", true, ["target_identification"]),
    createTask("measurement_readiness", "Prepare measurement context", "Use plan cuts/isolation/views to make dimensional checks reliable.", true, ["visibility_validation"]),
    createTask("final_decision", "Issue compliant verdict", "Return PASS/FAIL/UNCERTAIN with evidence-backed rationale.", true, ["measurement_readiness"]),
  ];
}

function doorTasks(): ComplianceTask[] {
  return [
    createTask("target_identification", "Identify door candidate", "Select the specific door instance to evaluate."),
    createTask("opening_direction", "Determine opening direction", "Resolve door swing/push-pull direction from plan/geometry.", true, ["target_identification"]),
    createTask("latch_side", "Determine latch and hinge side", "Identify latch-side and hinge-side to support maneuvering checks.", true, ["opening_direction"]),
    createTask("clearance_measurement", "Check maneuvering clearances", "Verify required push/pull clearances around the selected door.", true, ["latch_side"]),
    createTask("final_decision", "Issue compliant verdict", "Return PASS/FAIL/UNCERTAIN with evidence-backed rationale.", true, ["clearance_measurement"]),
  ];
}

export function createTaskGraph(rulePrompt: string): TaskGraphState {
  const isDoorRule = hasKeywords(rulePrompt, ["door", "latch", "hinge", "maneuver", "clearance"]);
  const state: TaskGraphState = {
    profile: isDoorRule ? "door" : "generic",
    tasks: isDoorRule ? doorTasks() : genericTasks(),
    history: [],
    entities: { trackedIds: [] },
  };

  markFirstRunnableInProgress(state);
  return state;
}

function ensureEntityTask(
  state: TaskGraphState,
  entityId: string,
  taskKey: string,
  title: string,
  description: string,
  dependsOn?: string[]
) {
  const id = `${taskKey}:${entityId}`;
  if (state.tasks.some((t) => t.id === id)) return;
  state.tasks.push(createTask(id, title, description, true, dependsOn, { entityId, entityClass: "IfcDoor" }));
}

export function syncTaskGraphEntities(state: TaskGraphState, entityIds: string[]) {
  if (state.profile !== "door") return state;

  const normalized = Array.from(new Set((entityIds ?? []).map((x) => String(x).trim()).filter(Boolean))).sort();
  if (!normalized.length) return state;

  for (const entityId of normalized) {
    if (state.entities.trackedIds.includes(entityId)) continue;

    state.entities.trackedIds.push(entityId);
    ensureEntityTask(state, entityId, "door.target_identification", "Identify this door", "Confirm this specific door instance in context.");
    ensureEntityTask(
      state,
      entityId,
      "door.opening_direction",
      "Resolve opening direction",
      "Resolve swing/push-pull orientation for this door.",
      [`door.target_identification:${entityId}`]
    );
    ensureEntityTask(
      state,
      entityId,
      "door.latch_side",
      "Resolve latch/hinge side",
      "Determine latch and hinge side for this specific door.",
      [`door.opening_direction:${entityId}`]
    );
    ensureEntityTask(
      state,
      entityId,
      "door.clearance_measurement",
      "Measure clearances",
      "Evaluate maneuvering clearances for this specific door.",
      [`door.latch_side:${entityId}`]
    );
    ensureEntityTask(
      state,
      entityId,
      "door.final_decision",
      "Per-door verdict",
      "Store pass/fail/uncertain result for this door.",
      [`door.clearance_measurement:${entityId}`]
    );
  }

  state.history.push(`Entity sync: ${normalized.length} highlighted candidate(s).`);
  markFirstRunnableInProgress(state);
  return state;
}

export function updateTaskGraphFromDecision(state: TaskGraphState, decision: VlmDecision): TaskGraphState {
  if (decision.visibility.isRuleTargetVisible) {
    setTaskStatus(state, "target_identification", "done", "Target appears visible in evidence.");
    setTaskStatus(state, "visibility_validation", "done", `Occlusion=${decision.visibility.occlusionAssessment}.`);
  } else {
    setTaskStatus(state, "visibility_validation", "blocked", "Rule target not visible yet.");
  }

  if (decision.followUp?.request === "SET_PLAN_CUT" || decision.followUp?.request === "SET_STOREY_PLAN_CUT" || decision.followUp?.request === "ISOLATE_CATEGORY") {
    setTaskStatus(state, "measurement_readiness", "in_progress", `Requested ${decision.followUp.request} to improve evidence.`);
    setTaskStatus(state, "clearance_measurement", "in_progress", `Requested ${decision.followUp.request} to improve evidence.`);
  }

  if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && decision.confidence >= 0.7) {
    setTaskStatus(state, "final_decision", "done", `${decision.verdict} @ ${decision.confidence.toFixed(2)} confidence.`);
  }

  state.history.push(`Decision ${decision.verdict} (${decision.confidence.toFixed(2)})`);
  markFirstRunnableInProgress(state);
  return state;
}

export function updateTaskGraphFromFollowUpResult(
  state: TaskGraphState,
  followUp: VlmFollowUp | undefined,
  didSomething: boolean,
  reason: string
): TaskGraphState {
  if (!followUp) return state;

  if (!didSomething) {
    state.history.push(`Follow-up ${followUp.request} failed: ${reason}`);
    return state;
  }

  switch (followUp.request) {
    case "PICK_CENTER":
    case "PICK_OBJECT":
      setTaskStatus(state, "target_identification", "done", `Selection succeeded (${reason}).`);
      setTaskStatus(state, "opening_direction", "in_progress", "Selection highlighted for direction/latch inference.");
      break;
    case "SET_PLAN_CUT":
    case "SET_STOREY_PLAN_CUT":
    case "TOP_VIEW":
    case "ISOLATE_CATEGORY":
    case "HIGHLIGHT_IDS":
      setTaskStatus(state, "measurement_readiness", "done", `Prepared with ${followUp.request}.`);
      setTaskStatus(state, "clearance_measurement", "in_progress", "Ready for clearance interpretation.");
      break;
    case "GET_PROPERTIES":
      setTaskStatus(state, "opening_direction", "in_progress", "Properties fetched for direction/latch inference.");
      break;
    default:
      break;
  }

  state.history.push(`Follow-up ${followUp.request}: ${reason}`);
  markFirstRunnableInProgress(state);
  return state;
}

export function buildTaskGraphPromptSection(state: TaskGraphState): string {
  const tasks = state.tasks
    .map((task, index) => `${index + 1}. [${task.status.toUpperCase()}] ${task.title} (${task.id})`)
    .join("\n");

  const requiredPending = state.tasks
    .filter((task) => task.required && task.status !== "done")
    .map((task) => task.id);

  return [
    "DYNAMIC_CHECKLIST:",
    `profile=${state.profile}`,
    tasks,
    `requiredRemaining=${requiredPending.length > 0 ? requiredPending.join(",") : "none"}`,
    "Instruction: prioritize unresolved required checklist items before final verdict whenever evidence is incomplete.",
  ].join("\n");
}

export function summarizeTaskGraph(state: TaskGraphState): {
  profile: string;
  entities: { trackedIds: string[] };
  tasks: Array<{ id: string; entityId?: string; entityClass?: string; status: TaskStatus }>;
} {
  return {
    profile: state.profile,
    entities: { trackedIds: [...state.entities.trackedIds] },
    tasks: state.tasks.map((task) => ({
      id: task.id,
      entityId: task.entityId,
      entityClass: task.entityClass,
      status: task.status,
    })),
  };
}
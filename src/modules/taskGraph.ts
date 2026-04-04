import type { VlmDecision, VlmFollowUp } from "./vlmChecker";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";
export type TaskGraphProfile =
  | "generic"
  | "door"
  | "stair"
  | "ramp"
  | "space"
  | "object"
  | "visibility"
  | "egress";
export type ConcernKey =
  | "visibility"
  | "regulatory_context"
  | "opening_direction"
  | "hardware_side"
  | "clearance"
  | "dimensions"
  | "headroom"
  | "handrail"
  | "landing"
  | "slope"
  | "fire_rating"
  | "egress_width"
  | "accessibility"
  | "object_clearance"
  | "line_of_sight";

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

type EntityNode = {
  entityId: string;
  entityClass: string;
  clusterId: string;
  storeyId?: string;
  status: TaskStatus;
};

type EntityCluster = {
  id: string;
  label: string;
  storeyId?: string;
  entityIds: string[];
  status: TaskStatus;
};

export type TaskGraphState = {
  profile: TaskGraphProfile;
  intent: {
    source: "rule_library" | "custom_user_prompt" | "unknown";
    primaryClass?: string;
    repeatedEntityClass?: string;
    storeyHint?: string;
    concerns: ConcernKey[];
  };
  tasks: ComplianceTask[];
  history: string[];
  entities: {
    trackedIds: string[];
    activeEntityId?: string;
    activeClusterId?: string;
    queue: string[];
    byId: Record<string, EntityNode>;
    clusters: EntityCluster[];
  };
};

export type CompactTaskGraphState = {
  profile: TaskGraphProfile;
  source: TaskGraphState["intent"]["source"];
  primaryClass?: string;
  concerns: ConcernKey[];
  progress: {
    completedRequired: number;
    totalRequired: number;
    completedEntities: number;
    totalEntities: number;
    completionRatio: number;
  };
  activeTask?: {
    id: string;
    title: string;
    status: TaskStatus;
    entityId?: string;
    entityClass?: string;
  };
  activeEntity?: {
    id: string;
    class?: string;
    storeyId?: string;
    clusterId?: string;
  };
  activeStoreyId?: string;
  clusterProgress?: {
    id: string;
    label: string;
    pendingCount: number;
    totalCount: number;
    status: TaskStatus;
  };
  nextEntityIds: string[];
};

type SyncEntityOptions = {
  storeyId?: string;
  entityClass?: string;
};

function hasKeywords(input: string, keywords: string[]): boolean {
  const normalized = input.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function inferPromptSource(prompt: string): "rule_library" | "custom_user_prompt" | "unknown" {
  const text = String(prompt ?? "");
  if (/SOURCE:\s*RULE_LIBRARY/i.test(text)) return "rule_library";
  if (/SOURCE:\s*CUSTOM_USER_PROMPT/i.test(text)) return "custom_user_prompt";
  return "unknown";
}

function extractTaskSourceText(prompt: string): string {
  const text = String(prompt ?? "");
  const sourceBlock = text.match(/SOURCE_PROMPT_TEXT:\s*([\s\S]*)$/i)?.[1]?.trim();
  return sourceBlock || text;
}

function detectIfcClassHint(text: string): string | undefined {
  const match = text.match(/\bIfc[A-Z][A-Za-z0-9_]+\b/);
  return match?.[0];
}

function detectPrimaryClass(text: string): { profile: TaskGraphProfile; primaryClass?: string } {
  const normalized = ` ${text.toLowerCase()} `;
  const explicitIfcClass = detectIfcClassHint(text);
  if (explicitIfcClass) {
    if (explicitIfcClass === "IfcDoor") return { profile: "door", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcStair" || explicitIfcClass === "IfcStairFlight") return { profile: "stair", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcRamp") return { profile: "ramp", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcSpace") return { profile: "space", primaryClass: explicitIfcClass };
    return { profile: "generic", primaryClass: explicitIfcClass };
  }
  if (hasKeywords(normalized, ["ifcdoor", " door ", "doors", "latch", "hinge", "swing"])) {
    return { profile: "door", primaryClass: "IfcDoor" };
  }
  if (hasKeywords(normalized, ["ifcstair", " stair ", "stairs", "handrail", "riser", "tread"])) {
    return { profile: "stair", primaryClass: "IfcStair" };
  }
  if (hasKeywords(normalized, ["ifcramp", " ramp ", "ramps", "slope"])) {
    return { profile: "ramp", primaryClass: "IfcRamp" };
  }
  if (hasKeywords(normalized, ["visibility", "visible", "occluded", "line of sight", "viewpoint"])) {
    return { profile: "visibility", primaryClass: undefined };
  }
  if (hasKeywords(normalized, ["object", "objects", "fixture", "fixtures", "equipment", "toilet", "sink", "lavatory"])) {
    return { profile: "object", primaryClass: undefined };
  }
  if (hasKeywords(normalized, ["ifcspace", " room ", " space ", "spaces"])) {
    return { profile: "space", primaryClass: "IfcSpace" };
  }
  if (hasKeywords(normalized, ["egress", "exit", "corridor", "path of travel"])) {
    return { profile: "egress", primaryClass: undefined };
  }
  return { profile: "generic", primaryClass: undefined };
}

function detectStoreyHint(text: string): string | undefined {
  const normalized = text.toLowerCase();
  const knownHints = ["ground floor", "first floor", "second floor", "third floor", "roof", "basement", "level 1", "level 2"];
  return knownHints.find((hint) => normalized.includes(hint));
}

function detectConcerns(text: string, profile: TaskGraphProfile): ConcernKey[] {
  const normalized = text.toLowerCase();
  const concerns = new Set<ConcernKey>();
  concerns.add("visibility");

  if (hasKeywords(normalized, ["icc", "ibc", "ada", "a117", "code", "section", "clause", "standard"])) {
    concerns.add("regulatory_context");
  }
  if (hasKeywords(normalized, ["opening direction", "swing", "push", "pull", "opening"])) {
    concerns.add("opening_direction");
  }
  if (hasKeywords(normalized, ["latch", "hinge", "hardware side"])) {
    concerns.add("hardware_side");
  }
  if (hasKeywords(normalized, ["clearance", "maneuver", "approach", "turning space", "obstruction"])) {
    concerns.add("clearance");
  }
  if (hasKeywords(normalized, ["free floor space", "clear floor space", "accessible area", "around objects", "approach space"])) {
    concerns.add("object_clearance");
  }
  if (hasKeywords(normalized, ["width", "height", "depth", "dimension", "measure", "measurement"])) {
    concerns.add("dimensions");
  }
  if (hasKeywords(normalized, ["headroom"])) {
    concerns.add("headroom");
  }
  if (hasKeywords(normalized, ["handrail", "railing"])) {
    concerns.add("handrail");
  }
  if (hasKeywords(normalized, ["landing"])) {
    concerns.add("landing");
  }
  if (hasKeywords(normalized, ["slope", "gradient"])) {
    concerns.add("slope");
  }
  if (hasKeywords(normalized, ["fire rating", "fire-resistance", "smoke", "self-closing", "closing device"])) {
    concerns.add("fire_rating");
  }
  if (hasKeywords(normalized, ["egress width", "means of egress", "clear width", "travel width"])) {
    concerns.add("egress_width");
  }
  if (hasKeywords(normalized, ["visibility", "visible", "occluded", "occlusion", "line of sight", "viewpoint"])) {
    concerns.add("line_of_sight");
  }
  if (hasKeywords(normalized, ["accessible", "accessibility", "wheelchair", "ada", "a117"])) {
    concerns.add("accessibility");
  }

  if (profile === "door") {
    concerns.add("opening_direction");
    concerns.add("hardware_side");
    concerns.add("clearance");
    concerns.add("dimensions");
  } else if (profile === "stair") {
    concerns.add("dimensions");
    concerns.add("handrail");
    concerns.add("landing");
    concerns.add("headroom");
  } else if (profile === "ramp") {
    concerns.add("slope");
    concerns.add("dimensions");
    concerns.add("landing");
  } else if (profile === "space") {
    concerns.add("clearance");
    concerns.add("dimensions");
    concerns.add("accessibility");
    concerns.add("object_clearance");
  } else if (profile === "object") {
    concerns.add("clearance");
    concerns.add("object_clearance");
    concerns.add("accessibility");
  } else if (profile === "visibility") {
    concerns.add("visibility");
    concerns.add("line_of_sight");
  }

  return Array.from(concerns);
}

function extractPromptIntent(prompt: string): TaskGraphState["intent"] & { profile: TaskGraphProfile } {
  const source = inferPromptSource(prompt);
  const sourceText = extractTaskSourceText(prompt);
  const { profile, primaryClass } = detectPrimaryClass(sourceText);
  return {
    source,
    profile,
    primaryClass,
    repeatedEntityClass: primaryClass,
    storeyHint: detectStoreyHint(sourceText),
    concerns: detectConcerns(sourceText, profile),
  };
}

function mergeUniqueConcerns(current: ConcernKey[], incoming: ConcernKey[]) {
  return Array.from(new Set([...current, ...incoming]));
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

function setScopedEntityTaskStatus(
  state: TaskGraphState,
  taskKey: string,
  entityId: string | undefined,
  status: TaskStatus,
  note?: string
) {
  if (!entityId) return;
  const task = state.tasks.find((t) => t.id === `${taskKey}:${entityId}`);
  if (!task) return;
  task.status = status;
  if (note) task.evidenceNotes.push(note);
}

function concernTaskSpec(concern: ConcernKey): { key: string; title: string; description: string } | null {
  switch (concern) {
    case "opening_direction":
      return { key: "entity.opening_direction", title: "Resolve opening direction", description: "Resolve swing or push/pull orientation for this entity." };
    case "hardware_side":
      return { key: "entity.hardware_side", title: "Resolve hinge or latch side", description: "Determine hardware-side orientation for this entity." };
    case "clearance":
      return { key: "entity.clearance", title: "Measure clearances", description: "Evaluate required clearances or free-space conditions for this entity." };
    case "dimensions":
      return { key: "entity.dimensions", title: "Verify dimensions", description: "Measure or verify rule-relevant dimensions for this entity." };
    case "headroom":
      return { key: "entity.headroom", title: "Check headroom", description: "Verify headroom or overhead clearance for this entity." };
    case "handrail":
      return { key: "entity.handrail", title: "Check handrails", description: "Verify handrail presence, continuity, or related stair/ramp conditions." };
    case "landing":
      return { key: "entity.landing", title: "Check landings", description: "Verify landings or landing-related geometry around this entity." };
    case "slope":
      return { key: "entity.slope", title: "Check slope", description: "Verify slope or gradient requirements for this entity." };
    case "fire_rating":
      return { key: "entity.fire_rating", title: "Check fire or smoke requirements", description: "Verify fire-rating, smoke-control, or self-closing requirements for this entity." };
    case "egress_width":
      return { key: "entity.egress_width", title: "Check egress width", description: "Verify clear width or required means-of-egress width for this entity." };
    case "accessibility":
      return { key: "entity.accessibility", title: "Check accessibility criteria", description: "Verify accessibility-specific requirements that apply to this entity." };
    case "object_clearance":
      return { key: "entity.object_clearance", title: "Check accessible area", description: "Verify clear floor or accessible area around the active object or space." };
    case "line_of_sight":
      return { key: "entity.line_of_sight", title: "Check visibility path", description: "Verify line-of-sight and occlusion conditions for the active target." };
    default:
      return null;
  }
}

function buildProfileTasks(intent: TaskGraphState["intent"] & { profile: TaskGraphProfile }): ComplianceTask[] {
  const profileLabel =
    intent.profile === "door" ? "door" :
    intent.profile === "stair" ? "stair" :
    intent.profile === "ramp" ? "ramp" :
    intent.profile === "space" ? "space" :
    intent.profile === "object" ? "object" :
    intent.profile === "visibility" ? "visibility target" :
    intent.profile === "egress" ? "egress target" :
    "target";

  const tasks = [
    createTask("target_identification", `Identify ${profileLabel} candidates`, `Find ${profileLabel} instances that should be checked.`),
    createTask("scope_preparation", "Prepare scope", "Prepare storey, category, or spatial scope so the active entity can be checked efficiently.", true, ["target_identification"]),
    createTask("visibility_validation", "Validate visible target batch", "Confirm the active cluster or target set is visible enough for targeted review.", true, ["scope_preparation"]),
    createTask("measurement_readiness", "Prepare active target context", "Switch to the best view/context so per-entity verification becomes reliable.", true, ["visibility_validation"]),
  ];

  if (intent.concerns.includes("regulatory_context")) {
    tasks.push(
      createTask("regulatory_context", "Resolve regulatory context", "Resolve clause text, threshold values, or exception context needed for this rule.", true, ["target_identification"])
    );
  }

  tasks.push(
    createTask("final_decision", "Issue aggregate verdict", "Return a run-level verdict after active entity subtasks are resolved.", true, ["measurement_readiness"])
  );

  return tasks;
}

function ensureCluster(state: TaskGraphState, storeyId?: string) {
  const normalized = storeyId?.trim() || "unscoped";
  const existing = state.entities.clusters.find((cluster) => cluster.id === normalized);
  if (existing) return existing;

  const cluster: EntityCluster = {
    id: normalized,
    label: normalized === "unscoped" ? "Unscoped entities" : `Storey ${normalized}`,
    storeyId: normalized === "unscoped" ? undefined : normalized,
    entityIds: [],
    status: "pending",
  };
  state.entities.clusters.push(cluster);
  state.entities.clusters.sort((a, b) => a.label.localeCompare(b.label));
  return cluster;
}

function updateEntityQueue(state: TaskGraphState) {
  const pending = state.entities.trackedIds.filter((entityId) => {
    const finalTask = state.tasks.find((task) => task.id === `entity.final_decision:${entityId}`);
    return finalTask?.status !== "done";
  });

  pending.sort((a, b) => {
    const ea = state.entities.byId[a];
    const eb = state.entities.byId[b];
    const clusterCmp = (ea?.clusterId ?? "").localeCompare(eb?.clusterId ?? "");
    if (clusterCmp !== 0) return clusterCmp;
    return a.localeCompare(b);
  });

  state.entities.queue = pending;
  state.entities.activeEntityId = pending[0];
  state.entities.activeClusterId = pending[0] ? state.entities.byId[pending[0]]?.clusterId : undefined;

  for (const cluster of state.entities.clusters) {
    const clusterPending = cluster.entityIds.filter((entityId) => pending.includes(entityId));
    cluster.status = clusterPending.length === 0 ? "done" : clusterPending[0] === state.entities.activeEntityId ? "in_progress" : "pending";
  }
}

function ensureEntityTask(
  state: TaskGraphState,
  entityId: string,
  taskKey: string,
  title: string,
  description: string,
  dependsOn?: string[],
  entityClass = "IfcElement"
) {
  const id = `${taskKey}:${entityId}`;
  if (state.tasks.some((t) => t.id === id)) return;
  state.tasks.push(createTask(id, title, description, true, dependsOn, { entityId, entityClass }));
}

function getActiveEntityId(state: TaskGraphState): string | undefined {
  updateEntityQueue(state);
  return state.entities.activeEntityId;
}

function getActiveEntityTasks(state: TaskGraphState) {
  const activeEntityId = getActiveEntityId(state);
  if (!activeEntityId) return [];
  return state.tasks.filter((task) => task.entityId === activeEntityId);
}

function getCurrentTask(state: TaskGraphState): ComplianceTask | undefined {
  const activeEntityTasks = getActiveEntityTasks(state);
  return (
    activeEntityTasks.find((task) => task.status === "in_progress") ??
    activeEntityTasks.find((task) => task.status === "pending") ??
    state.tasks.find((task) => !task.entityId && task.status === "in_progress") ??
    state.tasks.find((task) => !task.entityId && task.status === "pending")
  );
}

function getRequiredProgress(state: TaskGraphState) {
  const required = state.tasks.filter((task) => task.required);
  const completedRequired = required.filter((task) => task.status === "done").length;
  const totalEntities = state.entities.trackedIds.length;
  const completedEntities = state.entities.trackedIds.filter((entityId) => {
    const finalTask = state.tasks.find((task) => task.id === `entity.final_decision:${entityId}`);
    return finalTask?.status === "done";
  }).length;
  return {
    completedRequired,
    totalRequired: required.length,
    completedEntities,
    totalEntities,
    completionRatio: required.length ? completedRequired / required.length : 0,
  };
}

function buildCompactTaskGraphState(state: TaskGraphState): CompactTaskGraphState {
  updateEntityQueue(state);
  const activeEntityId = state.entities.activeEntityId;
  const activeEntity = activeEntityId ? state.entities.byId[activeEntityId] : undefined;
  const activeCluster = state.entities.clusters.find((cluster) => cluster.id === state.entities.activeClusterId);
  const currentTask = getCurrentTask(state);
  const progress = getRequiredProgress(state);

  return {
    profile: state.profile,
    source: state.intent.source,
    primaryClass: state.intent.primaryClass,
    concerns: [...state.intent.concerns],
    progress,
    activeTask: currentTask
      ? {
          id: currentTask.id,
          title: currentTask.title,
          status: currentTask.status,
          entityId: currentTask.entityId,
          entityClass: currentTask.entityClass,
        }
      : undefined,
    activeEntity: activeEntity
      ? {
          id: activeEntity.entityId,
          class: activeEntity.entityClass,
          storeyId: activeEntity.storeyId,
          clusterId: activeEntity.clusterId,
        }
      : undefined,
    activeStoreyId: activeEntity?.storeyId ?? activeCluster?.storeyId,
    clusterProgress: activeCluster
      ? {
          id: activeCluster.id,
          label: activeCluster.label,
          pendingCount: activeCluster.entityIds.filter((entityId) => state.entities.queue.includes(entityId)).length,
          totalCount: activeCluster.entityIds.length,
          status: activeCluster.status,
        }
      : undefined,
    nextEntityIds: state.entities.queue.slice(0, 3),
  };
}

function rebuildEntityTasksForState(state: TaskGraphState, entityId: string, entityClass: string) {
  ensureEntityTask(state, entityId, "entity.target_identification", `Identify this ${entityClass}`, "Confirm this specific entity instance in context.", undefined, entityClass);
  let previousTaskId = `entity.target_identification:${entityId}`;
  for (const concern of state.intent.concerns) {
    const spec = concernTaskSpec(concern);
    if (!spec) continue;
    ensureEntityTask(state, entityId, spec.key, spec.title, spec.description, [previousTaskId], entityClass);
    previousTaskId = `${spec.key}:${entityId}`;
  }
  ensureEntityTask(state, entityId, "entity.final_decision", "Per-entity verdict", "Store pass/fail/uncertain result for this entity.", [previousTaskId], entityClass);
}

export function createTaskGraph(rulePrompt: string): TaskGraphState {
  const intent = extractPromptIntent(rulePrompt);
  const state: TaskGraphState = {
    profile: intent.profile,
    intent: {
      source: intent.source,
      primaryClass: intent.primaryClass,
      repeatedEntityClass: intent.repeatedEntityClass,
      storeyHint: intent.storeyHint,
      concerns: [...intent.concerns],
    },
    tasks: buildProfileTasks(intent),
    history: [],
    entities: { trackedIds: [], queue: [], byId: {}, clusters: [] },
  };

  markFirstRunnableInProgress(state);
  return state;
}

function markFirstRunnableInProgress(state: TaskGraphState) {
  const active = state.tasks.some((task) => task.status === "in_progress" && !task.entityId);
  if (!active) {
    const next = state.tasks.find((task) => !task.entityId && task.status === "pending" && canStartTask(task, state));
    if (next) next.status = "in_progress";
  }

  const activeEntityId = getActiveEntityId(state);
  if (!activeEntityId) return;
  const entityTasks = state.tasks.filter((task) => task.entityId === activeEntityId);
  if (entityTasks.some((task) => task.status === "in_progress")) return;
  const nextEntityTask = entityTasks.find((task) => task.status === "pending" && canStartTask(task, state));
  if (nextEntityTask) nextEntityTask.status = "in_progress";
}

export function syncTaskGraphEntities(state: TaskGraphState, entityIds: string[], options?: SyncEntityOptions) {
  if (!state.intent.repeatedEntityClass) return state;

  const normalized = Array.from(new Set((entityIds ?? []).map((x) => String(x).trim()).filter(Boolean))).sort();
  if (!normalized.length) return state;

  const cluster = ensureCluster(state, options?.storeyId);
  for (const entityId of normalized) {
    if (state.entities.trackedIds.includes(entityId)) {
      const existing = state.entities.byId[entityId];
      if (existing && options?.storeyId && !existing.storeyId) existing.storeyId = options.storeyId;
      continue;
    }

    const entityClass = options?.entityClass ?? state.intent.repeatedEntityClass;
    state.entities.trackedIds.push(entityId);
    state.entities.byId[entityId] = {
      entityId,
      entityClass,
      clusterId: cluster.id,
      storeyId: options?.storeyId,
      status: "pending",
    };
    if (!cluster.entityIds.includes(entityId)) cluster.entityIds.push(entityId);

    rebuildEntityTasksForState(state, entityId, entityClass);
  }

  updateEntityQueue(state);
  state.history.push(`Entity sync: ${normalized.length} candidate(s) -> cluster=${cluster.label}.`);
  markFirstRunnableInProgress(state);
  return state;
}

export function getTaskGraphFocus(state: TaskGraphState): {
  activeEntityId?: string;
  activeClusterId?: string;
  activeStoreyId?: string;
  suggestedHighlightIds: string[];
  queue: string[];
  activeClusterQueue: string[];
} {
  updateEntityQueue(state);
  const queue = state.entities.queue.slice(0, 5);
  const activeClusterId = state.entities.activeClusterId;
  const activeClusterQueue = activeClusterId
    ? state.entities.queue.filter((entityId) => state.entities.byId[entityId]?.clusterId === activeClusterId).slice(0, 5)
    : [];
  return {
    activeEntityId: state.entities.activeEntityId,
    activeClusterId,
    activeStoreyId: state.entities.activeEntityId
      ? state.entities.byId[state.entities.activeEntityId]?.storeyId
      : undefined,
    suggestedHighlightIds: state.entities.activeEntityId ? [state.entities.activeEntityId] : queue.slice(0, 3),
    queue,
    activeClusterQueue,
  };
}

export function updateTaskGraphFromDecision(state: TaskGraphState, decision: VlmDecision): TaskGraphState {
  const activeEntityId = getActiveEntityId(state);

  if (decision.visibility.isRuleTargetVisible) {
    setTaskStatus(state, "target_identification", "done", "Target appears visible in evidence.");
    setTaskStatus(state, "visibility_validation", "done", `Occlusion=${decision.visibility.occlusionAssessment}.`);
    setScopedEntityTaskStatus(state, "entity.target_identification", activeEntityId, "done", "Active entity is visible.");
  } else {
    setTaskStatus(state, "visibility_validation", "blocked", "Rule target not visible yet.");
  }

  if (decision.followUp?.request === "WEB_FETCH") {
    setTaskStatus(state, "regulatory_context", "in_progress", "Requested regulatory grounding.");
  }

  if (
    decision.followUp?.request === "SET_PLAN_CUT" ||
    decision.followUp?.request === "SET_STOREY_PLAN_CUT" ||
    decision.followUp?.request === "ISOLATE_CATEGORY" ||
    decision.followUp?.request === "ISOLATE_STOREY" ||
    decision.followUp?.request === "TOP_VIEW" ||
    decision.followUp?.request === "HIDE_CATEGORY"
  ) {
    setTaskStatus(state, "measurement_readiness", "in_progress", `Requested ${decision.followUp.request} to improve evidence.`);
    for (const concern of state.intent.concerns) {
      const spec = concernTaskSpec(concern);
      if (!spec) continue;
      setScopedEntityTaskStatus(state, spec.key, activeEntityId, "in_progress", `Requested ${decision.followUp.request} for active entity.`);
    }
  }

  if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && decision.confidence >= 0.7) {
    setTaskStatus(state, "final_decision", "done", `${decision.verdict} @ ${decision.confidence.toFixed(2)} confidence.`);
    setScopedEntityTaskStatus(state, "entity.final_decision", activeEntityId, "done", `${decision.verdict} @ ${decision.confidence.toFixed(2)}.`);
    if (activeEntityId && state.entities.byId[activeEntityId]) state.entities.byId[activeEntityId].status = "done";
  }

  updateEntityQueue(state);
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
  const activeEntityId = getActiveEntityId(state);

  if (!didSomething) {
    state.history.push(`Follow-up ${followUp.request} failed: ${reason}`);
    return state;
  }

  switch (followUp.request) {
    case "PICK_CENTER":
    case "PICK_OBJECT":
    case "HIGHLIGHT_IDS":
      setTaskStatus(state, "target_identification", "done", `Selection succeeded (${reason}).`);
      setScopedEntityTaskStatus(state, "entity.target_identification", activeEntityId, "done", `Entity selected (${reason}).`);
      for (const concern of ["opening_direction", "hardware_side", "dimensions", "clearance"] as ConcernKey[]) {
        if (state.intent.concerns.includes(concern)) {
          const spec = concernTaskSpec(concern);
          if (spec) setScopedEntityTaskStatus(state, spec.key, activeEntityId, "in_progress", "Active entity ready for targeted review.");
        }
      }
      break;
    case "SET_PLAN_CUT":
    case "SET_STOREY_PLAN_CUT":
    case "TOP_VIEW":
    case "ISOLATE_CATEGORY":
    case "ISOLATE_STOREY":
    case "HIDE_CATEGORY":
      setTaskStatus(state, "scope_preparation", "done", `Prepared with ${followUp.request}.`);
      setTaskStatus(state, "measurement_readiness", "done", `Prepared with ${followUp.request}.`);
      for (const concern of state.intent.concerns) {
        const spec = concernTaskSpec(concern);
        if (!spec) continue;
        setScopedEntityTaskStatus(state, spec.key, activeEntityId, "in_progress", `Prepared with ${followUp.request}.`);
      }
      break;
    case "GET_PROPERTIES":
      setScopedEntityTaskStatus(state, "entity.opening_direction", activeEntityId, "in_progress", "Properties fetched for entity-specific inference.");
      setScopedEntityTaskStatus(state, "entity.hardware_side", activeEntityId, "in_progress", "Properties available for hardware-side inference.");
      break;
    case "WEB_FETCH":
      setTaskStatus(state, "regulatory_context", "done", "Regulatory context fetched.");
      break;
    default:
      break;
  }

  updateEntityQueue(state);
  state.history.push(`Follow-up ${followUp.request}: ${reason}`);
  markFirstRunnableInProgress(state);
  return state;
}

export function markActiveEntityInconclusive(state: TaskGraphState, note: string): TaskGraphState {
  const activeEntityId = getActiveEntityId(state);
  if (!activeEntityId) return state;

  for (const task of state.tasks) {
    if (task.entityId !== activeEntityId) continue;
    if (task.id === `entity.final_decision:${activeEntityId}`) {
      task.status = "done";
      task.evidenceNotes.push(note);
      continue;
    }
    if (task.status !== "done") {
      task.status = "blocked";
      task.evidenceNotes.push(note);
    }
  }

  if (state.entities.byId[activeEntityId]) {
    state.entities.byId[activeEntityId].status = "blocked";
  }
  state.history.push(`Entity ${activeEntityId} marked inconclusive: ${note}`);
  updateEntityQueue(state);
  markFirstRunnableInProgress(state);
  return state;
}

export function buildTaskGraphPromptSection(state: TaskGraphState): string {
  const compact = buildCompactTaskGraphState(state);
  return [
    "DYNAMIC_CHECKLIST:",
    `source=${state.intent.source}`,
    `profile=${compact.profile}`,
    `primaryClass=${state.intent.primaryClass ?? "none"}`,
    `concerns=${state.intent.concerns.join(",") || "none"}`,
    `progress=${compact.progress.completedRequired}/${compact.progress.totalRequired}`,
    `entityProgress=${compact.progress.completedEntities}/${compact.progress.totalEntities}`,
    `activeStorey=${compact.activeStoreyId ?? "none"}`,
    `activeEntity=${compact.activeEntity?.id ?? "none"}`,
    `activeEntityClass=${compact.activeEntity?.class ?? state.intent.primaryClass ?? "none"}`,
    `activeTask=${compact.activeTask ? `${compact.activeTask.id}|${compact.activeTask.status}` : "none"}`,
    `clusterProgress=${compact.clusterProgress ? `${compact.clusterProgress.pendingCount}/${compact.clusterProgress.totalCount}|${compact.clusterProgress.status}` : "none"}`,
    `nextEntities=${compact.nextEntityIds.join(",") || "none"}`,
    "Instruction: use this checklist only as the current task brief. Ignore completed or unrelated subtasks.",
    "Instruction: stay focused on the activeTask and activeEntity first. Prefer per-entity navigation, measurement, and highlighting over bulk verdicts.",
    "Instruction: if repeated targets exist on the same storey, reuse the current storey and view setup before moving to the next entity.",
  ].join("\n");
}

export function summarizeTaskGraph(state: TaskGraphState): CompactTaskGraphState {
  return buildCompactTaskGraphState(state);
}

export function enrichTaskGraphFromText(state: TaskGraphState, text: string): TaskGraphState {
  const sourceText = extractTaskSourceText(text);
  const { profile, primaryClass } = detectPrimaryClass(sourceText);
  if (state.profile === "generic" && profile !== "generic") {
    state.profile = profile;
  }
  if (!state.intent.primaryClass && primaryClass) {
    state.intent.primaryClass = primaryClass;
    state.intent.repeatedEntityClass = primaryClass;
  }
  if (!state.intent.storeyHint) {
    state.intent.storeyHint = detectStoreyHint(sourceText);
  }
  if (state.intent.source === "unknown") {
    state.intent.source = inferPromptSource(text);
  }
  state.intent.concerns = mergeUniqueConcerns(state.intent.concerns, detectConcerns(sourceText, state.profile));

  for (const entityId of state.entities.trackedIds) {
    const entityClass = state.entities.byId[entityId]?.entityClass ?? state.intent.repeatedEntityClass ?? "IfcElement";
    rebuildEntityTasksForState(state, entityId, entityClass);
  }

  state.history.push(`Prompt enrichment: profile=${state.profile}, class=${state.intent.primaryClass ?? "none"}, concerns=${state.intent.concerns.join("|") || "none"}.`);
  markFirstRunnableInProgress(state);
  return state;
}

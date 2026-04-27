# Compliance Reasoning Analysis

**Date**: April 26, 2026  
**Goal**: document the current prototype's real compliance reasoning behavior, the primary JSON format, the independent judge agent, every currently supported scenario, and all files involved.

## 1. Executive Summary

The current prototype's compliance reasoning is not a single model call or a single file. It is a layered runtime pipeline:

1. `src/ui/panel.ts`
   Owns rule selection vs custom prompt entry, queueing, run startup, trace assembly, judge-agent invocation, and export.
2. `src/modules/vlmAdapters/prompts/promptWrappers.ts`
   Owns the current primary compliance prompt contract, including the expected JSON shape, generalized evidence requirements, and model behavior instructions.
3. `src/modules/taskGraph.ts`
   Owns prompt-to-profile interpretation, concern inference, task/entity queues, and the active task brief injected into the prompt as `DYNAMIC_CHECKLIST`.
4. `src/modules/complianceRunner.ts`
   Owns the real compliance loop: snapshot capture, context assembly, evidence-requirement derivation, follow-up selection, anti-repeat control, entity progression, and navigation execution.
5. `src/modules/vlmChecker.ts`
   Owns the primary structured decision contract and optional regulatory grounding flow, including internal `WEB_FETCH` handling.
6. `src/modules/vlmAdapters/openrouter.ts` and `src/modules/vlmAdapters/openai.ts`
   Own provider-specific model calls, structured-output parsing, and some provider-side follow-up overrides.
7. `src/modules/judgeAgent.ts`
   Owns the secondary independent judge pass over the completed trace and evidence bundle.
8. `src/reporting/reportGenerator.ts`
   Owns how the primary trace and judge results are rendered into the final compliance report.

The central runtime bridge is `src/modules/complianceRunner.ts`. That file sits between the semantic model output and the real viewer operations. It does not simply execute the model's suggested navigation. Instead, it converts model-reported evidence gaps into a generalized evidence-requirement state, then chooses or suppresses actions deterministically.

## 2. Files Involved

### Core compliance reasoning path

- `src/main.ts`
- `src/ui/panel.ts`
- `src/modules/complianceRunner.ts`
- `src/modules/vlmChecker.ts`
- `src/modules/taskGraph.ts`
- `src/modules/judgeAgent.ts`
- `src/modules/regulatoryReducer.ts`
- `src/modules/snapshotCollector.ts`

### Prompting and model-adapter files

- `src/modules/vlmAdapters/prompts/promptWrappers.ts`
- `src/modules/vlmAdapters/prompts/basePrompt.ts`
- `src/modules/vlmAdapters/prompts/vlmPrompt.ts`
- `src/modules/vlmAdapters/openrouter.ts`
- `src/modules/vlmAdapters/openai.ts`
- `src/modules/vlmAdapters/tools/webFetch.ts`
- `src/modules/vlmAdapters/tools/tavilySearch.ts`

### Viewer/navigation dependencies used by compliance reasoning

- `src/viewer/api.ts`
- `src/modules/navigationAgent.ts`

### Data, types, persistence, and reporting

- `src/data/ruleLibrary.json`
- `src/types/rule.types.ts`
- `src/types/evidenceRequirements.types.ts`
- `src/types/trace.types.ts`
- `src/storage/complianceDb.ts`
- `src/storage/traceDb.ts`
- `src/storage/ruleDb.ts`
- `src/storage/dbConfig.ts`
- `src/reporting/reportGenerator.ts`

### Configuration that changes reasoning behavior

- `src/config/prototypeSettings.ts`
- `src/config/openRouterModels.ts`
- `src/config/environment.ts`

## 3. Runtime Entry And Control Flow

The real compliance flow starts in `src/ui/panel.ts`:

- The panel either builds a prompt from a selected library rule or uses a custom user prompt.
- It chooses deterministic start settings.
- It applies the active VLM provider configuration.
- It starts `complianceRunner.start(...)`.
- After the runner returns, it assembles a `ConversationTrace`.
- It then runs the independent judge agent.
- Finally it stores the trace and enables HTML/JSON export.

The actual run loop lives in `src/modules/complianceRunner.ts`.

At run start the runner:

- checks a model is loaded
- resets viewer visibility and snapshot state
- creates a fresh run id
- creates a task graph from the prompt
- applies deterministic start pose if configured
- attempts metadata seeding for task/entity focus

During each step the runner:

1. captures a snapshot
2. builds `EvidenceContext`
3. computes snapshot novelty
4. derives generalized evidence requirements
5. appends `DYNAMIC_CHECKLIST` to the prompt
6. calls `vlmChecker.check(...)`
7. updates task/entity state from the decision
8. stores the decision in `complianceDb`
9. derives a runtime follow-up plan from evidence requirements
10. applies anti-repeat and low-novelty guards
11. executes the follow-up against `viewerApi`
12. logs navigation/evaluation state for trace/report generation

The loop ends when one of these happens:

- a confident `PASS` or `FAIL` completes the final entity/run
- the runner advances to another entity and continues
- the active entity is marked inconclusive
- the user stops or skips the run
- max steps are reached

## 4. Primary Compliance Decision JSON

The main structured decision type is `VlmDecision` in `src/modules/vlmChecker.ts`.

It currently contains:

- `decisionId`
- `timestampIso`
- `verdict`
- `confidence`
- `rationale`
- `missingEvidence?`
- `evidenceRequirementsStatus?`
- `visibility`
- `evidence`
- `followUp?`
- `meta`

Semantically, this means:

- `verdict` is the primary model's current compliance judgment for the active evidence window.
- `confidence` is normalized to `[0,1]`.
- `rationale` is expected to stay short and evidence-grounded.
- `missingEvidence` is the explicit semantic gap list.
- `evidenceRequirementsStatus` is the generalized state that the runtime planner uses.
- `visibility` describes target visibility and occlusion.
- `evidence.snapshotIds` must reference the current evidence window only.
- `followUp` is advisory, not authoritative.
- `meta` stores provider/model/prompt/token information for auditability.

The prompt contract for this JSON is defined in `src/modules/vlmAdapters/prompts/promptWrappers.ts`.

The current required JSON shape is:

- `verdict`: `"PASS" | "FAIL" | "UNCERTAIN"`
- `confidence`: `number`
- `rationale`: `string`
- `missingEvidence?`: `string[]`
- `evidenceRequirementsStatus?`: object of generalized evidence flags
- `visibility`: `{ isRuleTargetVisible, occlusionAssessment, missingEvidence? }`
- `evidence`: `{ snapshotIds, mode, note? }`
- `followUp?`: `{ request, params? }`

## 5. Generalized Evidence Requirements

The generalized evidence-requirement keys are defined in `src/types/evidenceRequirements.types.ts`:

- `targetVisible`
- `targetFocused`
- `planMeasurementNeeded`
- `planMeasurementReady`
- `contextViewNeeded`
- `contextViewReady`
- `obstructionContextNeeded`
- `dimensionReferenceNeeded`
- `regulatoryClauseNeeded`
- `occlusionProblem`
- `lowNoveltyOrRepeatedView`
- `bothSidesOrSurroundingsNeeded`

These are central to the current compliance reasoning design.

The model is instructed to report them, but the runner also derives or corrects them from actual runtime state in `deriveRuntimeEvidenceRequirements(...)` inside `src/modules/complianceRunner.ts`.

The runtime currently derives them from:

- model visibility claims
- active highlight state
- projected target area ratio
- zoom exhaustion
- prompt-inferred concerns
- door-clearance readiness annotations
- plan-cut state
- floor-context signals
- occlusion metrics
- semantic missing-evidence text
- novelty/redundancy metrics
- repeated-entity workflow statistics

This means the current prototype does not rely purely on the model's explanation of what is missing. It merges semantic reasoning with deterministic viewer state.

## 6. How Follow-Up Planning Really Works

The follow-up planner lives in `chooseFollowUpFromEvidenceRequirements(...)` in `src/modules/complianceRunner.ts`.

This is one of the most important current architectural facts:

- the model may suggest a follow-up
- the runner computes its own evidence-requirement state
- the runner may choose a different action than the model suggested
- the chosen action is logged together with source and reasoning

Current follow-up planning priorities are:

1. `regulatoryClauseNeeded`
   Preserve advisory `WEB_FETCH` if clause text is missing.
2. `targetVisible === false`
   Narrow scope to storey, category, or explicit highlight.
3. `targetFocused === false`
   Highlight the active entity or zoom in.
4. `planMeasurementNeeded && !planMeasurementReady`
   Prefer `TOP_VIEW`, then `SET_STOREY_PLAN_CUT`, then `SET_PLAN_CUT`.
5. `obstructionContextNeeded && occlusionProblem`
   Prefer category narrowing and then bounded `ORBIT`.
6. `contextViewNeeded && !contextViewReady`
   Prefer bounded `ORBIT`, otherwise generic `NEW_VIEW`.
7. If no stronger runtime action is needed
   Keep the advisory/provider follow-up.

The planner therefore translates evidence state into action families rather than following rule-specific hardcoded scripts.

## 7. Current Follow-Up Action Vocabulary

The current supported follow-up schema in `src/modules/vlmChecker.ts` includes:

- `NEW_VIEW`
- `SET_VIEW_PRESET`
- `TOP_VIEW`
- `ISO_VIEW`
- `ORBIT`
- `ZOOM_IN`
- `ISOLATE_STOREY`
- `ISOLATE_SPACE`
- `ISOLATE_CATEGORY`
- `HIDE_IDS`
- `SHOW_IDS`
- `RESET_VISIBILITY`
- `HIDE_CATEGORY`
- `SHOW_CATEGORY`
- `PICK_CENTER`
- `PICK_OBJECT`
- `GET_PROPERTIES`
- `HIGHLIGHT_IDS`
- `HIDE_SELECTED`
- `SET_PLAN_CUT`
- `SET_STOREY_PLAN_CUT`
- `CLEAR_PLAN_CUT`
- `RESTORE_VIEW`
- `WEB_FETCH`

The executor for these actions lives in `executeFollowUp(...)` in `src/modules/complianceRunner.ts`.

Important implementation detail:

- `PICK_CENTER`, `PICK_OBJECT`, and `GET_PROPERTIES` are currently routed through highlighting/focus behavior rather than precise viewer picking logic.
- `TOP_VIEW`, `SET_PLAN_CUT`, `SET_STOREY_PLAN_CUT`, `ISOLATE_CATEGORY`, `HIDE_CATEGORY`, and `ORBIT` are especially important in the present reasoning pipeline.

## 8. Task Graph And Entity-Oriented Reasoning

The current prototype no longer reasons only at the whole-run level. It attempts to reason per entity when repeated targets exist.

That logic lives in `src/modules/taskGraph.ts`.

### Current task-graph profiles

- `generic`
- `door`
- `stair`
- `ramp`
- `space`
- `object`
- `visibility`
- `egress`

### Current concern categories

- `visibility`
- `regulatory_context`
- `opening_direction`
- `hardware_side`
- `clearance`
- `dimensions`
- `headroom`
- `handrail`
- `landing`
- `slope`
- `fire_rating`
- `egress_width`
- `accessibility`
- `object_clearance`
- `line_of_sight`

### What the task graph currently does

- infers profile and concerns from prompt text
- builds a generic run-level task sequence
- builds per-entity subtasks when repeated entities are tracked
- keeps an active entity queue
- groups entities into storey-based clusters
- injects a compact active-task brief into the prompt as `DYNAMIC_CHECKLIST`
- advances entities one-by-one rather than reasoning about all targets at once

The current `DYNAMIC_CHECKLIST` includes:

- prompt source
- inferred profile
- primary IFC class
- active concerns
- required-progress counters
- entity-progress counters
- active storey
- active entity
- active entity class
- active task id/status
- cluster progress
- next entity ids

This means the active model call is not supposed to reason about the whole building each step. It is supposed to reason about the active task/entity context first.

## 9. Regulatory Grounding And WEB_FETCH

Regulatory grounding is currently handled inside `src/modules/vlmChecker.ts`.

### Important current behavior

- If the prompt source is `rule_library`, web grounding is disabled.
- If the prompt source is `custom_user_prompt`, web grounding can be used.
- If the prompt is vague and allowlisted domains exist, the checker may prefetch regulatory context before the model asks for it.
- If the model requests `WEB_FETCH`, the checker executes that tool internally and re-runs the model with injected `REGULATORY_CONTEXT`.

### Current evidence sources

- direct Tavily fetch/extract
- proxy-based fetch via `VITE_WEB_FETCH_PROXY_URL`
- Tavily search fallback when direct fetch is not possible
- optional OpenRouter-based text reduction through `src/modules/regulatoryReducer.ts`

### Key current limitation

The predefined rule-library mode is still primarily visual. It cannot currently enrich itself with authoritative code text through `WEB_FETCH`, even if a rule concept is regulatory in nature.

## 10. Provider-Specific Reasoning Behavior

### OpenRouter path

`src/modules/vlmAdapters/openrouter.ts` is currently the most sophisticated primary adapter.

It does all of the following:

- wraps the prompt with the current primary compliance prompt contract
- sends image evidence plus structured evidence JSON
- parses JSON robustly
- applies fallback retry if the model returns non-JSON
- adds provider-level follow-up overrides

The provider override logic is especially important for:

- door-task ordering
- stair-task ordering
- ramp-task ordering
- forcing `TOP_VIEW`
- forcing `SET_STOREY_PLAN_CUT`
- forcing `HIGHLIGHT_IDS`
- suppressing repeated `ZOOM_IN`

This means current compliance reasoning is shaped both by:

- generic runtime evidence planning in `complianceRunner.ts`
- provider-specific tactical override logic in `openrouter.ts`

### OpenAI path

`src/modules/vlmAdapters/openai.ts` is more constrained.

It currently:

- uses the OpenAI Responses API
- uses strict JSON schema
- supports only a smaller follow-up schema
- does not include the same provider-side override richness as OpenRouter

So the OpenRouter path is currently the richer and more opinionated implementation.

## 11. Anti-Repeat, Low-Novelty, And Entity Finalization

The current prototype has substantial loop-control logic in `src/modules/complianceRunner.ts`.

### Current anti-loop mechanisms

- repeated follow-up escalation
- low-novelty detection from consecutive same-entity snapshots
- bounded orbit budgets per entity
- repeated uncertain-workflow detection
- per-entity step budgets
- explicit entity inconclusive finalization

### Current finalization scenarios

The runner can currently finalize or advance because:

- the entity got a confident `PASS`
- the entity got a confident `FAIL`
- focused zoom was exhausted and no better action remained
- repeated uncertain evidence hit the uncertain-step threshold
- repeated identical workflow states stalled the entity
- the per-entity step budget was reached
- the required decisive evidence bundle was already collected but still could not support `PASS` or `FAIL`
- no further follow-up was proposed
- low-novelty anti-repeat suppressed or finalized the entity

This makes the present reasoning loop much more than “model asks for another image.” It is now a guarded multi-step entity workflow with deterministic termination rules.

## 12. Independent Judge Agent

The independent judge agent lives in `src/modules/judgeAgent.ts`.

It is a second-pass audit over the completed primary evidence trace. It does not control navigation.

### What it receives

The judge receives a compacted evidence packet that includes:

- rule title, description, and category
- prompt excerpt from the latest prompt
- final primary verdict/confidence/rationale
- up to the last six primary decision claims
- snapshot ids and notes
- attached snapshot images
- up to the last three regulatory/web evidence entries

### What it deliberately omits

The judge prompt explicitly removes:

- raw camera details
- target coordinates
- navigation metrics
- full raw prompts
- scene-state internals

The intent is to make the judge reason over evidence, not over internal viewer mechanics.

### Judge output

The judge returns:

- overall `verdict`
- overall `confidence`
- overall `rationale`
- `taskVerdicts[]`
- `suggestionsForUser[]`
- `debuggingAndSuggestions`

### Current judge execution modes

- `mock`
- `openai`
- `openrouter`

### Current multi-entity judge behavior

If the trace includes multiple distinct entities, the judge can slice the run by entity and judge each slice separately before combining them into an aggregate judge report.

### Important current outcome behavior

In `src/ui/panel.ts`, after the judge finishes:

- `trace.finalVerdict` is replaced by `trace.judgeReport.verdict`
- `trace.finalConfidence` is replaced by `trace.judgeReport.confidence`
- `trace.finalRationale` is replaced by `trace.judgeReport.rationale`

So the stored/exported final run outcome is currently judge-authoritative once the judge succeeds.

## 13. Current Rule-Library Scenarios

The embedded rule library in `src/data/ruleLibrary.json` currently contains 11 scenarios:

1. `VLM-ACC-RAMP-001` — `207 Accessible Ramp Rule`
2. `VLM-ACC-DOOR-001` — `208 Accessible Door Rule`
3. `VLM-ACC-FLOOR-001` — `209 Free Floor Space`
4. `VLM-ACC-STAIR-001` — `210 Accessible Stair Rule`
5. `VLM-MAINT-FRONT-001` — `226 Free Area in Front of Components`
6. `VLM-SAFE-GUARD-001` — `236 Guarding Against Falling`
7. `VLM-ACC-SPACE-001` — `246 Accessible Space`
8. `VLM-CIRC-WIDTH-001` — `247 Local Accessible Circulation Rule`
9. `VLM-ACC-OBJECT-001` — `248 Accessible Area around Objects`
10. `VLM-QUAL-VISIBILITY-001` — `250 Component Visibility`
11. `VLM-SAFE-HEADROOM-001` — `252 Headroom Clearance`

These scenarios map broadly to the current inferred runtime profiles:

- ramp
- door
- stair
- space
- object
- visibility
- circulation / egress-like movement-space checks
- generic safety checks

## 14. Current Trace, Persistence, And Reporting Outputs

### Decisions-only storage

`src/storage/complianceDb.ts` currently stores the raw per-step `VlmDecision` records by `runId`.

### Full trace storage

`src/storage/traceDb.ts` stores the assembled `ConversationTrace`, including:

- prompts
- responses
- snapshots
- navigation actions
- scene states
- metrics
- web evidence
- judge report

### Reporting

`src/reporting/reportGenerator.ts` renders:

- the rule summary
- final summary and metrics
- entity-level grouped traces
- judge verdict cards
- judge suggestions/debugging appendix
- snapshot evidence linked to steps/entities

The current HTML report is therefore based on both:

- the primary step-by-step compliance reasoning trace
- the secondary judge review

## 15. Current Architectural Reality

The current prototype's compliance reasoning should be described as:

- a prompt-driven, task-graph-aware, entity-oriented inspection loop
- grounded in structured JSON decisions
- merged with deterministic viewer/evidence state
- protected by novelty and anti-repeat controls
- optionally enriched by regulatory text for custom prompts
- post-audited by an independent secondary judge agent

This is no longer just a simple “VLM checks one snapshot and answers pass/fail” prototype. The current implementation is already a hybrid reasoning system with:

- semantic model reasoning
- deterministic state interpretation
- rule-aware prompt shaping
- runtime evidence planning
- entity batching and progression
- post-hoc independent adjudication

## 16. Most Important Current Limitations

The current analysis also reveals several important boundaries:

1. Rule-library mode disables `WEB_FETCH`, so predefined rules remain mostly visual-only.
2. The OpenRouter adapter currently contains significant provider-specific follow-up logic, so behavior is not fully centralized in the runner.
3. Legacy actions such as `PICK_OBJECT` and `GET_PROPERTIES` are still normalized into highlight/focus behavior rather than exact picking-driven reasoning.
4. The judge replaces final run verdict fields after the primary run, so “primary final result” and “stored final result” are not the same thing.
5. Prompt, adapter, runner, and provider override logic are all contributing to compliance reasoning at once, which makes the behavior powerful but distributed across several files.

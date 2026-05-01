# Compliance Reasoning State-Of-The-Art Analysis

**Date**: April 28, 2026  
**Goal**: document the most advanced currently active compliance reasoning system in the app, with emphasis on what makes it state-of-the-art inside this repository, how the reasoning layers interact, and which files now define the best available behavior.

---

## 1. Executive Summary

The current state-of-the-art compliance reasoning system in this app is no longer a simple “prompt + image + verdict” loop.

It is now a **hybrid compliance reasoning architecture** that combines:

- prompt-shaped multimodal reasoning,
- generalized evidence-requirement modeling,
- task-graph-guided entity progression,
- deterministic runtime follow-up planning,
- semantic evidence-progress tracking,
- low-novelty and recurrence suppression,
- provider-side tactical overrides,
- optional regulatory grounding for custom prompts,
- and an independent contradiction-aware judge pass.

The strongest current implementation path is:

1. `src/ui/panel.ts`
   Builds and launches the run, assembles the full trace, and invokes the judge.
2. `src/modules/vlmAdapters/prompts/promptWrappers.ts`
   Defines the current best prompt contract for the primary model.
3. `src/modules/taskGraph.ts`
   Provides the active task/entity brief and keeps repeated-target reasoning structured.
4. `src/modules/vlmChecker.ts`
   Enforces the structured decision contract and handles regulatory grounding.
5. `src/modules/vlmAdapters/openrouter.ts`
   Adds the richest current provider-side tactical logic.
6. `src/modules/complianceRunner.ts`
   Converts semantic evidence gaps into a deterministic stateful inspection loop.
7. `src/modules/judgeAgent.ts`
   Performs a secondary audit over the full evidence packet and checks for contradictions.

Inside this repository, **the current state-of-the-art is not one file**. It is the interaction of those layers, with `complianceRunner.ts` acting as the central reasoning orchestrator.

---

## 2. What “State-Of-The-Art” Means In This App

Within this codebase, the current state-of-the-art compliance reasoning system is defined by the following properties:

1. It reasons in terms of **evidence requirements**, not only raw navigation actions.
2. It reasons **per task and per entity**, not only per run.
3. It tracks whether evidence is **making semantic progress**, not only whether steps are changing visually.
4. It suppresses repeated low-value follow-ups using **novelty and recurrence controls**.
5. It can optionally ground vague custom prompts in **regulatory/web evidence**.
6. It records the whole reasoning path into a trace suitable for review, replay, and export.
7. It subjects the primary result to a **secondary judge audit** that explicitly looks for evidence/verdict contradictions.

This makes the current system qualitatively different from an earlier VLM prototype that simply asked for another view when uncertain.

---

## 3. Core Files Defining The Current Best System

### Primary reasoning core

- `src/modules/complianceRunner.ts`
- `src/modules/vlmChecker.ts`
- `src/modules/taskGraph.ts`
- `src/modules/vlmAdapters/prompts/promptWrappers.ts`
- `src/modules/vlmAdapters/openrouter.ts`

### Secondary review layer

- `src/modules/judgeAgent.ts`
- `src/ui/panel.ts`
- `src/reporting/reportGenerator.ts`

### Supporting types, data, and configuration

- `src/types/evidenceRequirements.types.ts`
- `src/types/trace.types.ts`
- `src/types/rule.types.ts`
- `src/data/ruleLibrary.json`
- `src/config/prototypeSettings.ts`

### Viewer and execution dependencies

- `src/viewer/api.ts`
- `src/modules/navigationAgent.ts`
- `src/modules/snapshotCollector.ts`

---

## 4. State-Of-The-Art Runtime Flow

The current best reasoning path works like this:

1. The panel builds a coupled prompt from either:
   - a rule-library rule, or
   - a custom user prompt.
2. The compliance runner initializes a task graph and a fresh evidence run.
3. Each step captures a snapshot plus runtime evidence context.
4. The runner derives generalized evidence requirements from viewer state and previous reasoning.
5. The task graph injects `DYNAMIC_CHECKLIST` into the model prompt.
6. The VLM returns a structured decision with:
   - verdict,
   - confidence,
   - rationale,
   - missingEvidence,
   - evidenceRequirementsStatus,
   - visibility,
   - evidence,
   - optional followUp.
7. The runner computes semantic evidence progress for the active entity.
8. The runner chooses, overrides, suppresses, or escalates follow-ups based on:
   - evidence requirements,
   - novelty,
   - recurrence,
   - task/entity state,
   - and provider metadata.
9. The runner either:
   - continues gathering evidence,
   - advances to the next entity,
   - marks the entity inconclusive,
   - or finishes.
10. After the primary run, the panel builds a `ConversationTrace`.
11. The judge agent re-evaluates the evidence bundle and checks for contradictions.
12. The judge report becomes part of the final stored/exported outcome.

---

## 5. Current Primary Reasoning Contract

The current primary reasoning contract is defined jointly by:

- `src/modules/vlmAdapters/prompts/promptWrappers.ts`
- `src/modules/vlmChecker.ts`

The key idea is:

- the model should primarily report **what evidence is missing**
- the runtime should primarily decide **what to do next**

This is a major architectural improvement over follow-up-first prompting.

### Current required model outputs

The most important current fields are:

- `verdict`
- `confidence`
- `rationale`
- `missingEvidence`
- `evidenceRequirementsStatus`
- `visibility`
- `evidence`
- `followUp`

### Most important prompt rules in the active wrapper

The active prompt wrapper now tells the model to:

- treat `DYNAMIC_CHECKLIST` as the current task brief
- focus on active entity / active storey / active task
- report evidence gaps rather than inventing tool recipes
- treat `evidenceViews.context.evidenceRequirements` as authoritative runtime evidence state
- use `WEB_FETCH` only when clause text or regulatory definitions are missing
- avoid repeating low-value navigation
- prefer `missingEvidence` and `evidenceRequirementsStatus` over `followUp`

This is one of the clearest markers of the current state-of-the-art design.

---

## 6. Generalized Evidence Requirements As The New Reasoning Backbone

The generalized evidence-requirement model in `src/types/evidenceRequirements.types.ts` is now one of the most important abstractions in the app.

Current keys:

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

### Why this matters

Earlier compliance systems often reason directly in terms of:

- “zoom again”
- “move camera”
- “isolate category”

The current best system instead reasons through an intermediate semantic state:

- what kind of evidence is still missing
- whether a measurement-ready state exists
- whether context evidence is ready
- whether occlusion or repetition is the real blocker

This makes the runtime planner more general, more auditable, and less rule-specific.

---

## 7. Runtime Evidence Derivation Is Now Stronger Than Plain Model Self-Report

The current state-of-the-art implementation in `deriveRuntimeEvidenceRequirements(...)` inside `src/modules/complianceRunner.ts` does not trust the model alone.

It derives evidence requirements from:

- active highlighted target state
- current view preset
- projected area ratio
- zoom exhaustion
- plan-cut readiness
- floor-context signals
- occlusion ratio
- semantic missing-evidence text
- prompt-inferred concerns
- novelty/repetition signals
- entity workflow statistics

### Architectural significance

This means the current system is a **hybrid reasoner**:

- the model contributes semantic interpretation
- the runtime contributes deterministic state interpretation

That combination is the current best reasoning design in the repository.

---

## 8. Task-Graph-Guided Entity Reasoning

The current task graph in `src/modules/taskGraph.ts` is no longer just metadata decoration.

It now shapes reasoning by:

- inferring a profile from the prompt
- inferring concerns from the prompt
- creating run-level tasks
- creating per-entity tasks
- maintaining an active entity queue
- maintaining storey-based clusters
- surfacing active task/entity/storey into `DYNAMIC_CHECKLIST`

### Current task-graph profiles

- `generic`
- `door`
- `stair`
- `ramp`
- `space`
- `object`
- `visibility`
- `egress`

### Why this is state-of-the-art in the app

The model is no longer supposed to reason over “all visible doors” or “the whole model” at once.

Instead, the current best path is:

- identify a target batch
- focus on the active entity
- resolve the active evidence concern
- finalize or advance

That entity-first structure is one of the strongest current improvements in the compliance system.

---

## 9. Semantic Evidence Progress Is A Major New Layer

The strongest part missing from simpler descriptions of the system is the **semantic evidence progress** layer inside `src/modules/complianceRunner.ts`.

The runner now computes progress not only from camera or view changes, but from whether the latest step actually improved the evidence situation.

### Current semantic-progress signals include

- normalized evidence gaps
- whether evidence gaps changed
- resolved gap count
- new gap count
- unchanged gap count
- semantic progress score
- semantic stagnation warning
- tried action families
- tried action family counts
- same-entity recurrence score
- same-entity recurrence warning

### Why this matters

This moves the system beyond:

- “did we move the camera?”
- “did we orbit?”
- “did we zoom?”

and into:

- “did the move actually reduce the unresolved evidence burden?”

That is one of the most state-of-the-art aspects of the current app.

---

## 10. Low-Novelty And Recurrence Control

The current app no longer allows repeated view changes to continue indefinitely just because the model remains uncertain.

The advanced control logic now includes:

- snapshot novelty metrics
- low-novelty anti-repeat substitution
- suppression of repeated low-value action families
- recurrence-aware same-entity warnings
- bounded orbit budgets
- repeated-workflow termination
- per-entity uncertain-step termination

### Current consequence

When the system detects that new steps are no longer useful, it can:

- substitute a different action,
- suppress the requested action,
- finalize the entity as inconclusive,
- or advance to the next entity.

This is a major maturity improvement over reactive follow-up loops.

---

## 11. The Current Best Follow-Up Planner

The strongest current follow-up planning path lives in `chooseFollowUpFromEvidenceRequirements(...)` in `src/modules/complianceRunner.ts`.

Its current logic is organized around evidence state rather than fixed rule scripts.

### Current planning priorities

1. Missing regulatory clause text
2. Target not visible
3. Target not focused/readable
4. Plan measurement not ready
5. Obstruction context still limiting evidence
6. Context-confirmation view still missing
7. Only then preserve advisory/provider follow-up if no stronger runtime action is justified

### Why this is better than older approaches

This planner gives the system:

- a generalized control policy,
- explainable reason strings,
- and action provenance (`runtime_planner`, `vlm_advisory`, `provider_override`, `anti_repeat`)

That action-provenance model is especially important for trace review and research reporting.

---

## 12. Provider Overrides Are Part Of The Current Best System

The current OpenRouter adapter in `src/modules/vlmAdapters/openrouter.ts` is not a passive transport layer.

It currently adds strong provider-side tactical logic, especially for:

- door workflows
- stair workflows
- ramp workflows
- top-view ordering
- storey plan-cut ordering
- highlight-first behavior
- zoom suppression/exhaustion logic
- bounded orbit confirmation

### What this means

The current state-of-the-art path is not purely centralized in `complianceRunner.ts`.

It is distributed across:

- prompt contract
- VLM checker
- OpenRouter adapter tactical overrides
- runner evidence planner
- anti-repeat controls

This is powerful, but also means the best current behavior is **emergent from multiple files**, not contained in one module.

---

## 13. Regulatory Grounding Is Now Optional, Conditional, And Structured

The current regulatory-grounding design in `src/modules/vlmChecker.ts` is more advanced than a simple fetch tool.

### Current behavior

- custom prompts may trigger regulatory grounding
- predefined rule-library mode disables it
- vague prompts may get deterministic prefetch before the model asks for it
- `WEB_FETCH` can be executed internally and the decision re-run
- fetched text can be reduced through `src/modules/regulatoryReducer.ts`
- web evidence is stored in the trace

### Why this matters for reasoning quality

This allows the system to distinguish between:

- visual insufficiency,
- and regulatory underspecification

That is a key step toward better compliance reasoning because some “uncertainty” is not visual at all. It comes from missing clause definitions, thresholds, or editions.

---

## 14. Judge Agent Is Now Contradiction-Aware

The current judge agent in `src/modules/judgeAgent.ts` is more advanced than a generic second opinion.

It explicitly checks:

- whether primary verdicts were justified,
- whether `missingEvidence` contradicts the claimed verdict,
- whether `evidenceRequirementsStatus` contradicts the claimed verdict,
- whether regulatory evidence that was required was actually present,
- whether the primary run likely over-claimed certainty.

### Why this is state-of-the-art in the app

The judge is not only asked to summarize. It is asked to **audit**.

That means the final system includes:

- a primary operational reasoner
- a secondary evidence critic

This is one of the clearest state-of-the-art features in the repository today.

---

## 15. Current Finalization Logic Is More Sophisticated Than Plain Pass/Fail/Uncertain

The current best system does not stop simply because the model says `UNCERTAIN`.

Instead, it now considers:

- semantic stagnation
- recurrence warnings
- step budgets
- repeated workflow signatures
- whether measurement/context-ready evidence bundles were already collected
- whether the next entity should now be advanced

### Current outcome classes in practice

The real current outcomes are:

- confident pass
- confident fail
- continued evidence collection
- entity advance
- entity inconclusive finalization
- run completion after all entities
- user stop/skip
- max-step termination

This means the present system behaves more like a bounded inspection procedure than a simple classifier.

---

## 16. Current State-Of-The-Art Scenario Coverage

The current rule-library scenarios that benefit from this advanced reasoning stack are:

1. `VLM-ACC-RAMP-001`
2. `VLM-ACC-DOOR-001`
3. `VLM-ACC-FLOOR-001`
4. `VLM-ACC-STAIR-001`
5. `VLM-MAINT-FRONT-001`
6. `VLM-SAFE-GUARD-001`
7. `VLM-ACC-SPACE-001`
8. `VLM-CIRC-WIDTH-001`
9. `VLM-ACC-OBJECT-001`
10. `VLM-QUAL-VISIBILITY-001`
11. `VLM-SAFE-HEADROOM-001`

The most advanced runtime reasoning behavior is especially relevant for:

- repeated-target door checks
- repeated-target object/space accessibility checks
- stair and ramp checks requiring multiple evidence modes
- visibility/headroom checks where context and occlusion matter as much as direct framing

---

## 17. Current Best System In One Sentence

The current state-of-the-art compliance reasoning system in this app is a **task-graph-guided, evidence-requirement-driven, semantically monitored, recurrence-controlled, judge-audited multimodal inspection loop**.

---

## 18. Current Limitations Of The State-Of-The-Art Path

Even the best current path still has important limitations:

1. The best tactical behavior is richer on the OpenRouter path than on the OpenAI path.
2. Provider override logic and runner logic are both influential, so behavior is not fully centralized.
3. Rule-library mode still blocks regulatory grounding, even for rules that are conceptually regulatory.
4. Some legacy follow-up action names still exist even though runtime behavior is normalized through highlighting/focus.
5. The final stored verdict may reflect the judge more than the primary run, which is powerful but can blur “primary vs audited” outcomes if not clearly communicated.

---

## 19. Files To Read First For The Real Current Best System

If someone wants to understand the real state-of-the-art compliance reasoning path in the fewest files, the best reading order is:

1. `src/modules/complianceRunner.ts`
2. `src/modules/vlmAdapters/prompts/promptWrappers.ts`
3. `src/modules/vlmChecker.ts`
4. `src/modules/taskGraph.ts`
5. `src/modules/vlmAdapters/openrouter.ts`
6. `src/modules/judgeAgent.ts`
7. `src/ui/panel.ts`

That set currently explains most of the advanced reasoning behavior that defines the app's best compliance-inspection system.

# TOC-Based BIM Compliance Checker - State-Of-The-Art Architecture Analysis

**Date**: April 28, 2026  
**Compared against previous architecture analysis**: April 24, 2026  
**Scope**: current working build in the repository, based on active code paths rather than historical intent documents  
**Goal**: describe the most advanced architecture now implemented in the app, explain what is genuinely state-of-the-art inside this repository, and identify the next architectural bottlenecks

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Scope And Reading Boundary](#scope-and-reading-boundary)
3. [What Changed Since April 24](#what-changed-since-april-24)
4. [Current Architecture Overview](#current-architecture-overview)
5. [Real Runtime Control Hierarchy](#real-runtime-control-hierarchy)
6. [State-Of-The-Art Runtime Flow](#state-of-the-art-runtime-flow)
7. [What Makes The Current Build State-Of-The-Art](#what-makes-the-current-build-state-of-the-art)
8. [Strengths Of The Current Architecture](#strengths-of-the-current-architecture)
9. [Current Risks And Architectural Gaps](#current-risks-and-architectural-gaps)
10. [Recommended Next Steps](#recommended-next-steps)
11. [Bottom Line](#bottom-line)

---

## Executive Summary

As of **April 28, 2026**, the project is best understood as a **browser-resident BIM compliance inspection workstation with an internal evidence-audit loop**.

The current architecture is no longer just:

- an IFC viewer with a VLM button

It is now a coupled system with six clear architectural layers:

- a **single-page composition shell** in `src/main.ts`
- an **operator/session console** in `src/ui/panel.ts`
- a **stateful inspection orchestrator** in `src/modules/complianceRunner.ts`
- a **hybrid reasoning contract** spanning `taskGraph.ts`, `vlmChecker.ts`, and the prompt/adapter layer
- a **viewer/navigation evidence layer** spanning `viewer/api.ts`, `navigationAgent.ts`, and `snapshotCollector.ts`
- a **trace, judge, and reporting layer** spanning `traceDb.ts`, `judgeAgent.ts`, and `reportGenerator.ts`

Compared with the April 24 snapshot, the current build is more advanced in four particularly important ways:

- it now uses a **compact VLM evidence context** with structured fallback to full trace context
- it has a clearer **semantic anti-cycle architecture** based on evidence gaps, recurrence, and follow-up family budgets
- it treats **judge review as part of the normal artifact pipeline**, not just an optional add-on
- it more explicitly separates **advisory model output** from **runtime-selected next actions**

This is the strongest architecture the repository has had so far for thesis-style inspection, because the app now produces not only a verdict, but also a **structured decision path, grounded evidence bundle, semantic progress history, and a second-pass critique**.

---

## Scope And Reading Boundary

This analysis is based on the current executable code in:

- `src/main.ts`
- `src/ui/panel.ts`
- `src/ui/tree.ts`
- `src/viewer/initViewer.ts`
- `src/viewer/api.ts`
- `src/viewer/upload.ts`
- `src/modules/complianceRunner.ts`
- `src/modules/taskGraph.ts`
- `src/modules/vlmChecker.ts`
- `src/modules/judgeAgent.ts`
- `src/modules/navigationAgent.ts`
- `src/modules/vlmAdapters/*`
- `src/modules/snapshotCollector.ts`
- `src/storage/*`
- `src/reporting/reportGenerator.ts`
- `src/types/*`
- `src/config/*`

This document intentionally does **not** treat older notes, comments, or prior analyses as authoritative unless the current code still implements that behavior.

It also reflects the **current working tree**, not only the last committed architecture snapshot. That matters because several of the most important current characteristics live in active code changes, especially around:

- compact prompt context
- semantic evidence progression
- provider-side tactical overrides
- judge critique output
- report and trace enrichment

---

## What Changed Since April 24

The April 24 architecture analysis already described a stronger workstation-style prototype with queueing, traces, and a secondary judge. The current build goes further.

### 1. The reasoning context sent to the VLM is now more architecture-aware

The runner no longer treats the VLM evidence payload as only a raw accumulation of snapshots plus large free-form context. It now builds:

- a **compact evidence context shape**
- a **prompt-context size measurement**
- a **fallback path to full context** when compact context is incomplete

This is a meaningful architectural step because it turns context compression into an explicit runtime strategy rather than an ad hoc prompt edit.

### 2. Semantic anti-loop logic is now a first-class runtime subsystem

The runner now tracks more than repeated follow-ups. It tracks:

- normalized missing evidence gaps
- evidence-requirement status deltas
- semantic progress score
- same-entity recurrence score
- stagnated follow-up families
- suppressed follow-up reasons
- finalization reasons when an entity is stopped as inconclusive

This means the inspection loop has evolved from a basic "try another view" cycle into a **stateful evidence-progression controller**.

### 3. The architecture now distinguishes advisory model output from runtime action choice more clearly

The current design increasingly treats the model as the component that says:

- what is visible
- what evidence is missing
- which evidence requirement is unresolved

And it treats the runtime as the component that decides:

- whether a follow-up should be accepted
- whether a follow-up should be overridden
- whether the same family is exhausted
- whether the entity should be finalized

That separation is one of the strongest signs of architectural maturation in the repository.

### 4. The trace model is richer and more research-ready

The trace schema now stores:

- semantic evidence progress
- snapshot novelty
- follow-up suppression
- action family classification
- evidence requirements before actions
- judge contradiction flags
- confidence critique

This makes the current architecture much more suitable for evaluation, replay, and explanation than earlier versions.

### 5. The provider layer has become more tactical, not just transport-oriented

The OpenRouter adapter is no longer just a request wrapper. It now contains meaningful policy around:

- follow-up guardrails
- task-profile-sensitive overrides
- door/ramp-specific tactical corrections
- JSON repair fallback
- structured evidence requirement propagation

Architecturally, that is both a strength and a warning: it improves prototype behavior, but it also pushes domain policy into provider-specific code.

---

## Current Architecture Overview

### High-level architecture

```text
Browser Application (Vite + TypeScript)
|
+-- Composition Root
|   - src/main.ts
|
+-- UI / Session Control Layer
|   - src/ui/panel.ts
|   - src/ui/tree.ts
|   - src/ui/toast.ts
|   - src/ui/dom.ts
|   - src/ui/inspectionPanel.ts (present, not active mount path)
|
+-- Inspection Orchestration Layer
|   - src/modules/complianceRunner.ts
|   - src/modules/taskGraph.ts
|   - src/modules/snapshotCollector.ts
|   - src/modules/navigationAgent.ts
|
+-- Reasoning / Model Layer
|   - src/modules/vlmChecker.ts
|   - src/modules/judgeAgent.ts
|   - src/modules/vlmAdapters/openrouter.ts
|   - src/modules/vlmAdapters/openai.ts
|   - src/modules/vlmAdapters/prompts/*
|   - src/modules/regulatoryReducer.ts
|   - src/modules/vlmAdapters/tools/*
|
+-- Viewer / Scene Interaction Layer
|   - src/viewer/initViewer.ts
|   - src/viewer/api.ts
|   - src/viewer/upload.ts
|   - src/viewer/state.ts
|   - src/viewer/events.ts
|   - src/viewer/ifc/classification.ts
|
+-- Persistence Layer
|   - src/storage/dbConfig.ts
|   - src/storage/complianceDb.ts
|   - src/storage/ruleDb.ts
|   - src/storage/traceDb.ts
|   - src/storage/snapshotDb.ts
|
+-- Reporting / Artifact Projection Layer
|   - src/reporting/reportGenerator.ts
|
+-- Data / Types / Runtime Configuration
|   - src/data/ruleLibrary.json
|   - src/types/*.types.ts
|   - src/config/prototypeSettings.ts
|   - src/config/openRouterModels.ts
|   - src/config/environment.ts
|
+-- External Runtime Helpers
    - public/thatopen/worker.mjs
    - webfetch-worker/worker.js
```

### Architectural character

The current build is still a **frontend-only prototype**, but it is no longer architecturally simple.

It now has visible internal separation between:

- viewer control
- deterministic navigation
- multimodal reasoning
- evidence state tracking
- trace persistence
- post-run audit and report generation

This separation is still **module-level**, not **service-level**. Everything runs inside the same browser application and is assembled directly in `main.ts`.

### Deployment model

At runtime, the system currently depends on:

- the browser as the only primary application process
- remote VLM APIs for reasoning
- optional Tavily/web-fetch services for regulatory grounding
- That Open fragments worker for viewer support
- remote `web-ifc` WASM loaded from `unpkg`

So the architecture is local-first in orchestration and persistence, but still externally dependent for model inference and some grounding paths.

---

## Real Runtime Control Hierarchy

The codebase has many modules, but the actual runtime authority is concentrated in a few places.

### 1. `src/main.ts`

This is still the single composition root. It:

- validates environment configuration
- initializes the viewer
- creates storage adapters
- creates the navigation agent
- creates the mutable VLM checker
- creates the compliance runner
- mounts the active panel and tree

It is the boot-time authority of the whole app.

### 2. `src/ui/panel.ts`

This file is the real **session controller**. It owns:

- provider/model configuration
- queue creation and queue processing
- run start/stop/skip behavior
- runtime settings syncing
- trace assembly from raw run outputs
- secondary judge invocation
- report generation and export
- recent trace browsing and replay

Architecturally, this means the right-side panel is not just a UI surface. It is a **workflow orchestrator**.

### 3. `src/modules/complianceRunner.ts`

This is the real **inspection execution engine**. It owns:

- run reset and state initialization
- deterministic start handling
- snapshot/evidence window management
- task-graph integration
- compact prompt context preparation
- semantic progress assessment
- low-novelty and recurrence handling
- follow-up selection, suppression, substitution, and finalization
- navigation action logging

This is currently the most important operational module in the repository.

### 4. `src/modules/taskGraph.ts`

This module translates prompt intent into executable focus state. It owns:

- prompt source detection
- profile inference
- concern inference
- entity queueing
- task progression
- active entity and cluster focus
- compact task summary injected into prompts

It is the bridge between human rule text and repeated per-entity execution.

### 5. `src/modules/vlmChecker.ts`

This module owns the **normalized decision contract**. It is responsible for:

- adapter normalization
- evidence-view normalization
- prompt composition with regulatory context
- deterministic prefetch for vague prompts
- internal handling of `WEB_FETCH`
- final decision normalization

This is the boundary where "model output" becomes "runtime-usable structured decision."

### 6. `src/modules/vlmAdapters/openrouter.ts`

This is currently the richest provider implementation. It owns:

- image payload assembly
- prompt wrapping strategy
- JSON repair retry
- provider-side follow-up guardrails
- tactical overrides for some task profiles

This makes it more than a transport adapter; it is partially a reasoning-policy layer.

### 7. `src/viewer/api.ts`

This is the actual **scene-control surface** of the app. It owns:

- camera state
- isolation / hide / show logic
- plan cuts
- highlight persistence
- semantic highlight overlays
- object picking
- snapshot support
- geometry helpers

It is no longer accurate to describe it as a thin viewer wrapper.

### 8. `src/storage/*` and `src/reporting/reportGenerator.ts`

These modules turn the run into durable artifacts:

- decisions
- rules
- traces
- snapshots
- HTML reports
- exported JSON traces

The persistence/reporting path is now a central architectural feature, not just a utility layer.

---

## State-Of-The-Art Runtime Flow

The strongest current execution path works like this:

1. `main.ts` boots the viewer, storage adapters, navigation agent, VLM checker, and compliance runner.
2. `panel.ts` lets the operator choose a provider, model, prompt source, deterministic start mode, and runtime settings.
3. The panel creates either a queued task or an immediate run request.
4. `complianceRunner.ts` resets the scene/run state and builds a fresh task graph from the prompt.
5. The runner optionally seeds focus from metadata and applies deterministic start framing.
6. Each step captures a snapshot artifact and attaches a structured evidence context.
7. The runner computes novelty, evidence requirements, navigation history, active entity context, and task-graph state.
8. The runner builds either a compact evidence payload or a full-context fallback payload for the VLM.
9. `vlmChecker.ts` optionally injects regulatory context, performs internal grounding, and normalizes the adapter response.
10. The runner updates the task graph, computes semantic evidence progress, and decides whether to accept, suppress, replace, or terminate follow-up work.
11. When the run ends, `panel.ts` assembles a full `ConversationTrace` from decisions, snapshots, navigation actions, scene states, and web evidence.
12. The panel calls `runJudgeAgent(...)`, which creates an independent evidence critique and can replace the final verdict/confidence used in the stored trace.
13. `traceDb.ts` persists the trace, `reportGenerator.ts` can produce a standalone HTML report, and the UI exposes replay/export access.

The important architectural point is that the final artifact is not only a verdict. It is a **reviewable evidence package** with primary and secondary reasoning layers.

---

## What Makes The Current Build State-Of-The-Art

## 1. It reasons through evidence requirements, not only camera actions

The generalized evidence-requirement model in `src/types/evidenceRequirements.types.ts` is one of the strongest abstractions in the repository.

Current requirement keys include:

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

This changes the architecture from:

- "the model tells the app to orbit or zoom"

to:

- "the model and runtime maintain a semantic picture of what kind of evidence is still missing"

That is a much stronger architecture for auditing and control.

## 2. It uses a compact multimodal context contract instead of only raw trace payloads

`complianceRunner.ts` now builds a compact VLM evidence context that summarizes:

- active entity identity
- active task brief
- current view state
- target metadata
- navigation quality
- evidence requirement status
- semantic progress
- runtime hints

This is state-of-the-art inside the repository for three reasons:

- it reduces prompt bloat
- it keeps the reasoning payload more stable across steps
- it explicitly falls back to full context when compact context is incomplete

That fallback behavior is especially important. It shows the architecture is trying to optimize context size **without silently sacrificing correctness**.

## 3. It has a real semantic anti-cycle system

The current runner does more than count repeated follow-ups. It evaluates whether the inspection is making meaningfully new progress for the active entity.

It tracks:

- unresolved vs resolved evidence gaps
- unchanged evidence-gap streaks
- semantic progress score
- same-entity recurrence similarity
- action-family budgets
- low-novelty visual repetition

This is one of the most advanced parts of the current build because it makes follow-up control:

- stateful
- evidence-aware
- entity-specific
- auditable after the run

Earlier versions of the architecture could ask for more views. The current one can justify **why more views are no longer worth taking**.

## 4. It cleanly separates advisory reasoning from execution control

The current design increasingly treats `followUp` as advisory rather than authoritative.

That separation shows up in:

- `promptWrappers.ts`, which instructs the model to prioritize missing evidence over tool recipes
- `vlmChecker.ts`, which preserves structured model output
- `complianceRunner.ts`, which can suppress or replace model-suggested follow-ups
- `openrouter.ts`, which can add tactical provider-side overrides before the runner sees the decision

This is important because it prevents the architecture from over-trusting the model as a direct controller of the viewer.

## 5. It combines multimodal reasoning with deterministic geometric navigation

The current system is hybrid by design.

The model handles:

- semantic interpretation
- compliance rationale
- evidence gap description
- clause/regulatory need detection

The deterministic runtime handles:

- camera movement
- isolation
- plan cuts
- highlight focus
- target-area measurement
- occlusion heuristics
- recurrence and budget control

This is a stronger architecture than a pure VLM loop because it uses deterministic geometry where the browser can know more than the model.

## 6. It has a trace-first audit pipeline

The trace model has become one of the defining strengths of the architecture.

The stored trace now captures:

- prompts
- responses
- snapshots
- navigation actions
- scene states
- metrics
- web evidence
- novelty and semantic progress
- judge critique

This means the architecture is not optimized only for interactive operation. It is also optimized for:

- replay
- report generation
- thesis evidence
- debugging
- comparative evaluation

## 7. It includes a second-pass judge as part of the architecture

`judgeAgent.ts` is not just another report embellishment. It is an architectural statement.

The current design says:

- the primary VLM makes the first claim
- the stored evidence bundle remains available as the source of truth
- a second model pass critiques support, confidence, and contradictions

That is a much more advanced architecture than a single-shot compliance verdict generator.

## 8. The viewer now behaves like an inspection instrument

The viewer layer contributes domain-specific evidence preparation through:

- persistent highlight state
- semantic overlay drawing
- plan-cut preservation around active highlights
- storey/space/category isolation
- selection world-box computation
- object metadata extraction

This matters because the architecture is not just "send screenshot to VLM." It is "prepare inspection-ready evidence from the BIM scene."

---

## Strengths Of The Current Architecture

### 1. Strong evidence-centric design

The architecture now revolves around evidence readiness and evidence critique rather than only navigation mechanics.

### 2. Good prototype-level modular separation

Even though the app is still single-process and browser-only, the codebase now has recognizable module boundaries for:

- UI/session control
- orchestration
- reasoning
- viewer operations
- storage
- reporting

### 3. High auditability for a frontend prototype

The trace schema, judge pass, and report output make the system unusually inspectable for a browser prototype.

### 4. Deterministic runtime control where it matters

The system does not fully delegate inspection strategy to the model. It keeps deterministic control over:

- start framing
- follow-up budgets
- semantic anti-repeat
- plan-cut use
- highlight-centric navigation

### 5. Good research value

The current architecture is particularly strong for thesis/research work because it exposes:

- what the model saw
- why the runtime continued or stopped
- what evidence stayed unresolved
- whether a second-pass judge agreed

### 6. Better token/context discipline than earlier versions

The compact-context path is an important sign that the app is starting to manage prompt scale intentionally rather than only growing trace payloads step by step.

---

## Current Risks And Architectural Gaps

## 1. `panel.ts` is still too powerful

The active panel owns too much application behavior:

- queueing
- run lifecycle
- trace assembly
- judge invocation
- report/export control
- trace replay

This makes it the de facto session orchestrator and increases coupling between UI state and domain logic.

## 2. `complianceRunner.ts` is becoming a very large god module

It currently mixes:

- run control
- evidence context building
- prompt strategy
- semantic progress logic
- follow-up planning
- navigation execution
- anti-loop policy
- trace logging

This is manageable for the prototype stage, but it is now one of the clearest architectural scaling risks.

## 3. Provider adapters now contain domain policy

The OpenRouter adapter includes behavior that is not purely transport-level:

- door/ramp tactical overrides
- follow-up coercion
- vision-task-specific guardrails

This improves current behavior, but it creates a risk that provider choice will affect reasoning policy in ways that should really belong to a provider-agnostic planner layer.

## 4. The architecture is still frontend-only for security-sensitive operations

API keys and model calls are still handled in the browser process. Even with session-only handling for some keys, this remains a prototype limitation.

The current app is therefore still:

- not a secure production gateway
- not a backend-governed audit system
- not a hardened compliance platform

## 5. Persistence is split across two databases

The app stores traces/rules/decisions in the shared `toc_based_system_db`, but snapshot artifacts live in a separate `bim-snapshot-store`.

That is acceptable for the prototype, but it creates a conceptual split between:

- logical inspection traces
- binary/image artifact persistence

A more unified artifact model would make synchronization, cleanup, and replay reasoning easier.

## 6. Reporting is powerful but monolithic

`reportGenerator.ts` is now a substantial artifact-projection layer, but it is implemented as one very large report-building module.

This creates maintainability pressure in:

- layout changes
- appendix growth
- report data transformations
- testing

## 7. The architecture still relies on heuristic intent inference

`taskGraph.ts`, `promptWrappers.ts`, and adapter overrides still use substantial keyword/profile heuristics.

That is fine for the current stage, but it means the architecture is not yet fully generalized across:

- arbitrary rule families
- unfamiliar IFC classes
- truly broad code corpora
- more complex cross-entity reasoning

## 8. There is still no real service/process boundary between major concerns

Viewer logic, reasoning orchestration, persistence, and UI control all execute in the same browser runtime.

That means the app still lacks:

- isolated workers for heavy orchestration
- backend job management
- recoverable long-running sessions
- multi-user or remote execution boundaries

## 9. Some infrastructure dependencies are still prototype-grade

The current viewer initialization still depends on:

- remote `web-ifc` WASM from `unpkg`
- browser-local IndexedDB
- direct browser fetch access to provider endpoints or web helpers

That is reasonable for a thesis prototype, but it is not yet a robust deployment architecture.

---

## Recommended Next Steps

### 1. Split `complianceRunner.ts` into explicit submodules

The highest-value refactor would be to separate:

- evidence-context building
- semantic progress assessment
- follow-up planning
- navigation execution
- trace logging

That would preserve the current logic while making the architecture easier to test and evolve.

### 2. Move session/domain orchestration out of `panel.ts`

The panel should remain the operator console, but queue processing, trace assembly, and judge/report pipeline logic would be cleaner in a dedicated session service layer.

### 3. Create a provider-agnostic planner boundary

The tactical follow-up override logic currently embedded in `openrouter.ts` should eventually move into a shared planner/policy module so that:

- provider choice does not change orchestration policy
- adapter code returns to being mainly transport/normalization logic

### 4. Unify the artifact persistence model

A stronger architecture would align:

- trace records
- snapshot records
- export metadata
- report provenance

into one clearer artifact graph rather than two loosely related persistence tracks.

### 5. Introduce a backend boundary for secure and reproducible deployments

If the project moves beyond thesis-prototype scope, the next major architecture step should be:

- server-side provider access
- regulated key handling
- central job execution
- shared trace persistence

### 6. Treat the judge and report layers as first-class services

The current judge/report path is already strategically important. The next step is to formalize it as a dedicated artifact pipeline rather than leaving its orchestration mainly inside the panel.

### 7. Preserve compact-context work and extend it carefully

The compact VLM evidence context is one of the best current changes. It should be preserved and extended, but with:

- stricter schemas
- explicit versioning
- test fixtures for fallback behavior

---

## Bottom Line

The current build is the most advanced architecture this repository has had so far.

It is no longer best described as a viewer with AI assistance. It is now a **local-first multimodal inspection architecture** with:

- task-graph-guided execution
- evidence-requirement-centered reasoning
- compact context management
- semantic anti-cycle control
- deterministic scene/navigation support
- trace-first auditability
- independent judge review

Its biggest remaining limitations are not conceptual weakness, but **concentration of logic** in a few large modules and the continued **frontend-only deployment model**.

So the architecture is already strong as a research system and demonstrator. The next stage is not inventing an entirely different design. It is **extracting clearer boundaries from the strong design that is already present**.

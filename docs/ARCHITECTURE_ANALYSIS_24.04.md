# TOC-Based BIM Compliance Checker - Architecture Analysis

**Date**: April 24, 2026  
**Compared against previous analysis**: March 30, 2026  
**Repository focus**: Current browser-based modular prototype with task-graph-guided inspection, trace-first reporting, and secondary judge review

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [What Changed Since March 30](#what-changed-since-march-30)
3. [Current Architecture Overview](#current-architecture-overview)
4. [Current Runtime Flow](#current-runtime-flow)
5. [Current Functional Modules](#current-functional-modules)
6. [Persistence, Trace, and Reporting Model](#persistence-trace-and-reporting-model)
7. [Strengths of the Current Version](#strengths-of-the-current-version)
8. [Current Risks and Architectural Gaps](#current-risks-and-architectural-gaps)
9. [Recommended Next Steps](#recommended-next-steps)

---

## Executive Summary

As of **April 24, 2026**, the project is no longer best described as only a browser viewer with a compliance loop layered on top. It now behaves like a **browser-resident compliance inspection workstation** with five clear architectural characteristics:

- a **single-page frontend shell** that boots the viewer, storage, runner, and inspection panel in one place,
- a **task-graph-guided orchestration core** that tracks entities, clusters, active tasks, and per-entity completion state,
- a **trace-first evidence model** that records prompts, responses, navigation actions, scene states, web evidence, and metrics as first-class artifacts,
- a **reporting and audit layer** that turns those traces into standalone HTML reports and JSON exports,
- a **secondary judge stage** that independently reviews the evidence bundle before final report consumption.

Compared with the March 30 snapshot, the current codebase is more explicit about **run management, queueing, review, and auditability**. The architecture still remains prototype-oriented and frontend-heavy, but it is now much stronger as a thesis/research demonstrator because the system exposes not just a final verdict, but also the **decision path, evidence basis, and post-run critique**.

---

## What Changed Since March 30

This section compares the current repository with the architecture described in [ARCHITECTURE_ANALYSIS_30.03.md](/d:/Bachelors/TOC-based_system_v.2_modular/docs/ARCHITECTURE_ANALYSIS_30.03.md).

### 1. The panel became a true inspection console

The current `panel.ts` is substantially more than a launcher. It now acts as the runtime control center for:

- provider selection and persisted provider/model configuration,
- OpenRouter key validation and budget/status display,
- queued compliance tasks,
- prototype runtime tuning,
- recent trace browsing,
- report generation and trace export,
- live task HUD and current-step feedback,
- debug interactions such as object picking, manual snapshot capture, and database reset.

Architecturally, this means more orchestration concerns are surfaced as **operator-visible state** instead of remaining hidden in logs or local variables.

### 2. Compliance execution is now queue-aware

The March 30 version already had stronger single-run orchestration than earlier versions, but the current panel introduces a **task queue model** for inspections. The user can prepare multiple checks with:

- prompt source metadata,
- deterministic start mode,
- runtime settings snapshot,
- selected provider/model,
- eventual trace linkage and verdict status.

This is still executed serially in the browser, but it moves the system closer to a **session-based inspection workflow** rather than a one-off button press.

### 3. A secondary judge stage now exists

One of the largest architectural additions is `judgeAgent.ts`. After the primary VLM run, the system can now create a **second-pass review** that:

- re-evaluates the trace evidence,
- slices multi-entity runs into per-entity review packets when needed,
- generates independent verdicts and confidence values,
- returns debugging suggestions about likely mistakes in the primary run,
- feeds these results into the stored trace and exported report.

This is a major change in architectural intent. The system is no longer only producing a compliance answer; it is also producing an **internal audit of the compliance answer**.

### 4. Reports are now more analysis-oriented

The reporting layer has evolved from “export the run” into a more structured **research artifact generator**. The current report generator includes:

- summary and metrics sections,
- entity summary cards,
- entity-scoped step-by-step trace sections,
- web evidence appendix,
- judge appendix,
- prototype settings appendix,
- prompt/source provenance and cited snapshot IDs.

The report architecture now mirrors the trace model much more closely and supports reproducible review.

### 5. Web grounding and regulatory reduction are more explicit

The VLM checker now has clearer internal logic for:

- deterministic prefetch of regulatory context when prompts are vague,
- Tavily-first retrieval,
- proxy fallback through the optional worker,
- reducer-based compression of fetched code text,
- web evidence recording with cache source, transport path, and reduced/original text distinctions.

This makes regulatory grounding less opaque than in the March 30 description and improves the architecture’s audit trail.

### 6. Viewer-side semantic highlighting is richer

The viewer API now includes a larger set of semantics-oriented capabilities:

- persistent highlight state,
- highlight overlays and HUD annotations,
- door clearance focus boxing,
- plan-cut adjustment to preserve highlighted targets,
- selection-aware world-box computation,
- richer hide/show/isolate bookkeeping.

This matters architecturally because the viewer is no longer only a render target. It is becoming an **inspection instrument** that prepares evidence for the VLM and for the human operator.

---

## Current Architecture Overview

### High-level architecture

```text
Browser Application (Vite + TypeScript)
|
+-- Application Shell
|   - main.ts
|   - environment.ts
|
+-- UI / Operator Console
|   - panel.ts
|   - inspectionPanel.ts
|   - tree.ts
|   - toast.ts
|   - dom.ts
|
+-- Orchestration / Inspection Core
|   - complianceRunner.ts
|   - taskGraph.ts
|   - navigationAgent.ts
|   - snapshotCollector.ts
|   - vlmChecker.ts
|   - judgeAgent.ts
|
+-- Provider / Prompt / Grounding Layer
|   - vlmAdapters/openrouter.ts
|   - vlmAdapters/openai.ts
|   - vlmAdapters/prompts/*
|   - vlmAdapters/tools/webFetch.ts
|   - vlmAdapters/tools/tavilySearch.ts
|   - regulatoryReducer.ts
|
+-- Viewer / Scene Interaction Layer
|   - initViewer.ts
|   - api.ts
|   - upload.ts
|   - state.ts
|   - events.ts
|   - ifc/classification.ts
|   - gridConfig.ts
|
+-- Persistence Layer
|   - dbConfig.ts
|   - snapshotDb.ts
|   - complianceDb.ts
|   - ruleDb.ts
|   - traceDb.ts
|
+-- Reporting Layer
|   - reportGenerator.ts
|
+-- Data / Types / Config
|   - data/ruleLibrary.json
|   - types/*.types.ts
|   - config/prototypeSettings.ts
|   - config/openRouterModels.ts
|
+-- Optional External Helper
    - webfetch-worker/worker.js
```

### Architectural character

The current application is still a **frontend-only prototype at runtime**, but it now has a much clearer internal separation between:

- **scene control**,
- **inspection orchestration**,
- **model/provider interaction**,
- **evidence persistence**,
- **human-readable audit output**.

This separation is not yet enforced by independent services or process boundaries, but it is visible in the module organization and in how `main.ts` wires the system together.

### Central composition point

`main.ts` remains the composition root. It currently initializes:

- the viewer and viewer API,
- the navigation agent,
- the snapshot collector and snapshot DB,
- the mutable VLM checker facade,
- the compliance DB, rule DB, and trace DB,
- the compliance runner,
- the integrated UI panel and model tree.

This means the architecture is still **assembly-driven rather than dependency-injection-heavy**, which is acceptable for the prototype stage but important to note for future scaling.

---

## Current Runtime Flow

### 1. Application boot

At startup, the application:

- validates environment configuration,
- initializes the That Open viewer,
- creates local IndexedDB-backed stores,
- loads or refreshes the embedded rule library,
- mounts the unified inspection UI,
- exposes several subsystems on `window` for debugging.

The boot path is intentionally pragmatic and debugging-friendly.

### 2. Model loading and viewer readiness

When the user loads an IFC model:

- the upload module activates the IFC loader,
- viewer state records the active model identifiers,
- the tree and panel rerender,
- snapshot capture can start from a known viewer state,
- navigation and highlight features become available.

The viewer API becomes the single operational surface for later inspection actions.

### 3. Inspection setup

The operator can choose either:

- a **rule-library-based** inspection prompt, or
- a **custom user prompt**.

At the same time, the operator can configure:

- VLM provider and model,
- deterministic camera start,
- maximum steps,
- prototype runtime tuning,
- queued execution behavior.

This setup stage is now architecturally important because prompt source, provider, runtime settings, and model choice are later written into trace/report artifacts.

### 4. Run initialization

When a run starts, the runner:

- resets snapshot run state,
- applies deterministic start if requested,
- creates a task graph from the prompt,
- attempts metadata seeding for repeated entities,
- initializes per-run evidence state such as scope, highlights, bookmarks, and entity evidence stats.

The task graph is central here: it turns a text rule into an **inspection profile** with inferred concerns, probable entity class, and runnable subtasks.

### 5. Evidence collection and VLM decision loop

For each step, the runner:

- prepares scene context,
- captures snapshot evidence plus structured view context,
- builds a prompt section from the current task graph state,
- calls the VLM checker,
- stores the structured decision,
- updates the task graph and per-entity statistics,
- decides whether to continue, advance entity, or stop.

This loop is no longer just “capture then ask a model.” It is now a **stateful inspection controller** with:

- per-entity budgets,
- follow-up escalation,
- zoom exhaustion logic,
- storey bookmark reuse,
- evidence sufficiency detection,
- entity inconclusive handling.

### 6. Follow-up execution

If the VLM returns a follow-up, the runner interprets it through viewer/navigation capabilities such as:

- top or isometric views,
- orbit and zoom,
- storey, space, or category isolation,
- plan cuts and storey plan cuts,
- highlight and selection actions,
- property fetches,
- restore-view/bookmark operations.

OpenRouter adapter guardrails also inject deterministic follow-up behavior for door, stair, and ramp tasks when the raw model answer is too vague or repetitive.

### 7. Grounding and regulatory fetch

If regulatory context is missing or the model requests `WEB_FETCH`, the VLM checker can:

- fetch authoritative or likely-authoritative code pages,
- reduce them to rule-relevant excerpts,
- inject that reduced evidence back into the prompt,
- log the evidence bundle in the trace.

This creates a nested micro-loop inside VLM checking, but it is constrained and recorded.

### 8. Run completion and review

When the run finishes, the panel/trace pipeline can:

- assemble the final `ConversationTrace`,
- run the secondary judge pass,
- persist the enriched trace,
- generate a standalone HTML report,
- export the trace as JSON.

This makes the final output a **compound artifact** rather than a single verdict.

---

## Current Functional Modules

### 1. UI layer

The UI layer is now responsible for much more than presentation. It coordinates:

- model upload initiation,
- provider configuration,
- queued task preparation,
- runtime setting mutation,
- inspection progress display,
- trace browsing,
- report and export actions,
- debugging utilities.

`panel.ts` is effectively a **presentation-plus-session-control module**.

### 2. Orchestration layer

This is the current architectural center of gravity.

#### `complianceRunner.ts`

Responsibilities:

- manage the step loop,
- attach structured evidence context to snapshots,
- execute and escalate follow-ups,
- track entity-level evidence exhaustion,
- remember navigation bookmarks,
- advance between repeated entities,
- emit progress summaries for the UI.

This is the project’s main “agent runtime,” even though it is implemented as deterministic TypeScript logic rather than a general agent framework.

#### `taskGraph.ts`

Responsibilities:

- infer task profile and concern set from prompt text,
- create generic and per-entity subtasks,
- cluster repeated entities by storey,
- expose active task/entity summaries,
- update task progress from decisions and follow-up results,
- provide a compact checklist injected into prompts and UI.

This module is what gives the current system its **guided inspection** character.

#### `navigationAgent.ts`

Responsibilities:

- help frame or measure selected targets,
- navigate to isolated selections,
- support more reliable evidence capture.

It forms the bridge between semantic target selection and camera control.

#### `snapshotCollector.ts`

Responsibilities:

- capture stable snapshot artifacts,
- preserve metadata about camera and visibility state,
- persist runs/artifacts to IndexedDB,
- expose in-memory access for UI and runtime use.

#### `judgeAgent.ts`

Responsibilities:

- build compact judge prompts from existing traces,
- gather cited or fallback evidence images,
- call OpenAI/OpenRouter or mock review providers,
- repair malformed JSON when possible,
- optionally slice multi-entity traces for per-entity judging,
- return a normalized `JudgeReport`.

This is a notable new architectural layer because it evaluates the evaluator.

### 3. Provider and prompting layer

This layer now has three distinct roles:

- **primary multimodal decision making**,
- **prompt wrapping and structured output control**,
- **regulatory grounding and reduction**.

#### `vlmChecker.ts`

This module acts as the **policy layer** around the raw providers. It:

- normalizes inputs and outputs,
- enforces decision shape,
- coordinates regulatory prefetch/fetch loops,
- records web evidence,
- finalizes consistent decision objects for persistence.

#### `vlmAdapters/openrouter.ts` and `openai.ts`

These adapters:

- transform snapshot artifacts into model-specific image payloads,
- wrap prompts for structured output,
- parse JSON or recover from non-JSON outputs,
- expose provider/model metadata and token usage.

The OpenRouter adapter additionally embeds more deterministic follow-up guardrails for domain-specific workflows.

#### `regulatoryReducer.ts`

This module compresses fetched regulatory text into a smaller, rule-focused payload. Architecturally, it prevents web-grounding from overwhelming the main prompt window.

### 4. Viewer layer

The viewer layer is one of the most technically dense parts of the repository.

Responsibilities now include:

- IFC load and active-model state,
- camera presets and pose control,
- object picking,
- element property access,
- isolate/hide/show operations,
- category and storey filtering,
- plan cuts and storey plan cuts,
- semantic highlight overlays,
- door-specific focus box computation,
- snapshot rendering with HUD composition,
- visibility-state reporting to downstream evidence modules.

This layer is no longer a passive renderer. It is an **interactive spatial evidence engine**.

### 5. Persistence layer

The persistence model is currently browser-local and centered on IndexedDB.

The system persists:

- compliance decisions,
- rule library content and metadata,
- conversation traces,
- snapshot runs and snapshot artifacts.

The architecture is still local-first, which is appropriate for prototype reproducibility and offline-ish experimentation, but it also means there is no shared multi-user history or remote job execution.

### 6. Reporting layer

`reportGenerator.ts` now turns traces into a reviewable evidence package with:

- summary and KPI sections,
- final verdict framing,
- entity summary cards,
- entity-scoped trace timelines,
- embedded images,
- prompt/source provenance,
- judge results,
- regulatory appendix,
- runtime settings appendix.

This is one of the strongest modules for thesis presentation because it externalizes the internal reasoning workflow.

---

## Persistence, Trace, and Reporting Model

### Trace as the core audit artifact

The most important architectural fact in the current version is that the **trace schema has become the backbone of the system**.

`ConversationTrace` now stores:

- prompts,
- responses,
- snapshots,
- navigation actions,
- scene states,
- step metrics,
- final metrics,
- stressed findings,
- final verdict and rationale,
- web evidence,
- judge report.

This gives the system a much stronger answer to the question, “Why did the checker produce this result?”

### Unified browser-local persistence

The persistence strategy is simple but coherent:

- a shared `dbConfig.ts` defines one IndexedDB database and common stores,
- specific DB modules wrap store-level behavior,
- UI and runtime code treat these DB wrappers as service interfaces.

This is a reasonable prototype architecture because it keeps storage concerns modular without adding network or backend complexity.

### Report generation as trace projection

The report generator mostly behaves like a **projection layer** from `ConversationTrace` into HTML. That is a strong design choice because:

- the report is derived from stable data,
- the UI does not have to re-run logic to export results,
- later report redesigns can happen without changing runner behavior,
- trace JSON export and HTML export remain aligned.

---

## Strengths of the Current Version

### 1. The architecture is now meaningfully modular

The codebase has matured beyond a monolithic proof of concept. Even though everything still runs in the browser, the main responsibilities are clearly split across modules.

### 2. Inspection is more stateful and less brittle

The addition of task graphs, entity progression, evidence budgets, reusable bookmarks, and follow-up guardrails makes the runtime much more robust than a simple “ask again with another view” loop.

### 3. Auditability is a major strength

The trace schema, web evidence capture, prompt provenance, and judge report together create a good research-grade audit trail.

### 4. The viewer-runtime contract is richer

The viewer can now support more intelligent inspection behaviors because it exposes plan cuts, scoped isolation, highlighting, selection, geometry boxes, and visibility metadata.

### 5. The system is much better for demonstrations

With queueing, live HUD feedback, history browsing, export, and HTML reports, the architecture now supports a more convincing end-to-end thesis workflow.

---

## Current Risks and Architectural Gaps

### 1. The browser process still carries too much responsibility

The entire system currently depends on one frontend runtime for:

- heavy viewer interaction,
- multimodal API calls,
- storage,
- orchestration,
- report generation,
- secondary review.

This is efficient for prototyping, but it creates a fragile concentration of responsibilities.

### 2. `panel.ts` is becoming a large convergence point

The integrated panel is powerful, but it now contains a lot of operational logic and state management. This risks making the UI layer the de facto session controller rather than a thinner presentation surface.

### 3. Runtime logic is still largely in-process and imperative

The runner is capable, but many concerns are encoded as imperative branches and heuristics inside one large module. That is acceptable for a prototype, yet it will become harder to reason about as more rule profiles are added.

### 4. Regulatory grounding is still partially opportunistic

The architecture is much clearer than before, but it still depends on:

- external site structure,
- fetched-text quality,
- optional proxy configuration,
- provider-specific reduction behavior.

This means the grounding path is improved, not fully stabilized.

### 5. No backend job model or collaborative persistence exists

All traces and snapshots remain local to the browser session/database. That is fine for thesis experimentation, but it limits:

- centralized benchmarking,
- team review,
- remote execution,
- long-term dataset accumulation.

### 6. Provider-specific behavior leaks into orchestration quality

Some guardrails now live in adapters, especially OpenRouter-oriented decision normalization and follow-up shaping. This helps the prototype, but it also means architecture behavior is not fully provider-agnostic.

---

## Recommended Next Steps

### 1. Extract an inspection session service

Move queue management, run lifecycle, and trace-finalization logic out of `panel.ts` into a dedicated session module. This would preserve the current UX while reducing UI coupling.

### 2. Split `complianceRunner.ts` into narrower concerns

The current runner should eventually be separated into:

- run lifecycle,
- follow-up execution,
- entity progression,
- navigation memory/bookmarks,
- evidence context assembly.

This would improve maintainability without changing the visible behavior.

### 3. Formalize provider-independent policy layers

The architecture would benefit from a cleaner distinction between:

- provider transport,
- structured-output parsing,
- follow-up policy,
- rule-profile-specific heuristics.

Right now these concerns are improved but still partially blended.

### 4. Introduce explicit report/trace versioning

The trace schema is now important enough that versioning should be treated as a first-class architecture concern, especially if old reports and traces need to remain readable as the prototype evolves.

### 5. Consider a backend or export pipeline for experiments

Even a lightweight backend for trace upload or batch result aggregation would make the architecture much stronger for benchmarking, replication, and thesis appendix generation.

### 6. Preserve the trace-first design

This is the strongest architectural decision in the current system and should remain central. Future refactors should continue treating the trace as the authoritative representation of what happened during an inspection run.

---

## Final Assessment

The **April 24, 2026** architecture is the strongest version of the project so far. The system now combines:

- a modular browser-based BIM viewer,
- stateful task-graph-guided inspection,
- local persistence,
- structured evidence traces,
- web-grounded regulatory context,
- post-run judge review,
- standalone audit/report generation.

It is still a prototype and still carries the normal risks of a frontend-heavy research system, but it is now architecturally coherent enough to be described as a **traceable, modular compliance inspection workstation**, not just a viewer with model calls attached.

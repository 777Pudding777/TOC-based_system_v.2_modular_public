# TOC-Based BIM Compliance Checker - Architecture Analysis

**Date**: March 30, 2026  
**Compared against previous analysis**: March 19, 2026  
**Repository focus**: Current browser-based modular prototype with task-graph-guided compliance inspection

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [New Features and Debugging Improvements Since March 19](#new-features-and-debugging-improvements-since-march-19)
3. [Current Architecture Overview](#current-architecture-overview)
4. [Current Runtime Flow](#current-runtime-flow)
5. [Current Functional Modules](#current-functional-modules)
6. [Persistence, Trace, and Reporting Model](#persistence-trace-and-reporting-model)
7. [Strengths of the Current Version](#strengths-of-the-current-version)
8. [Current Risks and Architectural Gaps](#current-risks-and-architectural-gaps)
9. [Recommended Next Steps](#recommended-next-steps)

---

## Executive Summary

As of **March 30, 2026**, the project has moved beyond the March 19 architecture in one important way: the system is no longer just a multi-step compliance runner with storage and reporting. It now behaves more like a **guided inspection engine** that can:

- infer the target inspection profile from the prompt or rule,
- seed and track entity-level work through a task graph,
- advance through repeated entities instead of getting stuck on one object,
- preserve and reuse navigation context,
- record richer inspection traces including prompt provenance and web evidence,
- generate standalone HTML reports with trace, entity summary, and regulatory appendix content.

The current system is best described as a **frontend-only compliance inspection workstation with agent-like orchestration and stronger runtime control than the March 19 version**. It remains a research prototype, but it is now more structured, more debuggable, and better aligned with repeatable thesis demonstrations.

---

## New Features and Debugging Improvements Since March 19

This section compares the current codebase to the architecture described in [ARCHITECTURE_ANALYSIS_19.03.md](/d:/Bachelors/TOC-based_system_v.2_modular/docs/ARCHITECTURE_ANALYSIS_19.03.md).

### New features added

#### 1. Task-graph-driven inspection orchestration

The biggest architectural change is the introduction of `taskGraph.ts`, which gives the runner a structured representation of:

- inspection profile (`door`, `stair`, `ramp`, `space`, `object`, `visibility`, `egress`, `generic`),
- likely concerns such as clearance, dimensions, handrails, slope, headroom, or regulatory context,
- tracked entities and clusters,
- active task and next-entity progression.

This means the runner is no longer only step-based; it is now also **entity-aware**.

#### 2. Multi-entity progression instead of single-focus looping

`complianceRunner.ts` now supports:

- metadata seeding of likely entities by storey and category,
- active entity tracking,
- marking an entity inconclusive,
- advancing to the next entity when one entity is exhausted or completed.

This is a major functional improvement over the March 19 architecture, where the runner was mostly described as a single iterative loop.

#### 3. Navigation bookmarks and prepared-view restoration

The runner now stores navigation bookmarks and can reuse them to restore good inspection positions, especially:

- recent navigation history,
- prepared top views,
- storey-specific plan-cut views,
- camera pose plus isolation/highlight context.

This adds a lightweight memory layer to the inspection workflow.

#### 4. Storey plan-cut workflow support

The viewer/runtime contract now includes `setStoreyPlanCut`, and the runner can use storey-specific prepared cuts as part of evidence collection. This is especially important for:

- accessibility checks,
- floor-space checks,
- door clearance checks,
- repeated same-storey inspections.

#### 5. Door-clearance-specific readiness logic

The current system includes specialized support for door clearance inspection:

- viewer-side readiness annotations,
- focus-box analysis,
- top-measurement and context-confirm readiness flags,
- door-clearance tuning values in `prototypeSettings.ts`.

This is a meaningful move toward **rule-profile-specific orchestration** rather than purely generic prompting.

#### 6. Expanded prototype tuning configuration

[prototypeSettings.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/config/prototypeSettings.ts) now centralizes prototype behavior such as:

- default max steps,
- follow-up repeat escalation threshold,
- entity uncertainty termination,
- repeated workflow termination,
- highlight annotation defaults,
- navigation/framing defaults for general focus, ramps, and doors,
- Tavily reduction limits.

This makes the prototype more tunable and easier to compare experimentally.

#### 7. Richer integrated inspection UI

The panel layer has evolved into a more complete inspection console. The current panel supports:

- rule library mode and custom prompt mode,
- recent trace access,
- report download,
- inspection live feed/task HUD integration,
- provider configuration with model selection,
- debug pick mode and inspection-state feedback.

Architecturally, the UI is now much more than a launcher.

#### 8. Better trace and report outputs

The trace/report subsystem now supports richer structures than th e March 19 document emphasized:

- prompt provenance,
- scene states,
- navigation actions,
- per-step metrics,
- stressed findings,
- entity summary generation,
- web/regulatory evidence appendix,
- token usage reporting.

The generated HTML report is now a stronger research artifact, not just a simple export.

### Debugging and hardening improvements

#### 1. Anti-loop safeguards were significantly strengthened

Compared to the March 19 runner description, the current code adds several safeguards:

- repeated follow-up escalation,
- zoom exhaustion detection,
- entity-level uncertain-step termination,
- repeated uncertain workflow termination,
- stop-or-advance behavior when no useful follow-up remains.

This is one of the clearest debugging-oriented improvements in the repository.

#### 2. Better recovery from weak or blank evidence states

The runner now includes recovery logic that resets visibility, clears plan cuts, restores a usable camera view, and continues instead of silently failing when evidence quality becomes poor.

#### 3. Better runtime observability

The current architecture exposes more state to both logs and UI:

- progress callbacks with stage summaries,
- task graph summaries,
- navigation history,
- web evidence collection logs,
- provider/environment validation warnings.

This makes debugging inspection runs much easier than in earlier versions.

#### 4. More deterministic regulatory grounding behavior

The VLM layer now has clearer logic around:

- direct prefetching,
- Tavily-first grounding,
- fallback proxy fetch,
- recording web evidence,
- avoiding duplicate same-URL fetches within a run.

This is a practical debugging improvement because regulatory grounding is now easier to understand and audit.

---

## Current Architecture Overview

### High-level architecture

```text
Browser Application (Vite + TypeScript)
|
+-- UI Layer
|   - panel.ts
|   - inspectionPanel.ts
|   - tree.ts
|   - toast.ts
|
+-- Orchestration Layer
|   - complianceRunner.ts
|   - taskGraph.ts
|   - navigationAgent.ts
|   - snapshotCollector.ts
|   - vlmChecker.ts
|
+-- Provider / Intelligence Layer
|   - openai.ts
|   - openrouter.ts
|   - promptWrappers.ts
|   - basePrompt.ts
|   - webFetch.ts
|   - tavilySearch.ts
|   - regulatoryReducer.ts
|
+-- Viewer Layer
|   - initViewer.ts
|   - api.ts
|   - upload.ts
|   - classification.ts
|   - state.ts
|
+-- Persistence Layer
|   - dbConfig.ts
|   - snapshotDb.ts
|   - complianceDb.ts
|   - ruleDb.ts
|   - traceDb.ts
|
+-- Reporting / Types / Config
    - reportGenerator.ts
    - rule.types.ts
    - trace.types.ts
    - prototypeSettings.ts
    - environment.ts
    - ruleLibrary.json
```

### Architectural style

The project still uses a **modular vanilla TypeScript architecture** with a large composition root in [main.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/main.ts). However, the runtime is now more layered than on March 19 because it has gained:

- explicit prototype tuning configuration,
- explicit task-graph state,
- explicit trace/report schemas,
- more inspection-specific UI state,
- stronger coupling between viewer evidence and entity-level workflow.

So while the framework style is still lightweight, the internal architecture is now closer to a **workflow engine** than a simple service collection.

---

## Current Runtime Flow

### 1. Boot flow

At startup, [main.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/main.ts):

- validates environment configuration,
- initializes ThatOpen UI,
- boots the IFC viewer,
- creates the viewer API,
- initializes snapshot, compliance, rule, and trace databases,
- seeds the rule library from [ruleLibrary.json](/d:/Bachelors/TOC-based_system_v.2_modular/src/data/ruleLibrary.json),
- constructs the mutable VLM checker facade,
- mounts the unified inspection panel and IFC tree.

The composition root is still large, but it is coherent: it wires all runtime services in one place.

### 2. Inspection start flow

When the user starts a run from the panel:

- the prompt comes either from a selected rule or custom input,
- deterministic starting view may be applied,
- the runner resets run-local web evidence,
- a task graph is created from the prompt,
- entity candidates may be seeded from model metadata and storeys,
- first evidence is captured.

### 3. Evidence and decision loop

For each step, the runner:

- captures a snapshot plus contextual metadata,
- attaches evidence context such as camera pose, scope, plan cut, highlighted IDs, floor-context signal, task-graph state, and navigation history,
- sends the prompt and evidence window to the VLM checker,
- stores the structured decision,
- updates task-graph state from the decision,
- executes or escalates follow-up actions if needed.

### 4. Entity advancement flow

If an entity is completed, exhausted, or stuck:

- it may be marked inconclusive,
- the runner may restore a reusable prepared view,
- the next entity is highlighted,
- the workflow continues without restarting the whole run from scratch.

This is one of the key architectural improvements in the current version.

### 5. Trace finalization and reporting flow

The UI builds a `ConversationTrace` object around the inspection process and persists it via [traceDb.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/storage/traceDb.ts). The user can then:

- reopen recent traces,
- export trace JSON,
- generate standalone HTML reports via [reportGenerator.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/reporting/reportGenerator.ts).

---

## Current Functional Modules

### 1. Rule library subsystem

The rule subsystem is now fully integrated, not just present.

Current status:

- The embedded library contains **8 enabled rules** across accessibility, circulation, quality, and safety categories.
- Rule metadata tracks version and last update.
- Rules persist in IndexedDB through [ruleDb.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/storage/ruleDb.ts).
- Startup initialization and reload behavior are handled by `ruleLoader.ts`.

Architectural implication:

The rule library is now a real operating resource for the app, not merely sample content.

### 2. Compliance runner subsystem

[complianceRunner.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/modules/complianceRunner.ts) is now the operational core of the application.

Its current responsibilities include:

- run initialization,
- deterministic start application,
- task-graph creation and enrichment,
- evidence capture and windowing,
- follow-up execution,
- anti-loop safeguards,
- entity advancement,
- navigation bookmarking,
- progress callbacks to the UI.

This file now behaves like a **domain-specific inspection state machine**.

### 3. Task graph subsystem

[taskGraph.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/modules/taskGraph.ts) adds a structural reasoning layer between prompt text and follow-up execution.

It currently provides:

- prompt source inference,
- inspection profile inference,
- concern detection,
- tracked-entity and cluster structures,
- compact HUD summaries,
- update hooks from decisions and follow-up results.

This reduces reliance on purely free-form prompt interpretation.

### 4. Viewer subsystem

The viewer layer remains one of the foundation pieces of the project.

Current important capabilities include:

- IFC model loading,
- category, storey, and space isolation,
- hidden-ID tracking,
- highlight overlays,
- plan cuts and storey plan cuts,
- snapshot capture with metadata,
- grid reference support,
- door-clearance readiness/context annotations.

Architecturally, the viewer API is doing more than rendering. It is supplying **inspection-grade evidence metadata**.

### 5. VLM and regulatory grounding subsystem

The VLM layer still uses provider adapters for Mock, OpenAI, and OpenRouter, but the current architecture is more sophisticated than the March 19 overview.

It now includes:

- prompt wrappers that incorporate rule-source metadata,
- deterministic regulatory grounding logic,
- Tavily search/extract integration,
- allowlisted WEB_FETCH fallback through proxy,
- in-run web evidence recording and reuse prevention.

This means the intelligence layer is best understood as a **prompt-and-evidence assembly pipeline**, not just a model call abstraction.

### 6. UI subsystem

The panel architecture now plays several roles at once:

- workflow launcher,
- provider configuration surface,
- rule selector,
- inspection monitor,
- trace/report access point,
- debugging console for live inspection state.

This is powerful for experimentation, although it also increases the amount of business logic close to the DOM layer.

---

## Persistence, Trace, and Reporting Model

### IndexedDB strategy

The system uses a shared database configuration and separate logical stores for:

- snapshots,
- compliance decisions,
- rules,
- rule metadata,
- traces.

This remains a strong architectural choice for a browser-only prototype.

### Current trace model

The trace schema in [trace.types.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/types/trace.types.ts) is now detailed enough to support reproducibility-oriented reporting. A trace includes:

- prompts,
- responses,
- snapshots,
- navigation actions,
- scene states,
- step metrics,
- overall metrics,
- stressed findings,
- final verdict/confidence,
- web evidence records.

This is much more mature than basic step logging.

### Current reporting model

The HTML report generator now assembles:

- inspection summary,
- rule information,
- evaluation metrics,
- stressed findings,
- snapshots,
- entity summary,
- step-by-step trace,
- model/provider metadata,
- appendix for regulatory/web evidence.

This gives the system a credible artifact pipeline for demos, supervision, and thesis documentation.

---

## Strengths of the Current Version

### 1. The runtime is now much more resilient

The current runner has noticeably better protection against repetitive uncertain loops, weak evidence cycles, and repeated ineffective follow-ups.

### 2. The system is more inspection-oriented than before

With task graphs, prepared views, entity advancement, and richer context packaging, the architecture now better matches how a human inspector would work through a model.

### 3. The research artifact quality is higher

Trace export plus standalone HTML reporting plus web-evidence appendices make inspection runs easier to preserve and explain.

### 4. Prototype tuning is more explicit

Centralized settings in [prototypeSettings.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/config/prototypeSettings.ts) make experimentation more systematic.

### 5. Rule-profile specialization is emerging

Door and ramp handling already show the beginnings of profile-specific orchestration, which is a strong direction for future thesis work.

---

## Current Risks and Architectural Gaps

### 1. The app is still frontend-only

The same core limitation from earlier analyses remains:

- API keys still live in browser context,
- persistence is machine-local,
- there is no central audit store,
- there is no multi-user review workflow.

### 2. `main.ts` is still a large composition root

Although the runtime has improved, the bootstrap architecture is still concentrated in one file. This is manageable for a prototype, but it will become a scaling bottleneck.

### 3. `complianceRunner.ts` is now very powerful and very large

The runner has become the most important file in the repo, but also one of the hardest to reason about. It may need decomposition into:

- step loop orchestration,
- follow-up execution,
- entity progression,
- evidence-context construction,
- recovery/guardrail policies.

### 4. UI and workflow logic remain tightly coupled

The panel layer now manages substantial runtime state. This is practical for a prototype, but it risks making future refactors harder.

### 5. Special-case behavior is growing

Door-clearance-specific logic is useful, but the architecture will need a cleaner profile/plugin strategy if more rule types receive similar treatment.

---

## Recommended Next Steps

### Short-term

1. Split [complianceRunner.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/modules/complianceRunner.ts) into smaller modules for follow-up execution, entity progression, and evidence-context assembly.
2. Split [main.ts](/d:/Bachelors/TOC-based_system_v.2_modular/src/main.ts) into bootstrap modules for storage, providers, viewer, and UI.
3. Add a dedicated architecture diagram for the task-graph inspection flow, because it is now central to the system.
4. Formalize profile-specific strategies so door, ramp, stair, and space checks can evolve without filling the runner with ad hoc branches.

### Medium-term

1. Introduce backend support for secure key handling and durable trace/report storage.
2. Add replay tooling for traces so completed runs can be revisited as structured experiments.
3. Separate UI state from orchestration state more clearly, ideally through a thin controller/presenter layer.
4. Add explicit benchmarking around task-graph performance, follow-up efficiency, and regulatory-grounding success rates.

### Long-term

1. Move toward a hybrid architecture: browser viewer plus backend orchestration/persistence.
2. Support multi-rule batch inspections over one model.
3. Add collaborative review and approval workflows for findings and reports.
4. Evolve the rule/task-profile system into a reusable framework for additional compliance domains.

---

## Final Assessment

Compared to the March 19 snapshot, the current March 30 codebase is more than a feature increment. It represents a **behavioral architectural upgrade**.

The most important change is that the system now has a stronger notion of:

- what it is inspecting,
- where it is in the inspection process,
- when evidence is exhausted,
- how to move to the next useful target,
- how to preserve the inspection as a reproducible artifact.

**Current verdict: advanced research prototype with increasingly structured agent-like inspection behavior.**

It is still not production architecture, but it is now considerably better suited for thesis experimentation, iterative debugging, and demonstrable end-to-end compliance workflows than the versions captured in the earlier analyses.

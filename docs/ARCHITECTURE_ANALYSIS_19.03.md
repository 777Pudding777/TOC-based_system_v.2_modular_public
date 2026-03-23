# TOC-Based BIM Compliance Checker - Current Architecture Analysis

**Date**: March 19, 2026  
**Repository**: https://github.com/777Pudding777/TOC-based_system_v.2_modular_public.git  
**Purpose**: Bachelor thesis project - agent-based visual compliance checking for IFC/BIM models

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Overview](#current-architecture-overview)
3. [Layer-by-Layer Breakdown](#layer-by-layer-breakdown)
4. [Core Runtime Flow](#core-runtime-flow)
5. [Persistence & Data Model](#persistence--data-model)
6. [VLM and Regulatory Intelligence Stack](#vlm-and-regulatory-intelligence-stack)
7. [UI and User Workflow](#ui-and-user-workflow)
8. [Current Strengths](#current-strengths)
9. [Current Gaps and Risks](#current-gaps-and-risks)
10. [Recommended Next Steps](#recommended-next-steps)

---

## Executive Summary

As of **March 19, 2026**, the project is no longer just a proof-of-concept IFC viewer with a VLM hook. It has evolved into a **frontend-only modular compliance inspection workstation** built with **Vite + TypeScript**, centered on four integrated capabilities:

1. **IFC/BIM model visualization and navigation** using ThatOpen + Three.js.
2. **Agent-style compliance inspection orchestration** using a VLM checker, deterministic viewer actions, and follow-up loops.
3. **Persistent rule, decision, snapshot, and trace storage** through IndexedDB.
4. **Inspection output generation** through trace export and standalone HTML reporting.

### Current maturity snapshot

#### ✅ Implemented and working in architecture
- IFC model loading and interactive viewing.
- Modular viewer API and event/state handling.
- VLM abstraction with provider adapters for **Mock**, **OpenAI**, and **OpenRouter**.
- Multi-step compliance runner with follow-up execution.
- Embedded rule library with IndexedDB-backed rule storage.
- Trace persistence for inspection sessions.
- Standalone HTML report generation.
- Environment validation and provider configuration handling.
- Regulatory-context retrieval pipeline with **WEB_FETCH** and **Tavily-assisted search/fetch hooks**.

#### ⚠️ Still architecturally incomplete or fragile
- The app is still **frontend-only**, so secrets, reliability, and auditability are constrained by browser execution.
- Some integrations remain partially coupled through broad façade objects and `any`-heavy boundaries.
- Reporting/export is implemented, but long-term artifact management is still local-browser only.
- The compliance workflow is strong for single-user experimentation, but not yet production-grade for multi-user or governed review.

### Overall assessment

The system is now best described as a **modular single-page BIM compliance analysis platform** with early agentic behavior, rather than only a viewer demo. The architecture is suitable for thesis experimentation, rule-library growth, and iterative evaluation of VLM-based inspection workflows. The biggest remaining step is moving from a robust browser prototype to a more controlled, auditable, and scalable architecture.

---

## Current Architecture Overview

### High-level architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        Browser App                          │
│                     (Vite + TypeScript)                     │
├─────────────────────────────────────────────────────────────┤
│ UI Layer                                                    │
│ - Main control panel                                        │
│ - Inspection panel                                          │
│ - Toasts, tree, DOM helpers                                 │
├─────────────────────────────────────────────────────────────┤
│ Application / Orchestration Layer                           │
│ - complianceRunner                                          │
│ - vlmChecker facade                                         │
│ - navigationAgent                                           │
│ - ruleLoader                                                │
│ - reportGenerator                                           │
├─────────────────────────────────────────────────────────────┤
│ Viewer Layer                                                │
│ - initViewer                                                │
│ - viewerApi                                                 │
│ - upload                                                    │
│ - state / events / IFC classification                       │
├─────────────────────────────────────────────────────────────┤
│ Persistence Layer                                           │
│ - snapshotDb                                                │
│ - complianceDb                                              │
│ - ruleDb                                                    │
│ - traceDb                                                   │
│ - shared dbConfig                                           │
├─────────────────────────────────────────────────────────────┤
│ Intelligence / Provider Layer                               │
│ - OpenAI adapter                                            │
│ - OpenRouter adapter                                        │
│ - Mock adapter                                              │
│ - Prompt templates                                          │
│ - WEB_FETCH / Tavily / regulatory reduction                 │
└─────────────────────────────────────────────────────────────┘
```

### Architectural style

The codebase uses a **modular vanilla TypeScript architecture** with lightweight service composition in `main.ts`. There is no React/Vue state framework and no backend API server in the main application. Instead, the entry point creates and wires together service modules, storage adapters, viewer controls, and UI mounts.

This gives the project three clear benefits:
- **Low framework overhead** for thesis experimentation.
- **Direct control over viewer/runtime integration**.
- **Composable modules** that can be tested and evolved independently.

The main tradeoff is that `main.ts` now acts as a fairly large composition root, so architectural complexity is centralized there.

---

## Layer-by-Layer Breakdown

### 1. Entry point and composition root

`src/main.ts` is the application bootstrapper. It initializes:
- the ThatOpen UI manager,
- environment validation,
- viewer initialization,
- snapshot collection,
- rule and trace databases,
- VLM adapter configuration,
- navigation agent,
- compliance runner,
- panel mounting and inspection-related integration.

This file is effectively the **dependency injection hub** of the project. It also persists VLM configuration and session-scoped API keys, which makes it part of both the runtime-composition and provider-configuration architecture.

### 2. Viewer subsystem

The viewer subsystem is responsible for:
- loading IFC models,
- maintaining the active model,
- exposing camera and visibility controls,
- capturing render evidence,
- supporting isolation and inspection-oriented viewpoints.

This subsystem is intentionally abstracted behind `viewerApi`, which is critical because the compliance runner and navigation logic need a stable command surface without depending directly on raw ThatOpen internals.

### 3. Compliance orchestration subsystem

The orchestration core is built from:
- `complianceRunner.ts`,
- `vlmChecker.ts`,
- `navigationAgent.ts`,
- `snapshotCollector.ts`.

This subsystem implements the central thesis idea: a rule prompt is evaluated over visual evidence, the VLM can request follow-up actions, the viewer executes those actions, new evidence is captured, and the loop continues until a confidence threshold or step limit is reached.

This is the project’s strongest architectural feature.

### 4. Rule subsystem

The rule subsystem now exists in a more mature form than it did on March 15:
- `src/data/ruleLibrary.json` stores an embedded seed library.
- `src/modules/ruleLoader.ts` initializes the browser database from that embedded library.
- `src/storage/ruleDb.ts` provides CRUD and filtering operations.

This means rules are no longer merely a planned feature; they are now a **persistent application resource**.

### 5. Trace and reporting subsystem

The app now includes an explicit output/documentation layer:
- `traceDb.ts` stores conversation/inspection traces.
- `reportGenerator.ts` produces standalone HTML reports.
- UI actions can export or download inspection outputs.

This is important because the architecture now supports not only running inspections, but also **documenting and reviewing them afterward**.

### 6. Provider and regulatory intelligence subsystem

The VLM layer has matured beyond a single adapter abstraction. It now includes:
- provider-specific adapters,
- shared prompt shaping,
- regulatory web retrieval,
- optional search integration,
- text reduction of retrieved regulatory material.

Architecturally, this means the system is not just “calling a model”; it is building a **context assembly pipeline** for model reasoning.

---

## Core Runtime Flow

### A. Startup flow

1. `main.ts` initializes UI infrastructure.
2. Environment variables are validated.
3. The viewer is created and exposed via `viewerApi`.
4. Snapshot, compliance, rule, and trace storage modules are initialized.
5. The embedded rule library is loaded into IndexedDB if needed.
6. VLM adapter configuration is loaded from browser storage.
7. The compliance runner and UI panel are mounted.

### B. Inspection flow

1. The user loads an IFC model.
2. The user selects a rule from the rule library or enters a custom prompt.
3. The compliance runner resets visibility and applies deterministic or custom start views.
4. The snapshot collector captures one or more evidence artifacts.
5. The VLM checker sends prompt + evidence + metadata to the chosen adapter.
6. The returned structured decision may include a follow-up request.
7. The compliance runner executes the follow-up in the viewer.
8. New evidence is captured and the loop continues.
9. Decisions are saved, a trace is assembled, and reporting/export becomes available.

### C. Regulatory-context flow

When a prompt is vague or needs authoritative code support, the architecture can enrich the evaluation by:
1. deriving allowed domains,
2. fetching or searching regulatory content,
3. reducing that content,
4. injecting it back into the model prompt,
5. rerunning or refining the compliance reasoning step.

This is especially aligned with the TOC-based thesis direction.

---

## Persistence & Data Model

### IndexedDB strategy

The application uses a **shared IndexedDB configuration** via `dbConfig.ts` and multiple logical stores:
- `decisions`
- `rules`
- `rule_metadata`
- `traces`
- snapshot-related storage in the snapshot module

This is a good architectural move because it avoids version conflicts across independently evolving browser databases.

### What is persisted

#### Rules
Persisted rule records include category, severity, visual evidence guidance, navigation hints, finding templates, dimensional requirements, and source metadata.

#### Decisions
Per-step VLM decisions capture verdict, confidence, rationale, visibility, evidence references, follow-up instructions, and metadata.

#### Traces
Trace storage supports session-level reconstruction of a compliance inspection, including run identity and export-friendly structures.

#### Snapshots
Visual artifacts are persisted for later review and report generation.

### Architectural implication

The browser now acts as a **local experiment database**. That is a strong fit for offline-ish thesis work and repeated inspection experiments, but it is not yet a replacement for server-side persistence, collaboration, or centralized audit logs.

---

## VLM and Regulatory Intelligence Stack

### VLM abstraction

The checker architecture is built around a provider-agnostic `VlmAdapter` interface. This preserves core business logic while allowing adapter swapping.

Current provider modes:
- **Mock**: deterministic testing path.
- **OpenAI**: structured outputs and image-capable evaluation.
- **OpenRouter**: broader multi-model routing with practical configuration control.

### Follow-up action model

The structured follow-up schema is one of the most important design assets in the repository. It allows the model to request actions such as:
- changing viewpoint,
- isolating storeys or spaces,
- hiding/showing elements,
- applying plan cuts,
- fetching code references.

This gives the inspection loop an **agentic shape** without requiring a separate agent framework.

### Regulatory augmentation

The architecture includes multiple routes for code-context enrichment:
- allowlisted proxy fetch via `WEB_FETCH`,
- optional Tavily-backed discovery/fetch support,
- regulatory reduction to fit model context windows.

This is a strong research-oriented design decision because it recognizes that many compliance prompts are underspecified unless they are grounded in authoritative code text.

### Main strength of this layer

The model is not treated as an all-knowing black box. Instead, the architecture wraps it in:
- prompt policy,
- evidence metadata,
- structured outputs,
- tool-driven context acquisition,
- deterministic escalation behavior.

That is a solid foundation for reproducibility and iterative evaluation.

---

## UI and User Workflow

### UI composition

The UI is implemented with ThatOpen UI components and custom DOM composition rather than a SPA framework.

Key user-facing areas include:
- file upload and model loading,
- rule and custom prompt selection,
- provider configuration,
- inspection progress/state,
- recent trace access,
- report download/export,
- IFC tree and inspection controls.

### Architectural status of the UI

The UI is now more than a viewer shell. It acts as a **workflow console** for inspection runs. In practice, the panel layer bridges:
- viewer controls,
- model/provider state,
- rule selection,
- inspection execution,
- result retrieval and reporting.

This makes the UI layer operationally powerful, but it also means that some business workflow logic is embedded close to rendering logic.

---

## Current Strengths

### 1. Clear modular separation
The repo has meaningful boundaries between viewer, storage, orchestration, provider adapters, reporting, and UI.

### 2. Strong thesis alignment
The architecture strongly supports the research question around **TOC-based, agent-like, visual compliance checking**.

### 3. Practical persistence model
Using IndexedDB for decisions, rules, traces, and snapshots supports iterative experimentation well.

### 4. Provider flexibility
The adapter pattern makes model-provider experimentation practical without large rewrites.

### 5. Evidence-driven reasoning loop
The combination of snapshots, navigation metadata, structured follow-up actions, and repeated checks is the most distinctive and valuable system behavior.

### 6. Reporting is now real
Compared with the March 15 analysis, reporting is no longer missing. The existence of standalone HTML report generation materially improves the architecture’s completeness.

### 7. Rule library is now real
Likewise, the rule library is no longer just a gap; it exists as embedded structured data with persistence and CRUD support.

---

## Current Gaps and Risks

### 1. Frontend-only secret handling
API keys are handled in browser context. Even with session/local storage distinctions, this is still weak for real deployment.

### 2. Large composition root
`main.ts` is becoming a high-responsibility file. Over time this can become the primary maintainability bottleneck.

### 3. Partial type looseness
Several interfaces use `any` or façade-style untyped edges, especially across UI and runner integration. This will slow confident refactoring.

### 4. Limited operational governance
There is no server-side authentication, shared storage, role management, centralized logging, or review workflow.

### 5. Browser-only persistence risk
IndexedDB is convenient, but it is device-local and fragile compared with backend persistence for long-term research evidence or cross-machine reproducibility.

### 6. Evaluation rigor still depends on process
The architecture can store traces and reports, but rigorous benchmarking still depends on disciplined experiment design, not only the code structure.

### 7. UI/business logic coupling
The panel layer still carries substantial workflow behavior. A future refactor may need clearer presenter/controller boundaries.

---

## Recommended Next Steps

### Short-term
1. **Refactor `main.ts` into smaller bootstrap modules** for viewer, storage, VLM configuration, and UI composition.
2. **Tighten TypeScript contracts** at the runner/UI boundary to reduce `any` usage.
3. **Add architecture diagrams** for inspection flow, data persistence, and regulatory context enrichment.
4. **Version the rule library explicitly** with migration/update behavior when embedded JSON changes.

### Medium-term
1. **Introduce a lightweight backend** for API key brokering, trace/report upload, and shared experiment storage.
2. **Add formal evaluation harnesses** for comparing models, prompts, and navigation strategies.
3. **Separate orchestration state from UI rendering state** to improve maintainability.
4. **Standardize trace schema evolution** so exported runs remain comparable across versions.

### Long-term
1. **Move toward a hybrid architecture**: browser viewer + backend orchestration/persistence.
2. **Add collaborative review workflows** for compliance findings and report approval.
3. **Support multiple regulatory corpora** beyond the current code-fetch assumptions.
4. **Add benchmark datasets and replayable inspection sessions** for thesis-quality reproducibility.

---

## Final Assessment

On **March 19, 2026**, the repository represents a meaningful architectural step up from the March 15 snapshot.

### What changed in practical terms
- The **rule library** now exists and is integrated.
- **Trace persistence** is present.
- **HTML reporting** is present.
- The app more clearly functions as an **inspection platform**, not just a visual prototype.

### Current verdict

**Architecture status: strong research prototype / advanced frontend experimental platform**.

It is already well-structured enough for continued thesis experimentation and demonstration. The next architectural frontier is not basic feature completion anymore; it is **hardening, scaling, and formalizing** the platform so that its outputs are easier to trust, compare, and preserve.

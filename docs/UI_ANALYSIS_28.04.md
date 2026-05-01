# UI Analysis

**Date**: April 28, 2026  
**Goal**: document the current prototype's real user interface components, where they are mounted, what each visible control does, and which UI elements are currently active versus only present in the repository.

## 1. Executive Summary

The active prototype UI is composed of four mounted interface areas:

1. a full-screen 3D viewer canvas in `index.html`
2. a top-left model tree overlay from `src/ui/tree.ts`
3. a top-right unified control panel from `src/ui/panel.ts`
4. a bottom-left toast stack from `src/ui/toast.ts`

In addition, `src/ui/panel.ts` creates a bottom-center inspection dock dynamically while an inspection is running, queued, or completed.

The current prototype does **not** use `src/ui/inspectionPanel.ts`. That file exists as an older standalone inspection UI, but `src/main.ts` mounts `mountPanel(...)`, not `mountInspectionPanel(...)`.

## 2. Files Involved

### Active UI composition

- `index.html`
- `src/main.ts`
- `src/ui/panel.ts`
- `src/ui/tree.ts`
- `src/ui/toast.ts`
- `src/styles.css`

### UI-adjacent modules that active controls call

- `src/viewer/upload.ts`
- `src/viewer/api.ts`
- `src/modules/complianceRunner.ts`
- `src/modules/navigationAgent.ts`
- `src/modules/ruleLoader.ts`
- `src/storage/ruleDb.ts`
- `src/storage/traceDb.ts`
- `src/storage/complianceDb.ts`
- `src/storage/snapshotDb.ts`
- `src/reporting/reportGenerator.ts`
- `src/config/prototypeSettings.ts`

### Present in repo but not mounted

- `src/ui/inspectionPanel.ts`
- `src/ui/dom.ts` currently contains no active shared DOM-building logic

## 3. UI Mounting Structure

`index.html` defines one viewer root and three initial overlay containers:

- `#viewer`
- `#overlay-top-left`
- `#overlay-bottom-left`
- `#overlay-top-right`

`src/main.ts` mounts the active UI as follows:

- `createToast(toastRoot)` attaches transient notifications to `#overlay-bottom-left`
- `mountPanel(...)` attaches the main control interface to `#overlay-top-right`
- `mountTree(...)` attaches the model tree to `#overlay-top-left`

The bottom-center dock is not declared in `index.html`. `mountPanel(...)` creates `#overlay-bottom-center` dynamically inside the viewer overlay host if it does not already exist.

## 4. Visual Layout

The current UI uses an overlay-based layout on top of the 3D viewer:

- the viewer occupies the full browser viewport
- the top-right control panel is a fixed-width sidebar-like floating card
- the top-left model tree is a smaller glass-style overlay
- the bottom-left area shows stacked toast notifications
- the bottom-center area shows inspection progress or completed-check summaries

From `src/styles.css`, the main visual characteristics are:

- right panel width: `420px`
- left tree width: `340px`
- top-right and bottom-center UI use dark translucent cards with borders and shadows
- the right panel uses the `Plus Jakarta Sans` font
- the toast uses a monospace font
- the bottom-center dock becomes single-column on narrower screens

## 5. Active UI Components

### 5.1 Viewer canvas

The central viewer is the 3D model workspace. The UI code does not create separate viewer chrome inside it; instead, controls act on it through `viewerApi`.

Visible viewer-related actions exposed elsewhere in the UI include:

- loading or replacing an IFC file
- switching to preset camera views
- resetting visibility
- isolating storeys, spaces, categories, or explicit object sets
- highlighting selected objects
- restoring recorded scene states from inspection history

### 5.2 Top-right unified control panel

This is the main operational UI. It is mounted from `src/ui/panel.ts` and contains one fixed `Model` section plus four collapsible sections:

- `VLM Provider`
- `Compliance Checking`
- `Inspection History`
- `Debug`

#### 5.2.1 Model section

This section contains the basic viewer controls.

Implemented controls:

- `Load local IFC` when no model is loaded
- `Replace model (upload new)` after a model is loaded
- `ISO view`
- `Top view`
- `Reset visibility`

Actual behavior:

- the load/replace button calls `upload.openFileDialog()`
- `ISO view` calls `viewerApi.setPresetView("iso", true)`
- `Top view` calls `viewerApi.setPresetView("top", true)`
- `Reset visibility` calls `viewerApi.resetVisibility()`
- the load button text changes to `Loading...` while upload is in progress

#### 5.2.2 VLM Provider section

This section configures which decision backend the inspection workflow uses.

Provider choices:

- `Mock (deterministic)`
- `OpenRouter (VLM)`
- `OpenAI / ChatGPT`

Common functionality:

- provider selection is stored through the VLM config facade
- non-secret configuration is persisted locally
- API keys are kept out of `localStorage` and stored in session storage instead

OpenAI-specific fields:

- API key input
- model input
- optional endpoint input

OpenRouter-specific fields:

- API key input
- model dropdown populated from `OPENROUTER_VISION_MODELS`
- short description and model ID text for the selected model
- `Validate key` button
- `Auto-refresh` checkbox
- status card showing whether the key is valid, invalid, or unchecked
- usage/budget values when the key validation endpoint returns them

Implemented OpenRouter behaviors:

- API key validation is triggered manually and also on blur of the API key field
- automatic validation refresh runs every 60 seconds when enabled
- changing the OpenRouter model immediately re-applies the provider configuration silently

Final action in this section:

- `Apply provider`

The section also shows a note stating that requests use `temperature=0` and strict JSON schema for reproducibility.

#### 5.2.3 Compliance Checking section

This section is the core interaction surface for running inspections.

Implemented subcomponents:

- run status card
- input mode switch
- rule selection or custom prompt entry
- deterministic start-view controls
- prototype runtime settings
- primary action button for start/stop/skip/run queue
- `Queue task` button

##### A. Status card

The status card appears once a run has started or while report generation is happening.

Displayed states:

- `RUNNING`
- `COMPLETED`
- `FAILED`

If report generation is underway, the card explicitly shows `Current task: generating report...`.

##### B. Input mode switch

The operator can choose between:

- `Rule Library`
- `Custom Prompt`

Rule Library mode:

- shows a dropdown of enabled rules from `ruleDb.listEnabledRules()`
- each rule option is labeled as `title (category)`
- when a rule is selected, the panel shows its title and description

Custom Prompt mode:

- shows a free-text textarea for the inspection prompt

The default local UI state is `custom`, which preserves older prompt-first behavior.

##### C. Deterministic start configuration

The panel provides:

- a `Deterministic start` checkbox
- a `Start view` selector with `ISO`, `Top`, and `Custom pose`

If `Custom pose` is selected while deterministic start is enabled:

- a JSON textarea appears
- the text is parsed through `complianceRunner.parseCustomPose(...)`
- invalid JSON prevents the task from starting and produces a toast

If deterministic start is disabled:

- the task is stored with adaptive start behavior instead of a predefined view

##### D. Prototype Settings

This is a collapsible runtime-only settings card. It does not rewrite the source file defaults; it updates the runtime settings used for future runs in the current session.

Implemented sliders:

- `DEFAULT_MAX_COMPLIANCE_STEPS`
- `ENTITY_UNCERTAIN_TERMINATION_STEPS`
- `ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE`
- `DEFAULT_MAX_SNAPSHOTS_PER_REQUEST`
- `DEFAULT_REDUCED_TAVILY_MAX_CHARS`
- `ORBIT_MAX_HIGHLIGHT_OCCLUSION_RATIO`
- `SNAPSHOT_NOVELTY_REDUNDANCY_THRESHOLD`

Implemented action:

- `Reset to file defaults`

Special behavior:

- the snapshot-per-request slider also synchronizes the active OpenRouter config's `maxImages`
- controls are disabled while an inspection is running

##### E. Start, stop, skip, and queue controls

The main action button changes label based on current state:

- `Start checking`
- `Run queued tasks`
- `Stop checking`
- `Skip this check`
- `Stopping...`
- `Skipping...`

Actual behavior:

- if nothing is running and there are no queued tasks, it starts a new inspection
- if queued tasks exist, it starts queue processing
- if a run is active and queued tasks remain, it requests `skip`
- if a run is active and no queued tasks remain, it requests `stop`

Secondary action:

- `Queue task`

Queue entries capture the current:

- prompt or selected rule
- deterministic start configuration
- runtime settings
- provider
- model ID

#### 5.2.4 Inspection History section

This section combines queued tasks and saved completed traces.

Implemented contents:

- queued task cards
- recent saved trace cards
- `Clear Finished Queue Items`
- `Clear History`

Queued task cards show:

- task label
- queue or verdict badge
- queued timestamp
- provider and model
- start-view description
- max step count
- error message when present

Completed trace cards show:

- rule title
- final verdict badge
- completion timestamp

Click behavior:

- clicking a queued item opens its trace only if `traceId` exists
- clicking a saved trace loads the full trace from `traceDb`
- if scene states are present, the viewer is restored to the trace's currently selected scene

#### 5.2.5 Debug section

This section exposes developer-oriented controls that are visible in the shipped prototype UI.

Implemented controls:

- `Enable pick highlight debug` / `Disable pick highlight debug`
- `Capture snapshot`
- `List runs (console)`
- `Preview latest snapshot`
- `Run JSON test (...)`
- `Navigate to isolate selection`
- `Clear DB (reset project)`

Actual behavior:

- debug pick mode attaches a click listener to the viewer canvas
- when enabled, clicking the canvas calls `viewerApi.pickObjectAt(x, y)` and highlights the result with warn styling
- manual snapshot capture stores an artifact through `snapshotCollector.capture("manual")`
- snapshot preview loads the latest artifact from IndexedDB or in-memory run data and opens it in a new tab
- `Run JSON test` executes the VLM JSON contract test for the active adapter
- `Navigate to isolate selection` calls `navigationAgent.goToCurrentIsolateSelection(...)`
- `Clear DB (reset project)` deletes the shared IndexedDB, clears snapshot data, resets viewer visibility, clears local inspection UI state, and instructs the user to reload to re-initialize rules

### 5.3 Bottom-center inspection dock

This component is created dynamically by `src/ui/panel.ts`.

It appears when any of the following is true:

- an inspection is running
- report generation is in progress
- an inspection has completed
- queued tasks exist

The dock has two operating modes.

#### 5.3.1 Active-run mode

While a run is in progress, the dock shows:

- a progress bar
- `Current task`
- the current task title from the task graph when available
- a short "What the VLM is thinking" summary
- `Step X of Y`
- `Entity X of Y`
- a `Follow-up done` summary

This makes the dock a live execution monitor rather than only a status badge.

#### 5.3.2 Completed-run mode

After a trace exists, the dock shows:

- `Completed check`
- final verdict badge
- final confidence
- final rationale when available
- `Generate Report`
- `Export Trace`
- summary metrics for snapshots, VLM calls, and duration

If the trace contains scene states, the dock also shows:

- the current scene label
- optional scene action/state text
- scene details such as view preset, storey, isolated count, categories, highlight count, hidden count, or plan cut
- previous and next step arrows
- the current scene index

The scene stepper is not just informational. It calls `restoreSceneState(...)` and replays the saved viewer state.

### 5.4 Top-left model tree

This overlay is mounted from `src/ui/tree.ts` and rebuilt on every model load.

Structure:

- header with `Model Tree` title
- `Reset` button
- helper text: `Tip: Ctrl+Click a storey in the tree to isolate it.`
- storey hierarchy
- spaces nested under storeys
- separate `Categories` section

Actual behavior:

- on model load, the code rebuilds IFC classifications first
- if classifications are not ready, the tree can display `(Tree not ready yet)`
- the `Reset` button calls `viewerApi.resetVisibility()`
- Ctrl+click on a storey summary isolates that storey's object map
- clicking a space row isolates that space map
- clicking a category row isolates that category map
- the tree emits a `Tree updated` toast after rebuilding successfully

Important limitation:

- regular storey interaction is mainly native `<details>` expansion; the explicit isolate behavior is bound to Ctrl+click, not ordinary click

### 5.5 Bottom-left toast stack

The toast system is intentionally simple and DOM-based.

Implemented behavior:

- each toast is appended as a new `.toast` element
- messages auto-remove after a timeout, default `5000 ms`
- the container uses `pointer-events: none`, so notifications do not block 3D interaction

The toast mechanism is used throughout the UI for:

- model/tree feedback
- provider validation feedback
- queueing confirmation
- inspection completion/failure
- debug actions
- trace restore failures

## 6. Trace Replay As A UI Function

One of the most important implemented UI capabilities is inspection replay.

When a user opens a trace from history or navigates between scene steps, `restoreSceneState(...)` replays the saved UI/viewer context by:

- resetting visibility
- restoring explicit object isolation when available
- otherwise restoring storey, space, or category isolation
- restoring hidden IDs
- restoring camera pose
- restoring plan cut when recorded
- restoring highlights

This means inspection history is not only archival. It acts as a practical interface for revisiting evidence states inside the viewer.

## 7. State Persistence Relevant To UI

The active UI persists several user-facing settings:

- selected VLM provider configuration in `localStorage`
- API keys in `sessionStorage`
- recent traces in IndexedDB through `traceDb`
- snapshots in IndexedDB through `snapshotDb`
- rule library entries in IndexedDB through `ruleDb`

The prototype therefore supports a partially persistent workflow:

- provider/model configuration survives refresh
- API keys survive only for the session
- inspection traces and snapshots remain available until cleared

## 8. What Is Not Part Of The Mounted UI

To avoid overstating the prototype, the following should be treated as not currently part of the live UI:

- `src/ui/inspectionPanel.ts` is an existing standalone component, but it is not mounted from `src/main.ts`
- `src/ui/dom.ts` does not currently contribute visible shared UI behavior

For the thesis, the authoritative interface description should therefore be based on:

- `index.html`
- `src/main.ts`
- `src/ui/panel.ts`
- `src/ui/tree.ts`
- `src/ui/toast.ts`
- `src/styles.css`

## 9. Thesis-Safe Summary

The current prototype implements a viewer-centric inspection interface built around overlay panels rather than page-style navigation. Its main strengths are:

- a single integrated right-side control panel for model loading, provider setup, inspection execution, history, and debugging
- a separate model tree for quick spatial or category isolation
- persistent inspection history with replayable scene states
- a live inspection dock that exposes execution progress and post-run export functions

Just as importantly, the present UI remains prototype-oriented:

- several controls are clearly developer-facing
- the history and replay workflow is stronger than the general end-user polish
- a legacy inspection panel still exists in the codebase but is not active

That makes the current interface suitable to describe as a research prototype UI for interactive compliance checking, rather than as a finalized production application.

# Navigation And Compliance API Analysis

**Date**: April 26, 2026  
**Goal**: document the current prototype's real navigation behavior, the compliance runner's connection to the viewer API, every executable scenario, and the files involved.

## 1. Executive Summary

The current prototype uses a layered navigation stack:

1. `src/viewer/api.ts`
   Owns the real viewer actions: camera, isolate, hide/show, plan cut, pick, highlight, snapshots, and geometry helpers.
2. `src/modules/navigationAgent.ts`
   Owns deterministic reframing of a selected target using projected area and optional occlusion.
3. `src/modules/complianceRunner.ts`
   Owns follow-up execution, state persistence, anti-loop logic, bookmark reuse, task/entity progression, and the actual bridge from compliance reasoning to viewer API calls.
4. `src/modules/vlmChecker.ts` and adapter modules
   Own the follow-up schema and provider-specific action suggestions.
5. `src/ui/panel.ts`
   Owns manual triggering, queueing, trace creation, replay, and debug navigation entry points.

The compliance system is therefore not calling the viewer directly from the UI or VLM layer. The central integration point is `complianceRunner.ts`, which normalizes follow-ups and then calls `viewerApi`.

## 2. Files Involved

### Core execution path

- `src/viewer/api.ts`
- `src/modules/navigationAgent.ts`
- `src/modules/complianceRunner.ts`
- `src/modules/vlmChecker.ts`
- `src/modules/vlmAdapters/openrouter.ts`
- `src/modules/vlmAdapters/openai.ts`
- `src/modules/vlmAdapters/prompts/promptWrappers.ts`
- `src/ui/panel.ts`
- `src/types/trace.types.ts`
- `src/reporting/reportGenerator.ts`

### Viewer support files

- `src/viewer/initViewer.ts`
- `src/viewer/events.ts`
- `src/viewer/state.ts`
- `src/viewer/gridConfig.ts`
- `src/viewer/ifc/classification.ts`
- `src/viewer/upload.ts`

### Data and persistence that shape navigation/compliance behavior

- `src/data/ruleLibrary.json`
- `src/config/prototypeSettings.ts`
- `src/storage/traceDb.ts`
- `src/storage/complianceDb.ts`
- `src/modules/snapshotCollector.ts`
- `src/modules/taskGraph.ts`

## 3. Viewer API Surface That Navigation Uses

### Camera and rendering

- `getCameraPose()`
- `setCameraPose(pose, smooth?)`
- `setPresetView("iso" | "top", smooth?)`
- `moveCameraRelative(delta, smooth?)`
- `getThreeCamera()`
- `getRendererDomElement()`
- `renderNow()`
- `stabilizeForSnapshot()`

### Visibility and scope

- `isolate(map)`
- `resetVisibility()`
- `isolateCategory(category)`
- `listCategoryObjectIds(category, limit?)`
- `listStoreys()`
- `isolateStorey(storeyId)`
- `listSpaces()`
- `isolateSpace(spaceId)`
- `hideCategory(category)`
- `showCategory(category)`
- `hideIds(ids)`
- `showIds(ids)`
- `getHiddenIds()`
- `getCurrentIsolateSelection()`
- `getVisibilityState()`

### Highlighting, picking, geometry, and semantics

- `highlightIds(ids, style?)`
- `pickObjectAt(x, y)`
- `hideSelected()`
- `getProperties(objectId)`
- `getElementProperties(localId)`
- `getSelectionWorldBox(map)`
- `getSelectionMeshes(map)`
- `getDoorClearanceFocusBox(ids?)`
- `getSceneObjects()`
- `getGridReference()`

### Plan cut and sectioning

- `setPlanCut({ height?, absoluteHeight?, thickness?, mode?, source?, storeyId? })`
- `setStoreyPlanCut({ storeyId, offsetFromFloor?, mode? })`
- `clearPlanCut()`
- `getPlanCutState()`

### Snapshot / evidence

- `getSnapshot({ note? })`

## 4. Viewer-Level Behavior That Matters To Compliance

### Deterministic behavior already implemented

- `setPresetView("top")` becomes target-centered if there is an active highlight.
- `resetVisibility()` clears isolate state, hidden state, plan cuts, and highlight state.
- `highlightIds()` can raise an active `WORLD_UP` plan cut so the highlighted object stays visible.
- `listCategoryObjectIds()` supports deterministic IFC synonym mapping such as `door -> IFCDOOR`.
- `setStoreyPlanCut()` computes a storey-aware cut height and may bias upward to preserve highlighted-door clearance context.
- `getDoorClearanceFocusBox()` gives door-specific framing geometry for more stable close-up navigation.

### Constraints and caveats

- `setStoreyPlanCut()` restores full-model visibility before applying the cut; it is not storey isolation by itself.
- `getSelectionWorldBox()` may fall back to full-model bounds if no precise selection bounds are available.
- `pickObjectAt()` is real viewer picking, but the compliance runner's `PICK_OBJECT` follow-up does not currently use pixel coordinates from the model response.

## 5. Navigation Agent Contract

`src/modules/navigationAgent.ts` is a deterministic geometric helper. It does not know compliance rules.

### Inputs

- a `ModelIdMap`
- optional `focusBox`
- optional thresholds such as `minTargetAreaRatio`, `maxOcclusionRatio`, `maxSteps`, `zoomFactor`, `orbitDegrees`

### Outputs

- `targetAreaRatio`
- `occlusionRatio`
- `steps`
- `success`
- `reason`

### Behavior

1. Measure the target's projected screen area.
2. Optionally estimate occlusion by raycasting a sample grid.
3. Stop if framing thresholds are met.
4. Stop if the search converges without improvement.
5. Otherwise zoom or orbit around the target center.

### Limits

- Orbit uses world Y rotation, not a generalized up-axis abstraction.
- Occlusion is heuristic.
- If the selection box is imprecise, the optimization target is also imprecise.

## 6. Compliance Runner As The Real Integration Layer

`src/modules/complianceRunner.ts` is the decisive bridge between compliance logic and navigation.

It stores run-local navigation state:

- `lastScope`
- `lastIsolatedCategories`
- `lastHiddenIds`
- `lastHighlightedIds`
- `lastSelectedId`
- `lastViewPreset`
- `navigationBookmarks`
- `navigationActionLog`
- `entityEvidenceStats`

It also builds the evidence context that the VLM sees:

- current camera pose
- scope
- isolated IDs
- hidden IDs
- highlighted IDs
- plan cut state
- grid metadata
- floor-context signal
- task-graph summary
- recent bookmark history
- snapshot novelty

## 7. Executable Follow-Up Scenarios

These are the real follow-ups the runner can execute today.

| Follow-up | Current execution behavior | Viewer/API dependency |
|---|---|---|
| `ISO_VIEW` | sets iso preset, reapplies highlight, recenters on active highlight | `setPresetView`, `highlightIds`, navigation agent |
| `TOP_VIEW` | sets top preset unless already top, reapplies highlight, recenters using top-view target ratio | `setPresetView`, `highlightIds`, navigation agent |
| `SET_VIEW_PRESET` | supports `TOP` and `ISO`; unsupported presets become no-op | `setPresetView` |
| `HIDE_CATEGORY` | hides one IFC category and refreshes hidden-state memory | `hideCategory`, `getHiddenIds` |
| `SHOW_CATEGORY` | shows one IFC category and refreshes hidden-state memory | `showCategory`, `getHiddenIds` |
| `PICK_CENTER` | chooses deterministic highlight candidate(s), highlights, and focuses | `highlightIds`, navigation agent |
| `PICK_OBJECT` | chooses deterministic candidate(s), not screen coordinates, then highlights and focuses | `highlightIds`, navigation agent |
| `SET_PLAN_CUT` | applies plan cut, reapplies highlight, recenters | `setPlanCut`, `highlightIds`, navigation agent |
| `SET_STOREY_PLAN_CUT` | applies storey-aware plan cut, records storey scope, reapplies highlight, recenters | `setStoreyPlanCut`, `highlightIds`, navigation agent |
| `CLEAR_PLAN_CUT` | clears plan cut, reapplies highlight, recenters | `clearPlanCut`, `highlightIds`, navigation agent |
| `RESTORE_VIEW` | restores saved bookmark state | `resetVisibility`, `isolate`, `isolateStorey`, `isolateSpace`, `hideIds`, `setCameraPose`, `setPlanCut`, `clearPlanCut`, `highlightIds` |
| `HIGHLIGHT_IDS` | prefers active entity when available, highlights it, and hard-centers if needed | `highlightIds`, `getSelectionWorldBox`, `getDoorClearanceFocusBox`, `setCameraPose` |
| `GET_PROPERTIES` | now highlights/focuses the target and calls `viewerApi.getProperties(objectId)` when available | `getProperties`, `highlightIds`, navigation agent |
| `HIDE_SELECTED` | hides the last picked object and refreshes hidden-state memory | `hideSelected`, `getHiddenIds` |
| `ORBIT` | bounded orbit, optional post-orbit occlusion guard and retries | `getCameraPose`, `setCameraPose`, navigation agent |
| `NEW_VIEW` | treated as bounded orbit-like exploration | `getCameraPose`, `setCameraPose`, navigation agent |
| `ZOOM_IN` | prefers target-focused navigation if highlighted; otherwise scales eye-to-target vector directly | `getCameraPose`, `setCameraPose`, navigation agent |
| `ISOLATE_CATEGORY` | either highlight-only focused context or real isolation depending on available ids and task focus | `listCategoryObjectIds`, `highlightIds`, `isolateCategory`, navigation agent |
| `ISOLATE_STOREY` | isolates a storey and records storey scope | `isolateStorey` |
| `ISOLATE_SPACE` | isolates a space and records space scope | `isolateSpace` |
| `RESET_VISIBILITY` | clears viewer state and runner state | `resetVisibility` |
| `HIDE_IDS` | hides specific ids, updates hidden-state memory, reapplies highlight | `hideIds`, `getHiddenIds`, `highlightIds` |
| `SHOW_IDS` | shows specific ids, updates hidden-state memory, reapplies highlight | `showIds`, `getHiddenIds`, `highlightIds` |
| `WEB_FETCH` | not executed by the viewer; handled inside the checker/tooling path | `vlmChecker` / adapter tools |

## 8. Decision Layers Above The Runner

### Prompt and rule guidance

- `src/data/ruleLibrary.json` contributes `navigationHints`
- `src/modules/vlmAdapters/prompts/promptWrappers.ts` injects stronger workflow guidance like top view, plan cut, highlight-first, and web-first behavior

These influence the VLM, but do not execute navigation directly.

### Provider-specific behavior

`src/modules/vlmAdapters/openrouter.ts` adds deterministic follow-up normalization and override logic using:

- task profile
- active entity
- active storey
- last action reason
- highlight state
- plan cut state
- floor context
- zoom exhaustion
- orbit budget

`src/modules/vlmAdapters/openai.ts` is narrower because its structured follow-up schema supports fewer action types than the runner does.

## 9. Traceability And Replay

### What is logged

- `navigationActionLog` in `complianceRunner.ts`
- `ConversationTrace.navigationActions` in `src/types/trace.types.ts`
- `sceneStates` built in `src/ui/panel.ts`
- HTML navigation appendix in `src/reporting/reportGenerator.ts`

### What a navigation action stores

- requested action
- executed action
- params and requested params
- active entity/storey
- success or no-op
- before/after camera + highlight + plan-cut state
- deterministic navigation metrics
- evaluation summary

### Replay paths

- inspection scene replay in `panel.ts`
- navigation bookmark restore in `complianceRunner.ts`

## 10. Improvements Applied In This Pass

Two concrete shortcomings were fixed.

### 10.1 Bookmark restore now replays more real viewer state

Before:

- bookmarks stored categories, hidden IDs, highlight IDs, and scope
- restore mainly replayed scope, camera, plan cut, and highlights
- exact isolated element state and hidden element replay were incomplete

Now:

- bookmarks store `isolatedIds`
- `RESTORE_VIEW` first restores exact isolation when available
- hidden IDs are replayed back into the viewer through `hideIds()`

This makes compliance bookmark reuse more faithful, especially when the runner wants to revisit a focused evidence setup rather than only a camera pose.

### 10.2 `GET_PROPERTIES` now actually uses the viewer property API

Before:

- the action only highlighted a candidate and returned a fallback pseudo-result

Now:

- the runner still highlights and focuses the candidate
- but it also calls `viewerApi.getProperties(objectId)` when available
- it falls back to the old highlighting-only stub only when real properties are unavailable

This makes the action semantically honest and aligns the compliance side better with the viewer API contract.

## 11. Remaining Known Gaps

These are still important if you want to keep improving the prototype.

- `PICK_OBJECT` still ignores requested screen coordinates and behaves as deterministic target selection.
- `ISOLATE_CATEGORY` can still act as highlight-first context instead of true viewer isolation.
- `setStoreyPlanCut()` still gives plan-cut context, not persistent storey isolation.
- OpenAI follow-up expressiveness is still lower than the runner's execution surface.
- The navigation stack is still spread across prompt guidance, provider overrides, runner normalization, and viewer semantics rather than a single declarative planner.

## 12. Suggested Next Refactor Targets

If we continue after this pass, the highest-value next steps are:

1. Add a formal `ViewerNavigationFacade` type shared by `viewer/api.ts`, `complianceRunner.ts`, and `navigationAgent.ts`.
2. Separate "highlight-only focus context" from true isolation so action logs and replay are semantically exact.
3. Turn `PICK_OBJECT` into a true coordinate-aware path when the provider supplies screen-space intent.
4. Feed real `GET_PROPERTIES` results into evidence/trace payloads so the VLM and reports can use them explicitly.
5. Consolidate provider override rules and runner anti-repeat rules into one auditable navigation policy module.

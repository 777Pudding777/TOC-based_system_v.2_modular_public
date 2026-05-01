# Navigation State-Of-The-Art Analysis

**Date**: April 28, 2026  
**Goal**: document the most advanced currently active navigation system in the app, with emphasis on real hierarchy, decision criteria, executable scenarios, and the exact files that now define the best available navigation behavior.

---

## 1. Executive Summary

The current state-of-the-art navigation system in this repository is no longer just:

- a viewer API,
- plus a follow-up string from the model,
- plus a few camera moves.

It is now a **multi-layer navigation stack** that combines:

- viewer-native visibility, highlighting, plan-cut, and camera operations,
- a deterministic geometric navigation agent,
- task-graph-provided active entity and storey focus,
- provider-side tactical overrides for certain profiles,
- runtime evidence-requirement planning,
- semantic anti-repeat suppression,
- storey-level prepared-view reuse,
- and first-class navigation action tracing.

The strongest current path is:

1. `src/modules/vlmAdapters/prompts/promptWrappers.ts`
   Shapes navigation as advisory evidence repair, not as free-form model exploration.
2. `src/modules/vlmAdapters/openrouter.ts`
   Adds the richest current provider-side tactical override logic.
3. `src/modules/complianceRunner.ts`
   Owns the actual navigation policy, suppression, execution, and logging.
4. `src/modules/navigationAgent.ts`
   Measures and improves framing deterministically.
5. `src/viewer/api.ts`
   Owns the real scene operations.
6. `src/ui/panel.ts`
   Persists navigation actions into the trace and exposes manual debug navigation.

Inside this repository, the current best navigation system is therefore **not a single module**. It is the interaction of prompt guidance, provider overrides, runtime planning, and viewer semantics, with `complianceRunner.ts` as the decisive integration layer.

---

## 2. What "State-Of-The-Art" Means In This App

Within this codebase, the current navigation system counts as state-of-the-art when it has all of these properties:

1. It reasons from **evidence requirements** before choosing a concrete follow-up.
2. It reasons **per active entity and per active storey**, not only per run.
3. It tracks **visual novelty** and **semantic evidence progress**, not only camera movement.
4. It can suppress follow-ups before execution if they would recreate a semantically unproductive view state.
5. It records navigation with action provenance such as `runtime_planner`, `vlm_advisory`, `provider_override`, and `anti_repeat`.
6. It can reuse previously prepared storey views through bookmarks instead of rebuilding every setup from scratch.
7. It distinguishes between:
   - prompt-only navigation hints,
   - provider-specific tactical overrides,
   - runner-enforced deterministic actions,
   - and viewer-level mechanics.

That is a major step beyond the earlier navigation stack described in `NAVIGATION_ANALYSIS_26.04.md`.

---

## 3. Core Files Defining The Current Best Navigation System

### Core policy and execution

- `src/modules/complianceRunner.ts`
- `src/modules/navigationAgent.ts`
- `src/viewer/api.ts`

### Provider and prompt layers that shape navigation

- `src/modules/vlmAdapters/prompts/promptWrappers.ts`
- `src/modules/vlmAdapters/openrouter.ts`
- `src/modules/vlmChecker.ts`
- `src/modules/taskGraph.ts`
- `src/data/ruleLibrary.json`

### Trace, reporting, and UI surfaces

- `src/types/trace.types.ts`
- `src/ui/panel.ts`
- `src/ui/tree.ts`
- `src/reporting/reportGenerator.ts`

### Viewer boot and capture dependencies

- `src/viewer/initViewer.ts`
- `src/modules/snapshotCollector.ts`
- `src/config/prototypeSettings.ts`

---

## 4. Current Navigation Hierarchy

The current hierarchy is best understood from the most abstract layer down to the real scene operations.

### Layer 1. Rule-library and prompt guidance

`src/data/ruleLibrary.json` contains `navigationHints`, but these hints are **not executed directly by the runner**. Their current effect is indirect:

- `promptWrappers.ts` injects rule-focused guidance such as recommended evidence orientations,
- `promptWrappers.ts` infers generalized evidence requirements from rule text and navigation hints,
- the model sees those hints as advisory context.

This means rule-specific navigation is currently **prompt-shaped**, not runtime-enforced.

### Layer 2. Task-graph focus hierarchy

`src/modules/taskGraph.ts` contributes the current navigation focus by exposing:

- `activeTask`
- `activeEntity`
- `activeStorey`
- `primaryClass`
- `concerns`
- `nextEntities`

It also injects instructions like:

- stay focused on the active task and entity,
- prefer per-entity navigation over bulk verdicts,
- reuse current storey and view setup for repeated targets on the same storey.

This layer does not move the camera itself, but it strongly shapes which entity the later navigation layers treat as the current target.

### Layer 3. Prompt contract for the primary model

`src/modules/vlmAdapters/prompts/promptWrappers.ts` now frames navigation as a weak advisory output. The active wrapper explicitly tells the model to:

- focus on evidence requirements rather than navigation recipes,
- treat runtime evidence state as authoritative,
- prefer `missingEvidence` and `evidenceRequirementsStatus` over `followUp`,
- use `TOP_VIEW` or `SET_STOREY_PLAN_CUT` only when plan-based measurement is not ready,
- use `ORBIT` or `NEW_VIEW` only when another context angle is needed after the target is already focused,
- prioritize `WEB_FETCH` before geometry navigation when the real missing piece is regulatory clause text.

This is an important hierarchy boundary: prompt wrappers can bias navigation, but they do not enforce it.

### Layer 4. Provider-side tactical override logic

`src/modules/vlmAdapters/openrouter.ts` is the richest current provider-side navigation policy layer.

It can override model-suggested follow-ups when the verdict is `UNCERTAIN`, based on:

- task profile,
- target class,
- active entity,
- active storey,
- highlighted state,
- isolated category state,
- view preset,
- plan-cut state,
- floor-context signal,
- zoom exhaustion,
- orbit budget,
- and the reason of the last executed action.

Current provider-specific hard-coded sequences include:

- door ordering:
  - top view first,
  - then storey plan cut,
  - then category isolation,
  - then active-entity highlight,
  - then zoom,
  - then one bounded confirmation orbit.
- stair ordering:
  - isolate wanted storey,
  - then iso view,
  - then active-entity highlight,
  - then orbit if highly occluded,
  - then top view for accessibility-focused checks,
  - then storey plan cut,
  - then zoom.
- ramp ordering:
  - isolate wanted storey,
  - then iso view,
  - then active-entity highlight,
  - then orbit if highly occluded,
  - then top view for accessibility-focused checks,
  - then storey plan cut or generic plan cut,
  - then zoom.

This layer is still highly useful, but it is also still profile-specific and not fully generalized.

### Layer 5. Runner-side deterministic navigation planner

`src/modules/complianceRunner.ts` is the real operational owner of navigation.

It:

- derives runtime evidence requirements,
- builds follow-up candidates,
- suppresses candidates using semantic anti-cycle logic,
- executes the final chosen follow-up,
- measures before/after state,
- records navigation metrics,
- updates entity-level semantic trackers,
- creates reusable bookmarks,
- and restores prepared views for later entities on the same storey.

This is the strongest current generalized navigation layer in the repository.

### Layer 6. Deterministic geometric helper

`src/modules/navigationAgent.ts` is not a policy layer. It is a deterministic helper that:

- measures projected target area,
- optionally estimates occlusion by raycasting,
- zooms or orbits to improve framing,
- and returns explicit geometric navigation metrics.

It does not decide which inspection action should happen next. It only improves a chosen selection or view.

### Layer 7. Viewer-native scene operations

`src/viewer/api.ts` owns the actual scene mutations:

- camera presets and camera pose,
- isolate and visibility changes,
- hide/show changes,
- highlight rendering,
- storey and space isolation,
- plan cuts,
- object picking,
- property lookup,
- snapshots,
- and target geometry helpers such as `getDoorClearanceFocusBox`.

This is the lowest real navigation layer. Everything above it is strategy or orchestration.

---

## 5. Current Navigation State Available To Decisions

The current navigation system reasons over much richer state than the 26.04 version.

The runner now tracks or derives:

- `lastScope`
- `lastIsolatedCategories`
- `lastHiddenIds`
- `lastHighlightedIds`
- `lastSelectedId`
- `lastViewPreset`
- `navigationBookmarks`
- `navigationActionLog`
- entity evidence stats
- entity semantic trackers
- current plan-cut state
- snapshot novelty
- follow-up budgets
- floor-context signals
- active task-graph focus

The trace types in `src/types/trace.types.ts` now also support:

- action-family classification,
- suppressed follow-up logging,
- semantic evidence progress,
- recurrence scores,
- novelty metrics,
- action provenance,
- and finalization reasons.

This is one of the biggest current improvements in the navigation stack.

---

## 6. Current Generalized Navigation Decision Criteria

The strongest current generalized navigation policy lives in `deriveRuntimeEvidenceRequirements(...)`, `buildEvidenceRequirementFollowUpCandidates(...)`, and `chooseFollowUpFromEvidenceRequirements(...)` inside `src/modules/complianceRunner.ts`.

### 6.1 Runtime evidence requirements

The runner derives a generalized evidence state with keys such as:

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

These are computed from current runtime state, not from model self-report alone.

### 6.2 Candidate-building order

The current candidate builder follows this real priority order:

1. Preserve `WEB_FETCH` when regulatory clause text is still missing.
2. If the target is not visible:
   - isolate active storey,
   - isolate relevant category,
   - highlight active entity.
3. If the target is visible but not focused:
   - highlight active entity,
   - then zoom if zoom is still available.
4. If plan-based measurement is needed but not ready:
   - go to top view,
   - then prepare a storey plan cut,
   - then fall back to a generic plan cut.
5. If occlusion is limiting evidence:
   - isolate category,
   - then request a bounded orbit if context view is also needed.
6. If context view is needed but not ready:
   - orbit if orbit budget remains,
   - otherwise request `NEW_VIEW`.
7. Only if no stronger runtime action is justified:
   - preserve the advisory follow-up from the VLM or provider.

This is the best current generalized navigation hierarchy in the codebase.

---

## 7. Semantic Suppression And Anti-Repeat Logic

The strongest part missing from older navigation descriptions is the semantic anti-cycle layer.

### Current suppression inputs

`evaluateSemanticFollowUpCandidate(...)` can block a follow-up based on:

- per-family budgets from `SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS`,
- semantic stagnation,
- repeated evidence gaps,
- same-entity recurrence warnings,
- projected recurrence before execution,
- low visual novelty,
- low semantic progress,
- and repeated use of the same action family.

### Current action families

The trace schema now classifies follow-ups into:

- `plan_measurement`
- `context_angle`
- `focus`
- `scope`
- `occlusion_or_context_cleanup`
- `regulatory_grounding`
- `property_measurement`
- `restore`
- `reset`

### Current consequence

If all candidate follow-ups are suppressed, the planner returns:

- no follow-up,
- source `anti_repeat`,
- a suppression record when available,
- and possibly a semantic finalization reason.

This is a major current improvement because the navigation system can now decide that another step is probably not useful.

---

## 8. Snapshot Novelty And Same-Entity Recurrence

The current navigation system now has a deterministic novelty layer in `computeSnapshotNoveltyMetrics(...)`.

It compares the current snapshot against the previous relevant snapshot using:

- view preset change,
- camera movement,
- yaw/pitch change,
- plan-cut change,
- highlighted-id change,
- scope change,
- projected-area change,
- and occlusion change.

The result includes:

- `approximateNoveltyScore`
- `redundancyWarning`
- `comparedToSnapshotId`
- `sameEntityAsPrevious`

The recurrence layer then goes further and predicts whether a proposed follow-up would recreate a semantically unproductive same-entity state.

This means the current navigation system can reject a follow-up **before executing it** if the predicted state is too similar to a recent failed one.

---

## 9. Current Executable Navigation Surface

These are the real follow-up requests the runner can execute today.

| Follow-up | Current real behavior |
|---|---|
| `ISO_VIEW` | Sets iso preset, reapplies persistent highlight, then recenters on the active highlight. |
| `TOP_VIEW` | Sets top preset unless top is already active, reapplies highlight, then recenters with a smaller top-view framing target. |
| `SET_VIEW_PRESET` | Supports `TOP` and `ISO`; unsupported presets become no-op. |
| `HIDE_CATEGORY` | Hides one IFC category and refreshes hidden-id memory. |
| `SHOW_CATEGORY` | Shows one IFC category and refreshes hidden-id memory. |
| `PICK_CENTER` | Chooses deterministic highlight candidates, not image-space coordinates, then focuses them. |
| `PICK_OBJECT` | Also chooses deterministic highlight candidates and ignores the requested screen coordinates. |
| `SET_PLAN_CUT` | Applies a generic plan cut, reapplies highlight, and recenters. |
| `SET_STOREY_PLAN_CUT` | Applies storey-aware plan-cut logic, records storey scope, reapplies highlight, and recenters. |
| `CLEAR_PLAN_CUT` | Clears plan cut, reapplies highlight, and recenters. |
| `RESTORE_VIEW` | Restores a stored navigation bookmark. |
| `HIGHLIGHT_IDS` | Prefers the active entity when available, then highlights and centers it. |
| `GET_PROPERTIES` | Highlights and focuses a candidate, then calls `viewerApi.getProperties(...)` if available. |
| `HIDE_SELECTED` | Hides the last picked object and refreshes hidden-id memory. |
| `ORBIT` | Performs bounded orbiting, measures occlusion if possible, and may retry with larger orbit angles up to a hard limit. |
| `NEW_VIEW` | Reuses the orbit path with normalized orbit-like parameters. |
| `ZOOM_IN` | Prefers focused navigation on the highlighted entity; otherwise scales the eye-to-target vector directly. |
| `ISOLATE_CATEGORY` | Often behaves as highlight-first category context; only falls back to true viewer isolation when category ids cannot be used that way. |
| `ISOLATE_STOREY` | Isolates a storey and records storey scope. |
| `ISOLATE_SPACE` | Isolates a space and records space scope. |
| `RESET_VISIBILITY` | Clears viewer state and runner navigation state. |
| `HIDE_IDS` | Hides exact ids, refreshes hidden-id memory, and reapplies highlight. |
| `SHOW_IDS` | Shows exact ids, refreshes hidden-id memory, and reapplies highlight. |
| `WEB_FETCH` | Not executed through the viewer; it is handled in the checker/tooling path. |

---

## 10. Current Viewer Semantics That Matter To Navigation

The viewer layer now contributes several navigation-critical semantics.

### Deterministic or navigation-relevant behaviors

- `setPresetView("top")` becomes target-centered when active highlight exists.
- `resetVisibility()` clears isolate, hidden, plan-cut, and highlight state.
- `highlightIds()` can trigger a plan-cut adjustment to preserve highlighted targets.
- `listCategoryObjectIds()` performs deterministic IFC synonym mapping such as `door -> IFCDOOR`.
- `setStoreyPlanCut()` computes a storey-aware cut height and can bias upward to preserve highlighted target context.
- `getDoorClearanceFocusBox()` gives door-specific framing geometry for close-up navigation.

### Important caveats

- `setStoreyPlanCut()` calls `restoreFullModelVisibilityPreserveHighlight()` before applying the cut, so it does not preserve storey isolation as a viewer state.
- `PICK_OBJECT` follow-ups do not use `viewerApi.pickObjectAt(x, y)` even though the viewer API supports real pixel picking.
- `GET_PROPERTIES` follow-ups do not honor the requested `objectId`; the runner uses the highlighted or deterministically chosen target instead.
- `NavigationStateTrace` logs only camera pose, highlighted ids, and plan cut in before/after state, not the full isolate/hidden state.

Those caveats are important because several action names are more specific than the actual current behavior.

---

## 11. Bookmarking, Prepared Views, And Entity Progression

The current navigation system is now more stateful across repeated entities.

### Bookmark contents

`createNavigationBookmark(...)` stores:

- camera pose,
- view preset,
- scope,
- isolated ids,
- isolated categories,
- hidden ids,
- highlighted ids,
- selected id,
- plan-cut state.

### Prepared-view reuse

`findReusableStoreyBookmark(...)` prefers previously created bookmarks that already have:

- the same storey,
- top view,
- and an enabled plan cut.

`advanceToNextEntity(...)` can then:

- restore that prepared storey view,
- reactivate focus on the next entity,
- and keep storey scope aligned with the next target.

This is one of the strongest current practical improvements for repeated door-like or storey-clustered inspections.

---

## 12. Manual And Operator-Visible Navigation Surfaces

The automated stack is not the only navigation surface in the app.

### Tree UI

`src/ui/tree.ts` currently allows:

- direct category isolation,
- direct space isolation,
- direct storey isolation through `Ctrl+Click`.

### Panel UI

`src/ui/panel.ts` currently exposes or uses:

- debug pick highlighting through real `viewerApi.pickObjectAt(...)`,
- snapshot capture,
- scene-state replay from the stored trace,
- `navigationAgent.goToCurrentIsolateSelection(...)`,
- trace browsing with navigation actions included.

This means the repository currently has both:

- an automated navigation stack for compliance runs,
- and a manual operator/debug navigation surface.

---

## 13. Navigation Traceability In The Current Best System

The navigation trace model is now much stronger than in the 26.04 analysis.

### What is explicitly recorded

`navigationActionLog` entries now include:

- requested action,
- executed action,
- requested params,
- chosen params,
- active entity,
- active storey,
- success or no-op,
- no-op reason,
- before state,
- after state,
- navigation metrics,
- evidence requirements before action,
- decision source,
- decision reason,
- evaluation summary,
- snapshot novelty before action,
- semantic evidence progress,
- action family,
- suppressed follow-up,
- finalization reason.

### Where it goes

`src/ui/panel.ts` now pulls `getNavigationActions()` from the runner and writes the result into `ConversationTrace.navigationActions`.

That means current navigation is now a first-class research artifact, not just console-side behavior.

---

## 14. Current State-Of-The-Art In One Sentence

The current state-of-the-art navigation system in this app is an **evidence-requirement-driven, entity-focused, provider-assisted, semantically suppressed, bookmark-reusing, trace-first navigation stack**.

---

## 15. Current Limitations Of The State-Of-The-Art Path

Even the best current path still has important limitations.

1. The strongest tactical logic is still concentrated in the OpenRouter path, not in one provider-agnostic policy layer.
2. Rule-library `navigationHints` still shape prompt text rather than directly shaping runtime navigation.
3. `PICK_OBJECT` still ignores requested coordinates.
4. `GET_PROPERTIES` still ignores the requested `objectId` parameter.
5. `ISOLATE_CATEGORY` is still partly a highlight-first focus action instead of always meaning real viewer isolation.
6. `SET_STOREY_PLAN_CUT` still prepares a plan-cut state, not a stable storey-isolated state.
7. Navigation ownership is still distributed across prompt wrappers, provider overrides, runner policy, navigation agent geometry, and viewer semantics.
8. Navigation trace before/after state is richer than before, but still not a full visibility-state snapshot.

These limits matter directly if the goal is to generalize the navigation system into a cleaner architecture.

---

## 16. Files To Read First For The Real Current Best Navigation System

If someone wants to understand the current best navigation stack in the fewest files, the best reading order is:

1. `src/modules/complianceRunner.ts`
2. `src/viewer/api.ts`
3. `src/modules/vlmAdapters/openrouter.ts`
4. `src/modules/navigationAgent.ts`
5. `src/modules/vlmAdapters/prompts/promptWrappers.ts`
6. `src/modules/taskGraph.ts`
7. `src/types/trace.types.ts`
8. `src/ui/panel.ts`

That set currently explains most of the navigation hierarchy, decision logic, and traceability that define the app's best available navigation system.

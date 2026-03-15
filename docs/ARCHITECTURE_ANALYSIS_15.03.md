# TOC-Based BIM Compliance Checker - Architecture Analysis

**Date**: March 15, 2026  
**Repository**: https://github.com/777Pudding777/TOC-based_system_v.2_modular_public.git  
**Purpose**: Bachelor thesis project - Agent-based visual compliance checking for IFC/BIM models

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture](#current-architecture)
3. [VLM Checker Abstraction & Adapter Pattern](#vlm-checker-abstraction--adapter-pattern)
4. [IFC Viewer Capabilities](#ifc-viewer-capabilities)
5. [UI Components & State Management](#ui-components--state-management)
6. [Data Flow & Component Interactions](#data-flow--component-interactions)
7. [Missing Pieces for Phase 1](#missing-pieces-for-phase-1)
8. [Phase 1 Implementation Plan](#phase-1-implementation-plan)

---

## Executive Summary

This is a **frontend-only** IFC/BIM viewer application built with **Vite + TypeScript** for automated compliance checking using Vision-Language Models (VLMs). The app already has:

### ✅ Existing Capabilities
- **IFC model loading and viewing** (ThatOpen Components + Three.js)
- **VLM checker abstraction** with structured decision output
- **Adapter-based provider support** (Mock, OpenAI, OpenRouter)
- **Agent loop orchestration** (ComplianceRunner with follow-up execution)
- **Snapshot capture & storage** (IndexedDB persistence)
- **Navigation agent** (geometric viewpoint optimization)
- **Decision storage** (IndexedDB for compliance decisions)
- **Basic UI components** (BUI panels, toasts, file upload)
- **WEB_FETCH tool** for regulatory code retrieval (via proxy)

### 🎯 Phase 1 Goals
1. **Real VLM Integration** ✅ (Already implemented: OpenRouter adapter)
2. **Rule Library** ❌ (Missing - needs to be built)
3. **Agent Loop** ✅ (Already implemented: ComplianceRunner)
4. **Conversation Trace Logging** ⚠️ (Partial - decisions logged, full trace missing)
5. **HTML Reporting** ❌ (Missing - needs to be built)

---

## Current Architecture

### Project Structure

```
ifc_bim_viewer/
├── public/
│   ├── thatopen/
│   │   └── worker.mjs           # ThatOpen Components worker
│   ├── web-ifc-mt.wasm          # Web-IFC multi-threaded WASM
│   └── web-ifc.wasm             # Web-IFC WASM
├── src/
│   ├── modules/
│   │   ├── vlmAdapters/
│   │   │   ├── prompts/
│   │   │   │   └── basePrompt.ts    # Shared prompt wrapper
│   │   │   ├── tools/
│   │   │   │   └── webFetch.ts      # WEB_FETCH proxy tool
│   │   │   ├── openai.ts            # OpenAI adapter (Responses API + Structured Outputs)
│   │   │   └── openrouter.ts        # OpenRouter adapter
│   │   ├── complianceRunner.ts      # Orchestrator for compliance checks
│   │   ├── navigationAgent.ts       # Viewpoint optimization
│   │   ├── snapshotCollector.ts     # Snapshot capture & persistence
│   │   ├── vlmChecker.ts            # VLM abstraction + follow-up validation
│   │   └── vlmPrompt.ts             # Legacy prompt utilities
│   ├── storage/
│   │   ├── complianceDb.ts          # IndexedDB for decisions
│   │   └── snapshotDb.ts            # IndexedDB for snapshots
│   ├── ui/
│   │   ├── dom.ts                   # DOM utilities
│   │   ├── panel.ts                 # Main control panel UI
│   │   ├── toast.ts                 # Toast notifications
│   │   └── tree.ts                  # IFC tree view
│   ├── utils/
│   │   ├── geometry.ts              # Geometric utilities
│   │   └── modelIdMap.ts            # ModelIdMap helpers
│   ├── viewer/
│   │   ├── ifc/
│   │   │   └── classification.ts    # IFC classification helpers
│   │   ├── api.ts                   # Viewer API (camera, isolation, snapshots)
│   │   ├── events.ts                # Viewer event system
│   │   ├── initViewer.ts            # Viewer initialization
│   │   ├── state.ts                 # Active model state
│   │   └── upload.ts                # IFC file upload
│   ├── main.ts                      # Application entry point
│   └── styles.css                   # Global styles
├── webfetch-worker/                 # Cloudflare Worker for WEB_FETCH proxy
│   ├── worker.js
│   └── wrangler.toml
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.js (inferred)
```

### Dependencies (package.json)

**Core Dependencies:**
- `@thatopen/components@3.2.6` - BIM viewer components
- `@thatopen/fragments@3.2.13` - Fragment management
- `@thatopen/ui@3.2.0` - UI components (BUI)
- `three@0.182.0` - 3D rendering engine
- `web-ifc@0.0.74` - IFC parsing

**Dev Dependencies:**
- `typescript@5.9.3`
- `vite@7.2.4`

**Notable:** No backend, no React/Vue/Angular - pure Vanilla TS + BUI components

---

## VLM Checker Abstraction & Adapter Pattern

### Core Architecture

The application uses a **clean adapter pattern** to support multiple VLM providers without changing core logic.

#### Key Files
1. **`src/modules/vlmChecker.ts`** - Core abstraction
2. **`src/modules/vlmAdapters/openai.ts`** - OpenAI adapter
3. **`src/modules/vlmAdapters/openrouter.ts`** - OpenRouter adapter
4. **`src/modules/vlmAdapters/prompts/basePrompt.ts`** - Shared prompt template

### VLM Abstraction Design

```typescript
// Core interfaces (vlmChecker.ts)
export type VlmAdapter = {
  name: string;
  check: (input: VlmCheckInput) => Promise<Omit<VlmDecision, "decisionId" | "timestampIso">>;
};

export type VlmCheckInput = {
  prompt: string;                    // User's compliance rule
  artifacts: SnapshotArtifact[];     // Multi-view evidence window
  evidenceViews: EvidenceView[];     // Parallel structured metadata
};

export type VlmDecision = {
  decisionId: string;                // UUID
  timestampIso: string;
  verdict: "PASS" | "FAIL" | "UNCERTAIN";
  confidence: number;                // 0..1
  rationale: string;
  visibility: {
    isRuleTargetVisible: boolean;
    occlusionAssessment: "LOW" | "MEDIUM" | "HIGH";
    missingEvidence?: string[];
  };
  evidence: {
    snapshotIds: string[];
    mode: SnapshotMode;
    note?: string;
  };
  followUp?: VlmFollowUp;            // Next action to gather more evidence
  meta: {
    modelId: string | null;
    promptHash: string;
    provider: string;
  };
};
```

### Follow-Up Actions (27 Types)

The system supports **27 different follow-up actions** for evidence gathering:

**View Controls:**
- `NEW_VIEW`, `ISO_VIEW`, `TOP_VIEW`, `SET_VIEW_PRESET`, `ORBIT`, `ZOOM_IN`

**Scope Tools:**
- `ISOLATE_STOREY`, `ISOLATE_SPACE`, `ISOLATE_CATEGORY`

**Visibility Edits:**
- `HIDE_IDS`, `SHOW_IDS`, `HIDE_CATEGORY`, `SHOW_CATEGORY`, `RESET_VISIBILITY`

**Object Interaction:**
- `PICK_CENTER`, `PICK_OBJECT`, `GET_PROPERTIES`, `HIGHLIGHT_IDS`, `HIDE_SELECTED`

**Plan Cut:**
- `SET_PLAN_CUT`, `CLEAR_PLAN_CUT`

**External Tools:**
- `WEB_FETCH` (for regulatory code retrieval)

### Adapter Implementations

#### 1. Mock Adapter (`createMockVlmAdapter`)
- **Purpose:** PoC testing without API costs
- **Behavior:** Deterministic based on keywords (e.g., "door" → isolate doors)
- **Logic:** First step → UNCERTAIN + follow-up; second step → PASS

#### 2. OpenAI Adapter (`createOpenAiVlmAdapter`)
- **API:** OpenAI Responses API
- **Features:**
  - Structured Outputs (`json_schema` strict mode)
  - Vision input via `input_image`
  - Timeout protection
  - Image detail control (`low`, `high`, `auto`)
- **Model Support:** GPT-4o, GPT-4-turbo, etc. (vision-capable models)

#### 3. OpenRouter Adapter (`createOpenRouterVlmAdapter`)
- **API:** OpenRouter Chat Completions (OpenAI-compatible)
- **Features:**
  - Multi-provider routing (Claude, GPT-4, Gemini, etc.)
  - Attribution headers (`X-Title`, `HTTP-Referer`)
  - Temperature, top_p, max_tokens control
  - Cost control via `maxImages` (default 4)
  - Robust JSON parsing (non-strict mode)
  - **Optional:** Web search plugin for clause discovery
- **Guardrails:** 
  - Deterministic follow-up escalation (storey → top → plan cut → doors)
  - Context-aware follow-up injection

### WEB_FETCH Tool

**Purpose:** Retrieve authoritative regulatory code text from allowlisted domains (e.g., ICC Digital Codes)

**Architecture:**
- **Proxy:** Cloudflare Worker (`webfetch-worker/worker.js`)
- **Caching:** 7-day TTL, persistent via IndexedDB
- **Security:** Domain allowlist validation
- **Flow:**
  1. VLM requests WEB_FETCH with `params.url`
  2. Checker calls proxy with allowlist validation
  3. Proxy fetches, sanitizes, caches
  4. Result injected into prompt as `REGULATORY_CONTEXT`
  5. VLM re-evaluates decision with authoritative text

**TOC Strategy:** Hierarchical fetching (title → chapter → section) to discover exact clause URLs

### Prompt Engineering

**Base Prompt Template** (`basePrompt.ts`):
- **System Role:** BIM compliance vision checker
- **Non-negotiables:** No geometry guessing, nav metrics are authoritative
- **Workflow:** Interpret → Check visibility → Evaluate → Choose follow-up
- **WEB/Reference Policy:** Use WEB_FETCH for authoritative code text
- **ICC TOC Strategy:** Fetch title → chapter → section hierarchically
- **Output Format:** Strict JSON schema

**Evidence Views:**
- Structured metadata passed to VLM
- Includes `nav` metrics (projected area, occlusion), camera pose, scope, hidden IDs, etc.

---

## IFC Viewer Capabilities

### Core Technologies
- **ThatOpen Components** (@thatopen/components 3.2.6)
- **Three.js** (0.182.0)
- **Web-IFC** (0.0.74)

### Viewer Initialization (`initViewer.ts`)

```typescript
export type ViewerContext = {
  components: OBC.Components;
  world: OBC.World<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
  ifcLoader: any;
  fragments: any;
  hider: any;
  classifier: any;
  ifcApi: {
    getAllItemsOfType: (modelId: number, ifcType: number) => Promise<number[]>;
    ifcTypeMap: (ifcTypeName: string) => number | null;
  };
};
```

**Key Features:**
- Preserves drawing buffer for snapshots (`preserveDrawingBuffer: true`)
- Automatic camera fitting on model load
- ISO preset view (deterministic diagonal viewpoint)
- Fragments core updates on camera rest

### Viewer API (`viewer/api.ts`)

The `createViewerApi` function provides a comprehensive API (60+ methods):

#### Camera & Pose
- `getCameraPose()` → `{ eye, target }`
- `setCameraPose(pose, smooth?)` 
- `setPresetView(preset: "iso" | "top", smooth?)`
- `moveCameraRelative(delta, smooth?)`

#### Visibility & Isolation
- `resetVisibility()`
- `isolate(map: OBC.ModelIdMap)` - Show only selected elements
- `isolateCategory(category: string)` - Isolate by IFC type (e.g., "IfcDoor")
- `isolateStorey(storeyId: string)` - Isolate by building level
- `isolateSpace(spaceId: string)` - Isolate by space
- `hideIds(ids: string[])` / `showIds(ids: string[])`
- `hideCategory(category: string)` / `showCategory(category: string)`
- `getHiddenIds()` - Returns canonical "modelId:localId" strings
- `getVisibilityState()` → `{ mode: "all" | "isolate", lastIsolateCount? }`

#### Plan Cut (Clipping Planes)
- `setPlanCut({ height, thickness?, mode?: "WORLD_UP" | "CAMERA" })`
- `clearPlanCut()`
- `getPlanCutState()` → `{ enabled, planes? }`

**Plan Cut Implementation:**
- Single clipping plane (keeps below, clips above)
- WORLD_UP mode: horizontal cut at height (plan view)
- CAMERA mode: cut perpendicular to view direction (section view)
- Material state saving/restoring (side, clippingPlanes, clipIntersection)
- Automatic bounds clamping (prevents clipping entire model)

#### Object Interaction
- `pickObjectAt(x, y)` → objectId or null
- `highlightIds(ids, style?: "primary" | "warn")`
- `getProperties(objectId)` → properties object
- `hideSelected()` - Hide last picked object

#### Selection & Geometry
- `getSelectionWorldBox(map: OBC.ModelIdMap)` → THREE.Box3
- `getLastSelection()` → OBC.ModelIdMap
- `listStoreys()` → string[] (available building levels)
- `listSpaces()` → string[] (available spaces)

#### Snapshot Capture
- `getSnapshot({ note? })` → `{ imageBase64Png, pose, meta }`
- Uses `toDataURL("image/png")` on canvas
- Includes camera pose, model ID, timestamp

#### Stabilization
- `stabilizeForSnapshot()` - Wait for camera rest + fragments update
- Critical for deterministic snapshots (prevents half-updated frames)

#### Low-Level Access
- `getThreeCamera()` → THREE.Camera
- `getRendererDomElement()` → HTMLCanvasElement
- `renderNow()` - Force immediate render
- `getSceneObjects()` → THREE.Object3D[]

#### Category Normalization
- Synonym mapping: "door" → "IfcDoor", "stairs" → "IfcStair", etc.
- Case-insensitive matching
- Regex-based category search with fallback

#### Object ID Parsing
- Supports: `"123"` (localId on active model) or `"modelId:123"`
- Returns: `{ modelId, localId }`

---

## UI Components & State Management

### UI Framework
- **BUI** (@thatopen/ui) - Custom web components from ThatOpen
- **DOM-based** - Direct DOM manipulation, no React/Vue

### Main UI Components

#### 1. Control Panel (`ui/panel.ts`)

**Location:** Top-right overlay (`#overlay-top-right`)

**Sections:**
1. **Model Upload**
   - File dialog trigger
   - Loading state indication

2. **Snapshot Controls**
   - Manual snapshot capture
   - Snapshot list viewer
   - IndexedDB run management

3. **VLM Configuration**
   - Provider selector (Mock / OpenAI / OpenRouter)
   - API key input (sessionStorage + localStorage)
   - Model selection
   - Endpoint override (optional)
   - OpenRouter budget checker (auto-refresh every 60s)

4. **Compliance Runner**
   - Rule prompt input (textarea)
   - Deterministic start options:
     - Disabled (free camera)
     - ISO view
     - Top view
     - Custom pose (JSON editor)
   - Max steps slider (1-20, default 6)
   - Start button

5. **Navigation Agent** (optional)
   - "Go to isolated selection" button
   - Triggers viewpoint optimization

**State Management:**
- **Local closure state** (not global store)
- VLM config persisted via `vlmChecker.setConfig()` / `getConfig()`
  - Non-sensitive params → localStorage
  - API keys → sessionStorage (cleared on tab close)
- Custom pose JSON editor with validation

#### 2. Tree View (`ui/tree.ts`)

**Location:** Top-left overlay (`#overlay-top-left`)

**Purpose:** IFC model hierarchy browser
- Storeys (building levels)
- Spaces (rooms)
- Categories (IFC types)

**Features:**
- Collapsible nodes
- Click to isolate
- Auto-updates on model load

#### 3. Toast Notifications (`ui/toast.ts`)

**Location:** Bottom-left overlay (`#overlay-bottom-left`)

**Purpose:** Non-blocking status messages
- Success/info/error states (via color)
- Auto-dismiss after timeout (default 3s)
- Queue management

### State Management Architecture

**No global state library** (Redux, MobX, etc.)

**State is distributed:**

#### 1. Viewer State (`viewer/state.ts`)
```typescript
let activeModel: any | null = null;
let activeModelId: string | null = null;
let activeIfcModelId: number | null = null;
```
- Internal module state
- Exported getters: `getActiveModel()`, `getActiveModelId()`, `getActiveIfcModelId()`

#### 2. Snapshot Collector State
- **Run state:** `{ runId, startedIso, artifacts }`
- **In-memory store:** `SnapshotStore` (array-based)
- **IndexedDB persistence:** `snapshotDb`

#### 3. Compliance Runner State
- **Runner-local evidence state:**
  - `lastScope`, `lastIsolatedCategories`, `lastHiddenIds`
  - `lastHighlightedIds`, `lastSelectedId`, `lastViewPreset`
- **Active run ID:** `activeRunId` (one rule per project)
- **Follow-up tracking:** `lastFollowUpKey`, `repeatedFollowUpCount`

#### 4. VLM Checker State
- **Facade object** (in main.ts):
  ```typescript
  const vlmChecker = {
    get adapterName() { return currentChecker.adapterName; },
    async check(input) { return currentChecker.check(input); },
    setConfig(next) { /* swap provider */ },
    getConfig() { return vlmUiConfig; }
  };
  ```
- **Internal state:** `vlmUiConfig`, `currentChecker` (mutable for provider swaps)

#### 5. Viewer API State
- **Visibility state:** `{ mode: "all" | "isolate", lastIsolateCount? }`
- **Last isolate map:** `lastIsolateMap` (for navigation)
- **Hidden IDs tracker:** `hiddenMapByModel` (Record<modelId, Set<localId>>)
- **Plan cut state:** `{ enabled, planes }`
- **Material state backup:** `savedMaterialState` (for plan cut restore)
- **Highlight state:** `originalMaterialByMeshUuid` (for restore)

**Event System** (`viewer/events.ts`):
- Simple EventEmitter pattern
- Events: `modelLoaded`, `modelUnloaded`
- UI components subscribe via `viewerApi.onModelLoaded(cb)`

---

## Data Flow & Component Interactions

### Application Bootstrap Flow

```
1. index.html loads → src/main.ts
2. BUI.Manager.init()
3. initViewer(viewerDiv) → ViewerContext
4. createViewerApi(ctx)
5. createNavigationAgent({ viewerApi, toast })
6. createSnapshotDb()
7. createSnapshotCollector({ viewerApi, toast, persistToIndexedDb: true })
8. createIfcUpload({ ifcLoader, viewerApi, toast })
9. createVlmChecker(buildAdapterFromConfig(vlmUiConfig))
10. createComplianceDb()
11. createComplianceRunner({ viewerApi, snapshotCollector, vlmChecker, complianceDb, navigationAgent, toast })
12. mountPanel({ panelRoot, viewerApi, upload, snapshotCollector, vlmChecker, complianceDb, complianceRunner, navigationAgent, toast })
13. mountTree({ treeRoot, ctx, viewerApi, toast })
14. snapshotCollector.start()
```

### Compliance Check Flow (Detailed)

```
USER: Enters rule prompt + clicks "Start Compliance"
  ↓
PANEL: Calls complianceRunner.start({ prompt, deterministic, maxSteps })
  ↓
RUNNER: Reset visibility + snapshots
  ↓
RUNNER: Apply deterministic start pose (if enabled)
  ↓
┌─────────────────────────────────────────┐
│ STEP LOOP (max 20 steps, default 6)    │
└─────────────────────────────────────────┘
  ↓
RUNNER: Capture snapshot
  ↓
SNAPSHOT COLLECTOR: viewerApi.getSnapshot()
  ↓
VIEWER API: 
  - Stabilize scene (wait for camera rest)
  - Update fragments
  - Render to canvas
  - Extract image via toDataURL("image/png")
  - Return { imageBase64Png, pose, meta }
  ↓
SNAPSHOT COLLECTOR: 
  - Build SnapshotArtifact
  - Add to run.artifacts
  - Persist to IndexedDB (async)
  ↓
RUNNER: Build evidence context
  - Camera pose
  - Scope (storey/space)
  - Isolated categories
  - Hidden IDs
  - Highlighted IDs
  - Selected object
  - Available storeys/spaces
  - Plan cut state
  ↓
RUNNER: Get evidence window (last N snapshots)
  ↓
RUNNER: Call vlmChecker.check({ prompt, artifacts, evidenceViews })
  ↓
VLM CHECKER:
  - Normalize input (synthesize missing evidenceViews)
  - Extract allowed domains from prompt
  - Compose prompt with regulatory context
  ┌──────────────────────────────────────┐
  │ WEB_FETCH SUB-LOOP (max 3 iterations)│
  └──────────────────────────────────────┘
    ↓
  CHECKER: Check if prompt is vague (no clause number/thresholds)
    ↓
  CHECKER: Call adapter.check({ prompt, artifacts, evidenceViews })
    ↓
  ADAPTER (e.g., OpenRouter):
    - Flatten images from artifacts
    - Cap to maxImages (default 4)
    - Build image index
    - Wrap prompt with basePrompt template
    - POST to OpenRouter API with vision input
    - Parse JSON response (robust extraction)
    - Validate core fields (verdict, confidence, rationale, visibility)
    - Apply guardrails (deterministic follow-up injection)
    - Return DecisionCore
    ↓
  CHECKER: Check if followUp is WEB_FETCH
    ↓
    IF YES:
      - Validate url against allowed domains
      - Call webFetchViaProxy({ targetUrl, allowedDomains, proxyBaseUrl, maxChars, cache })
      - Inject result as REGULATORY_CONTEXT
      - Loop back to adapter.check() with enriched prompt
    ↓
    IF NO or max iterations:
      - Finalize decision (add decisionId, timestampIso)
      - Filter/validate evidence.snapshotIds
      - Return VlmDecision
  ↓
RUNNER: Receive decision
  ↓
RUNNER: Save to complianceDb.saveDecision(runId, decision)
  ↓
RUNNER: Check stop criteria:
  - (PASS or FAIL) AND confidence >= minConfidence (default 0.75)
    → STOP, return { ok: true, final: decision }
  ↓
  - (PASS or FAIL) AND confidence < minConfidence
    → Execute followUp (if actionable)
    → Continue to next step
  ↓
  - UNCERTAIN AND confidence >= minConfidence
    → STOP (high-confidence uncertainty)
  ↓
  - UNCERTAIN AND confidence < minConfidence
    → Execute followUp (if actionable)
    → Continue to next step
  ↓
RUNNER: Execute followUp
  ↓
  FOLLOW-UP EXECUTOR:
    - Match followUp.request against 27+ action types
    - Call corresponding viewerApi method
    - Track state changes (scope, categories, hidden IDs, etc.)
    - Capture nav metrics (if navigation agent used)
    - Stabilize scene
    - Return { didSomething, reason, nav? }
  ↓
  - If didSomething: Continue to next step
  - If NOT didSomething: STOP (no actionable follow-up)
  ↓
RUNNER: Check for repeated followUp
  - If same followUp repeats → ESCALATE to next action
  - Escalation ladder: ISOLATE_STOREY → TOP_VIEW → SET_PLAN_CUT → ISOLATE_CATEGORY → NEW_VIEW
  ↓
RUNNER: Capture next snapshot (with updated scene state)
  ↓
LOOP back to step start
  ↓
MAX STEPS REACHED: Return { ok: false, reason: "max-steps-reached" }
```

### Snapshot Capture Flow

```
USER/RUNNER: Trigger snapshot
  ↓
SNAPSHOT COLLECTOR: capture(note?, mode?)
  ↓
COLLECTOR: Get visibility state from viewerApi
  ↓
COLLECTOR: viewerApi.getSnapshot({ note })
  ↓
VIEWER API: getSnapshot()
  ↓
  1. stabilizeSceneForSnapshot()
     - waitForControlsRest(1200ms timeout)
     - fragments.core.update(true)
     - waitFrames(4)
     - fragments.core.update(true) again
     - waitFrames(3)
     - Force render × 2
  ↓
  2. getCameraPose()
  ↓
  3. canvas.toDataURL("image/png")
  ↓
  4. Return { imageBase64Png, pose: { eye, target }, meta: { timestampIso, modelId, note } }
  ↓
COLLECTOR: Build SnapshotArtifact
  {
    id: "snap_N_timestamp",
    mode: "RENDER_PLUS_JSON_METADATA",
    images: [{ label: "render", imageBase64Png }],
    meta: {
      timestampIso,
      modelId,
      camera: pose,
      visibility: { mode: "all" | "isolate", visibleElementCount? },
      note
    }
  }
  ↓
COLLECTOR: Add to run.artifacts
  ↓
COLLECTOR: store.add(artifact) (in-memory cache)
  ↓
COLLECTOR: persistArtifactAsync(artifact)
  ↓
SNAPSHOT DB: saveArtifact(runId, artifact)
  - IndexedDB.put({ runId, artifactId, timestampIso, artifact })
```

### Model Load Flow

```
USER: Upload IFC file
  ↓
UPLOAD: openFileDialog()
  ↓
FILE INPUT: <input type="file" accept=".ifc">
  ↓
UPLOAD: Read file as ArrayBuffer
  ↓
UPLOAD: ifcLoader.load(buffer)
  ↓
IFC LOADER: Parse IFC → FragmentsGroup (ThatOpen)
  ↓
FRAGMENTS: list.onItemSet.add(model)
  ↓
INIT VIEWER: Event handler fires
  ↓
  1. model.useCamera(world.camera.three)
  2. world.scene.three.add(model.object)
  3. fragments.core.update(true)
  4. waitForNonEmptyBounds(model.object, 40 frames)
  5. fitToSphere(boundingSphere, smooth: true)
  6. Compute deterministic ISO view
  7. Update camera clipping planes (near/far)
  8. setLookAt(eye, target, smooth: true)
  ↓
VIEWER STATE: _setActiveModel(model, modelId, ifcModelId)
  ↓
VIEWER EVENTS: emit("modelLoaded", { modelId, model })
  ↓
SUBSCRIBERS:
  - SNAPSHOT COLLECTOR: Auto-capture "modelLoaded" snapshot (if enabled)
  - PANEL: rerender() (update UI state)
  - TREE: mountTree() (build IFC hierarchy)
```

### Navigation Agent Flow

```
RUNNER/PANEL: Trigger navigation
  ↓
NAVIGATION AGENT: navigateToSelection(map, opts)
  ↓
AGENT: getSelectionWorldBox(map) → THREE.Box3
  ↓
AGENT: Compute initial target metrics
  - Project box to screen
  - targetAreaRatio = (box screen area) / (viewport area)
  - occlusionRatio = raycast sampling (optional)
  ↓
┌─────────────────────────────────────┐
│ ITERATION LOOP (max steps, default 20)│
└─────────────────────────────────────┘
  ↓
AGENT: Check stop criteria
  - targetAreaRatio >= minTargetAreaRatio (default 0.10)
  - occlusionRatio <= maxOcclusionRatio (default 0.35)
  - convergence (no improvement for N steps)
    → STOP: { success: true, metrics }
  ↓
AGENT: Compute next camera pose
  - Zoom toward target center (zoomFactor, default 0.85)
  - Orbit yaw (orbitDegrees, default 15°)
  - Elevate if stuck (elevateFactor, default 1.05)
  ↓
AGENT: viewerApi.setCameraPose(newPose, smooth: true)
  ↓
AGENT: Stabilize scene
  - waitForControlsRest()
  - fragments.core.update(true)
  ↓
AGENT: Recompute metrics
  - Project box to screen
  - Update targetAreaRatio
  - Optionally update occlusionRatio (raycast sampling)
  ↓
AGENT: Check convergence
  - Compare metric delta with epsilon
  - Update convergence window counter
  ↓
LOOP back to iteration start
  ↓
MAX STEPS REACHED: { success: false, reason: "max-steps", metrics }
```

---

## Missing Pieces for Phase 1

### ✅ Already Implemented

1. **Real VLM Integration (OpenRouter)**
   - ✅ OpenRouter adapter fully functional
   - ✅ Vision input support
   - ✅ Robust JSON parsing
   - ✅ Timeout protection
   - ✅ Cost control (maxImages cap)
   - ✅ Attribution headers
   - ✅ Deterministic guardrails

2. **Agent Loop**
   - ✅ ComplianceRunner orchestrator
   - ✅ Follow-up execution (27+ action types)
   - ✅ Evidence window management
   - ✅ Escalation logic (repeated follow-ups)
   - ✅ Blank snapshot recovery
   - ✅ Stop criteria (confidence thresholds)

### ❌ Missing Components

#### 1. **Rule Library** (Critical for Phase 1)

**What's Missing:**
- No persistent rule storage
- No rule CRUD operations
- No rule categories/tags
- No rule templates
- No rule sharing/import/export

**What's Needed:**
```typescript
// Rule schema
type ComplianceRule = {
  id: string;
  name: string;
  description: string;
  category: string;            // "accessibility", "fire-safety", "structural", etc.
  tags: string[];              // ["doors", "IBC 2018", "first floor"]
  prompt: string;              // The actual VLM prompt
  allowedSources?: string[];   // Domains for WEB_FETCH
  
  // Metadata
  createdAt: string;
  updatedAt: string;
  author?: string;
  version?: number;
  
  // Testing/validation
  testCases?: {
    modelId: string;
    expectedVerdict: "PASS" | "FAIL";
    notes?: string;
  }[];
};

// Storage
type RuleLibrary = {
  addRule(rule: Omit<ComplianceRule, "id" | "createdAt" | "updatedAt">): Promise<string>;
  getRule(id: string): Promise<ComplianceRule | null>;
  listRules(filters?: { category?: string; tags?: string[] }): Promise<ComplianceRule[]>;
  updateRule(id: string, updates: Partial<ComplianceRule>): Promise<void>;
  deleteRule(id: string): Promise<void>;
  exportRules(ids: string[]): Promise<string>; // JSON export
  importRules(json: string): Promise<string[]>; // Returns new IDs
};
```

**Implementation Approach:**
- IndexedDB store (similar to complianceDb.ts)
- UI panel section for rule management
- Built-in rule templates (IBC 2018 common checks)

#### 2. **Conversation Trace Logging** (Partial Implementation)

**What Exists:**
- ✅ VlmDecision stored in complianceDb
- ✅ SnapshotArtifact stored in snapshotDb
- ✅ Each decision linked to snapshots via `evidence.snapshotIds`

**What's Missing:**
- ❌ Full conversation trace (all snapshots + decisions in order)
- ❌ Follow-up action history
- ❌ Scene state snapshots (what was isolated/hidden at each step)
- ❌ Navigation metrics history
- ❌ Timing/performance metrics

**What's Needed:**
```typescript
type ConversationTrace = {
  runId: string;
  ruleId?: string;              // Link to rule library
  prompt: string;               // User's original prompt
  startedAt: string;
  completedAt?: string;
  
  steps: TraceStep[];
  
  finalDecision?: VlmDecision;
  outcome: "PASS" | "FAIL" | "UNCERTAIN" | "INCOMPLETE";
  totalSteps: number;
  totalDurationMs: number;
};

type TraceStep = {
  stepNumber: number;
  timestampIso: string;
  
  // Scene state before action
  sceneState: {
    cameraPose: CameraPose;
    viewPreset?: "iso" | "top";
    scope?: { storeyId?: string; spaceId?: string };
    isolatedCategories: string[];
    hiddenIds: string[];
    highlightedIds: string[];
    planCut?: { enabled: boolean; height?: number };
  };
  
  // Snapshot captured
  snapshotId: string;
  snapshotMode: SnapshotMode;
  
  // VLM decision
  decision: VlmDecision;
  
  // Action executed (if any)
  followUp?: {
    request: string;
    params?: any;
    executed: boolean;
    didSomething: boolean;
    reason: string;
    durationMs: number;
  };
  
  // Navigation metrics (if nav agent used)
  navMetrics?: {
    targetAreaRatio: number;
    occlusionRatio: number | null;
    steps: number;
  };
};
```

**Implementation Approach:**
- Extend complianceDb with `saveTraceStep`, `getTrace`, `listTraces`
- ComplianceRunner logs each step before and after
- UI panel section for trace viewer (expandable timeline)

#### 3. **HTML Reporting** (Critical for Phase 1)

**What's Missing:**
- No report generation
- No report templates
- No export functionality

**What's Needed:**
```typescript
type ReportConfig = {
  runId: string;
  title?: string;
  includeSnapshots: boolean;         // Embed images as base64
  includeTrace: boolean;             // Show all steps
  includeMetrics: boolean;           // Nav metrics, confidence graphs
  template: "simple" | "detailed" | "academic";
};

type ReportGenerator = {
  generateHtml(config: ReportConfig): Promise<string>;
  downloadReport(config: ReportConfig): Promise<void>;
  previewReport(config: ReportConfig): Promise<void>;
};

// Report structure
type Report = {
  metadata: {
    title: string;
    generatedAt: string;
    runId: string;
    rule?: ComplianceRule;
  };
  
  summary: {
    outcome: "PASS" | "FAIL" | "UNCERTAIN" | "INCOMPLETE";
    finalConfidence: number;
    totalSteps: number;
    totalDurationMs: number;
    snapshotCount: number;
  };
  
  trace?: ConversationTrace;
  
  snapshots: {
    id: string;
    timestampIso: string;
    image: string;              // base64 or blob URL
    cameraPose: CameraPose;
    note?: string;
  }[];
  
  decisions: VlmDecision[];
  
  recommendations?: string[];    // User-facing insights
};
```

**Report Templates:**

**Simple:**
- Rule name + prompt
- Final verdict + confidence
- Key snapshots (first + last)
- Rationale summary

**Detailed:**
- All of Simple +
- Full step-by-step trace
- All snapshots with thumbnails
- Follow-up actions log
- Navigation metrics graphs

**Academic:**
- All of Detailed +
- Methodology explanation
- Model metadata (IFC schema, file size)
- VLM provider details (model, temperature, etc.)
- Reproducibility info (promptHash, timestamps)
- References (code clauses fetched via WEB_FETCH)

**Implementation Approach:**
- `src/reporting/reportGenerator.ts`
- HTML template with embedded CSS (self-contained)
- Image embedding via base64 (no external dependencies)
- Download as .html file (Blob + <a download>)
- Optional: PDF export via browser print (window.print() or html2pdf)

---

## Phase 1 Implementation Plan

### Overview

**Goal:** Extend the app with real VLM integration, rule library, conversation trace logging, and HTML reporting while preserving existing architecture and making minimal changes.

**Estimated Effort:** 12-16 hours

### Implementation Tasks

---

### Task 1: Rule Library (4-5 hours)

#### 1.1 Create Rule Storage (`src/storage/ruleDb.ts`)

**File:** `src/storage/ruleDb.ts` (NEW)

```typescript
// Similar structure to complianceDb.ts
// IndexedDB store: "rules" object store
// Indexes: byCategory, byTag, byCreatedAt
// Methods: addRule, getRule, listRules, updateRule, deleteRule, exportRules, importRules
```

**Key Decisions:**
- Use same DB name (`toc_based_system_db`) but different object store
- Schema: `{ id, name, description, category, tags, prompt, allowedSources, createdAt, updatedAt, author, version, testCases }`
- Export format: JSON array of rules
- Import: Validate schema + merge (skip duplicates by name)

#### 1.2 Create Built-in Rule Templates (`src/modules/ruleTemplates.ts`)

**File:** `src/modules/ruleTemplates.ts` (NEW)

**Content:**
- 5-10 common IBC 2018 accessibility checks
- Examples:
  - Door clear width (IBC 1010.1.1: ≥32" net clear)
  - Stair tread depth (IBC 1011.5.2: ≥11")
  - Handrail height (IBC 1014.4: 34"-38")
  - Accessible route (IBC 1104.3.1: ≥36" width)
  - Landing size (IBC 1010.1.6: ≥44" depth)

```typescript
export const BUILTIN_RULES: Omit<ComplianceRule, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: "Door Clear Width (IBC 2018 1010.1.1)",
    description: "Verify door provides minimum 32 inches clear width",
    category: "accessibility",
    tags: ["doors", "IBC 2018", "clear width"],
    prompt: "Check that doors provide a clear width of not less than 32 inches (813 mm) measured between the face of the door and the stop, with the door open 90 degrees.\n\nAllowedSources:\n- codes.iccsafe.org\n\nReference: IBC 2018 Section 1010.1.1",
    allowedSources: ["codes.iccsafe.org"],
  },
  // ... more rules
];
```

#### 1.3 Update UI Panel - Rule Library Section

**File:** `src/ui/panel.ts` (MODIFY)

**Changes:**
1. Add "Rule Library" tab/section
2. Rule list view (name, category, tags)
3. Rule detail view (name, description, prompt, allowedSources)
4. Add/Edit/Delete buttons
5. Load template button (imports BUILTIN_RULES)
6. Import/Export buttons (JSON file upload/download)
7. "Use this rule" button → fills compliance prompt textarea

**UI Layout:**
```
[Rule Library]
  [+ New Rule] [Import] [Export] [Load Templates]
  
  Search: [________] Filter by category: [All v]
  
  ┌─────────────────────────────────────────────┐
  │ □ Door Clear Width (IBC 2018 1010.1.1)     │
  │   Category: accessibility                   │
  │   Tags: doors, IBC 2018, clear width       │
  │   [Edit] [Delete] [Use]                    │
  ├─────────────────────────────────────────────┤
  │ □ Stair Tread Depth (IBC 2018 1011.5.2)   │
  │   ...                                       │
  └─────────────────────────────────────────────┘
  
  [Details]
  Name: Door Clear Width (IBC 2018 1010.1.1)
  Description: Verify door provides minimum 32 inches clear width
  Category: accessibility
  Tags: doors, IBC 2018, clear width
  AllowedSources: codes.iccsafe.org
  
  Prompt:
  ┌─────────────────────────────────────────────┐
  │ Check that doors provide a clear width of  │
  │ not less than 32 inches (813 mm) measured  │
  │ between the face of the door and the stop, │
  │ with the door open 90 degrees.             │
  │                                             │
  │ AllowedSources:                             │
  │ - codes.iccsafe.org                        │
  │                                             │
  │ Reference: IBC 2018 Section 1010.1.1       │
  └─────────────────────────────────────────────┘
  
  [Use This Rule]
```

#### 1.4 Update Main Entry Point

**File:** `src/main.ts` (MODIFY)

**Changes:**
1. Import `createRuleDb` from `storage/ruleDb.ts`
2. Initialize `ruleDb` after `complianceDb`
3. Pass `ruleDb` to `mountPanel`
4. Expose on window for debugging: `(window as any).ruleDb = ruleDb;`

**Integration Points:**
- ComplianceRunner: Add `ruleId?` field to run metadata
- Panel: When user clicks "Use This Rule", populate prompt + store ruleId

---

### Task 2: Conversation Trace Logging (3-4 hours)

#### 2.1 Extend Compliance DB Schema

**File:** `src/storage/complianceDb.ts` (MODIFY)

**Changes:**
1. Add object store: `"traces"`
   - Key path: `runId`
   - Indexes: `byRuleId`, `byOutcome`, `byStartedAt`
2. Add methods:
   - `saveTraceStep(runId, step)`
   - `getTrace(runId)`
   - `listTraces(filters?)`
   - `updateTraceMetadata(runId, metadata)`

**Schema:**
```typescript
type TraceRow = {
  runId: string;
  ruleId?: string;
  prompt: string;
  startedAt: string;
  completedAt?: string;
  outcome: "PASS" | "FAIL" | "UNCERTAIN" | "INCOMPLETE";
  totalSteps: number;
  totalDurationMs: number;
  steps: TraceStep[];
};
```

#### 2.2 Update Compliance Runner - Trace Logging

**File:** `src/modules/complianceRunner.ts` (MODIFY)

**Changes:**
1. At start: Create trace row
   ```typescript
   await complianceDb.createTrace({
     runId: activeRunId,
     ruleId: params.ruleId, // Pass from panel
     prompt: params.prompt,
     startedAt: new Date().toISOString(),
   });
   ```

2. Inside step loop (before VLM check):
   ```typescript
   const sceneState = {
     cameraPose: await viewerApi.getCameraPose(),
     viewPreset: lastViewPreset,
     scope: lastScope,
     isolatedCategories: lastIsolatedCategories,
     hiddenIds: lastHiddenIds,
     highlightedIds: lastHighlightedIds,
     planCut: viewerApi.getPlanCutState(),
   };
   
   const stepStartTime = performance.now();
   ```

3. After VLM check + follow-up execution:
   ```typescript
   const traceStep: TraceStep = {
     stepNumber: step,
     timestampIso: new Date().toISOString(),
     sceneState,
     snapshotId: artifact.id,
     snapshotMode: artifact.mode,
     decision,
     followUp: acted ? {
       request: f.request,
       params: f.params,
       executed: true,
       didSomething: acted.didSomething,
       reason: acted.reason,
       durationMs: Math.round(performance.now() - stepStartTime),
     } : undefined,
     navMetrics: pendingNav,
   };
   
   await complianceDb.saveTraceStep(activeRunId, traceStep);
   ```

4. At completion (stop criteria met or max steps):
   ```typescript
   await complianceDb.updateTraceMetadata(activeRunId, {
     completedAt: new Date().toISOString(),
     outcome: decision.verdict,
     totalSteps: step,
     totalDurationMs: Math.round(performance.now() - runStartTime),
   });
   ```

**Integration Points:**
- Panel: Pass `ruleId` to `complianceRunner.start({ prompt, ruleId, ... })`
- Snapshot collector: Already persists artifacts; no changes needed

---

### Task 3: HTML Reporting (5-7 hours)

#### 3.1 Create Report Generator Module

**File:** `src/reporting/reportGenerator.ts` (NEW)

```typescript
import type { ConversationTrace, ComplianceRule } from "../types";

export type ReportConfig = {
  runId: string;
  title?: string;
  includeSnapshots: boolean;
  includeTrace: boolean;
  includeMetrics: boolean;
  template: "simple" | "detailed" | "academic";
};

export async function generateHtml(config: ReportConfig): Promise<string> {
  // 1. Fetch trace from complianceDb
  // 2. Fetch rule from ruleDb (if ruleId exists)
  // 3. Fetch snapshots from snapshotDb
  // 4. Build report data structure
  // 5. Render HTML from template
  // 6. Return HTML string
}

export async function downloadReport(config: ReportConfig): Promise<void> {
  const html = await generateHtml(config);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `compliance-report-${config.runId}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function previewReport(config: ReportConfig): Promise<void> {
  const html = await generateHtml(config);
  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}
```

#### 3.2 Create HTML Templates

**File:** `src/reporting/templates/simpleTemplate.ts` (NEW)

```typescript
export function renderSimpleReport(data: {
  metadata: { title: string; generatedAt: string; runId: string };
  summary: { outcome: string; finalConfidence: number; totalSteps: number };
  snapshots: { id: string; image: string; note?: string }[];
  finalDecision: VlmDecision;
  rule?: ComplianceRule;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.metadata.title}</title>
  <style>
    /* Embedded CSS - modern, clean, print-friendly */
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; color: #333; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
    h2 { color: #2c3e50; margin-top: 30px; }
    .verdict { font-size: 24px; font-weight: bold; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .PASS { background: #d4edda; color: #155724; }
    .FAIL { background: #f8d7da; color: #721c24; }
    .UNCERTAIN { background: #fff3cd; color: #856404; }
    .snapshot { margin: 20px 0; }
    .snapshot img { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
    .meta { background: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #ddd; }
    th { background: #f1f3f5; font-weight: 600; }
    @media print { body { margin: 20px; } }
  </style>
</head>
<body>
  <h1>${data.metadata.title}</h1>
  
  <div class="meta">
    <strong>Report ID:</strong> ${data.metadata.runId}<br>
    <strong>Generated:</strong> ${new Date(data.metadata.generatedAt).toLocaleString()}<br>
    ${data.rule ? `<strong>Rule:</strong> ${data.rule.name}<br>` : ""}
  </div>
  
  <div class="verdict ${data.summary.outcome}">
    Verdict: ${data.summary.outcome} (Confidence: ${(data.summary.finalConfidence * 100).toFixed(0)}%)
  </div>
  
  <h2>Summary</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Steps</td><td>${data.summary.totalSteps}</td></tr>
    <tr><td>Snapshots Captured</td><td>${data.snapshots.length}</td></tr>
  </table>
  
  <h2>Rationale</h2>
  <p>${data.finalDecision.rationale}</p>
  
  <h2>Key Snapshots</h2>
  ${data.snapshots.map((s, i) => `
    <div class="snapshot">
      <h3>Snapshot ${i + 1} ${s.note ? `- ${s.note}` : ""}</h3>
      <img src="${s.image}" alt="Snapshot ${i + 1}">
    </div>
  `).join("")}
  
  <hr>
  <p style="text-align: center; color: #888; font-size: 12px;">
    Generated by TOC-Based BIM Compliance Checker
  </p>
</body>
</html>
  `.trim();
}
```

**File:** `src/reporting/templates/detailedTemplate.ts` (NEW)

```typescript
// Similar to simpleTemplate but includes:
// - Full step-by-step trace (expandable sections)
// - All snapshots with thumbnails (click to enlarge)
// - Follow-up actions log (table)
// - Navigation metrics (if available)
// - Confidence graph (SVG or CSS bars)
```

**File:** `src/reporting/templates/academicTemplate.ts` (NEW)

```typescript
// Similar to detailedTemplate but includes:
// - Methodology section
// - Model metadata (IFC schema, file size, loaded entities)
// - VLM provider details (model, temperature, max_tokens)
// - Reproducibility info (promptHash, timestamps, versions)
// - References (code clauses fetched via WEB_FETCH)
// - Appendix: JSON export of full trace
```

#### 3.3 Update UI Panel - Reporting Section

**File:** `src/ui/panel.ts` (MODIFY)

**Changes:**
1. Add "Reports" tab/section
2. List completed runs (fetch from complianceDb)
3. Report configuration form:
   - Template selector (Simple / Detailed / Academic)
   - Include snapshots checkbox
   - Include trace checkbox
   - Include metrics checkbox
   - Custom title input (optional)
4. Preview button (opens in new tab)
5. Download button (.html file)
6. Optional: Print button (window.print())

**UI Layout:**
```
[Reports]
  Completed Runs:
  ┌─────────────────────────────────────────────┐
  │ Run ID: 123e4567-e89b-12d3-a456-426614174000│
  │ Rule: Door Clear Width (IBC 2018 1010.1.1) │
  │ Outcome: PASS (85% confidence)              │
  │ Steps: 4 | Duration: 12.3s                  │
  │ Completed: 2026-03-15 14:23:45             │
  │ [Generate Report]                           │
  ├─────────────────────────────────────────────┤
  │ ...                                         │
  └─────────────────────────────────────────────┘
  
  [Report Configuration]
  Template: [Detailed v]
  □ Include snapshots
  □ Include full trace
  □ Include metrics
  Custom title: [___________________________]
  
  [Preview] [Download HTML]
```

#### 3.4 Update Main Entry Point

**File:** `src/main.ts` (MODIFY)

**Changes:**
1. Import report generator functions
2. Expose on window for debugging: `(window as any).reportGenerator = { generateHtml, downloadReport, previewReport };`
3. Pass report generator to panel (or keep as global import in panel.ts)

---

### File Modification Summary

#### NEW Files (8 files)
1. `src/storage/ruleDb.ts`
2. `src/modules/ruleTemplates.ts`
3. `src/reporting/reportGenerator.ts`
4. `src/reporting/templates/simpleTemplate.ts`
5. `src/reporting/templates/detailedTemplate.ts`
6. `src/reporting/templates/academicTemplate.ts`
7. `src/types.ts` (optional - centralize type definitions)

#### MODIFIED Files (3 files)
1. `src/main.ts`
   - Initialize ruleDb
   - Expose reportGenerator
   - Pass ruleDb to panel

2. `src/ui/panel.ts`
   - Add Rule Library section
   - Add Reports section
   - Pass ruleId to complianceRunner

3. `src/modules/complianceRunner.ts`
   - Accept `ruleId` in start params
   - Log trace steps
   - Update trace metadata on completion

4. `src/storage/complianceDb.ts`
   - Add `traces` object store
   - Add trace methods (saveTraceStep, getTrace, listTraces, updateTraceMetadata)

---

### Implementation Order

**Phase 1A: Rule Library (2-3 days)**
1. Day 1 AM: Create `ruleDb.ts` + schema + basic CRUD
2. Day 1 PM: Create `ruleTemplates.ts` with 5-10 built-in rules
3. Day 2 AM: Update `panel.ts` - Rule Library UI
4. Day 2 PM: Integration testing + import/export

**Phase 1B: Trace Logging (1-2 days)**
1. Day 3 AM: Extend `complianceDb.ts` schema + methods
2. Day 3 PM: Update `complianceRunner.ts` logging
3. Day 4 AM: Integration testing + validation

**Phase 1C: HTML Reporting (2-3 days)**
1. Day 4 PM: Create `reportGenerator.ts` + data fetching logic
2. Day 5 AM: Create `simpleTemplate.ts`
3. Day 5 PM: Create `detailedTemplate.ts`
4. Day 6 AM: Create `academicTemplate.ts` (optional for later)
5. Day 6 PM: Update `panel.ts` - Reports UI
6. Day 7: Integration testing + polish

**Testing & Polish (1 day)**
- End-to-end test: Load model → Select rule → Run check → Generate report
- Edge cases: Empty library, failed runs, missing snapshots
- UI polish: Loading states, error messages, tooltips
- Documentation: Update README with Phase 1 features

---

### Integration Points with Existing Code

#### 1. Rule Library ↔ Compliance Runner
```typescript
// panel.ts
const selectedRule = await ruleDb.getRule(selectedRuleId);
complianceRunner.start({
  prompt: selectedRule.prompt,
  ruleId: selectedRule.id,
  deterministic: { enabled: true, mode: "iso" },
});
```

#### 2. Trace Logging ↔ Decision Storage
```typescript
// complianceRunner.ts
const decision = await vlmChecker.check({ prompt, artifacts, evidenceViews });
await complianceDb.saveDecision(runId, decision); // Existing
await complianceDb.saveTraceStep(runId, traceStep); // New
```

#### 3. Reporting ↔ Storage Layers
```typescript
// reportGenerator.ts
const trace = await complianceDb.getTrace(runId);
const rule = trace.ruleId ? await ruleDb.getRule(trace.ruleId) : null;
const snapshots = await Promise.all(
  trace.steps.map(s => snapshotDb.loadArtifact(s.snapshotId))
);
```

---

### Backwards Compatibility

**All changes are additive:**
- ✅ Existing compliance checks still work without rule library
- ✅ Decisions still stored even without trace logging
- ✅ App still functions without reporting (report generation is opt-in)
- ✅ No breaking changes to existing APIs

**Migration path:**
- Users can continue using manual prompts (no rule library required)
- Trace logging activates automatically on next run
- Reports can be generated retroactively for runs with trace data

---

### Performance Considerations

#### 1. Rule Library
- **Storage:** ~1-5 KB per rule → 100 rules ≈ 500 KB (negligible)
- **Lookup:** Indexed queries (byCategory, byTag) → O(log n) + network latency ~10ms

#### 2. Trace Logging
- **Storage:** ~2-10 KB per step → 10 steps ≈ 100 KB per run
- **Write:** Async writes (fire-and-forget) → no blocking
- **Caveat:** Large base64 images in snapshots already dominate storage (1-5 MB per snapshot)

#### 3. HTML Reporting
- **Generation:** ~50-200ms for detailed report (DOM parsing + template rendering)
- **File size:** 
  - Simple (2 snapshots, no trace): ~500 KB - 2 MB
  - Detailed (10 snapshots, full trace): ~5 MB - 20 MB
  - Academic (all data + JSON export): ~10 MB - 50 MB
- **Mitigation:** Thumbnail generation (resize images to 800px max width)

---

### Error Handling Strategy

#### 1. Rule Library
- **Invalid import JSON:** Validate schema, skip malformed entries, show error toast
- **Duplicate rule names:** Auto-increment name (e.g., "Door Width (2)")
- **Missing rule on load:** Show placeholder, allow user to unlink

#### 2. Trace Logging
- **DB write fails:** Log to console, continue (non-blocking)
- **Missing trace data:** Report shows warning, uses available data

#### 3. HTML Reporting
- **Missing snapshots:** Show placeholder image, note in report
- **Missing rule:** Show rule ID only, no details
- **Template render error:** Fallback to simple template, show error toast

---

### User Experience Flow

#### End-to-End Scenario: Door Width Check

1. **User loads IFC model**
   - Upload .ifc file
   - Viewer displays model
   - Tree view shows hierarchy

2. **User selects rule from library**
   - Opens "Rule Library" tab
   - Filters by category: "accessibility"
   - Clicks "Door Clear Width (IBC 2018 1010.1.1)"
   - Reviews rule details
   - Clicks "Use This Rule"
   - Prompt auto-fills in Compliance tab

3. **User configures run**
   - Deterministic start: ISO view (checked)
   - Max steps: 6
   - Clicks "Start Compliance"

4. **Agent runs (automatic)**
   - Step 1: ISO view, capture snapshot, VLM decides "UNCERTAIN" (doors not visible)
     - Follow-up: ISOLATE_STOREY ("First floor")
   - Step 2: Isolate first floor, capture, VLM decides "UNCERTAIN" (need top view)
     - Follow-up: TOP_VIEW
   - Step 3: Top view, capture, VLM decides "UNCERTAIN" (walls blocking)
     - Follow-up: SET_PLAN_CUT (height: 1.2m)
   - Step 4: Plan cut applied, capture, VLM decides "UNCERTAIN" (need doors isolated)
     - Follow-up: ISOLATE_CATEGORY ("IfcDoor")
   - Step 5: Doors isolated, capture, VLM decides "PASS" (confidence: 0.87)
     - No follow-up (confidence >= 0.75)
   - **Stop: PASS (87% confidence)**

5. **User reviews decision**
   - Toast: "Compliance result: PASS (87%)"
   - Panel shows final verdict
   - User can view snapshot history in Snapshot tab

6. **User generates report**
   - Opens "Reports" tab
   - Selects completed run
   - Configures report:
     - Template: Detailed
     - Include snapshots: Yes
     - Include trace: Yes
     - Include metrics: Yes
     - Title: "Door Clear Width - Building A - First Floor"
   - Clicks "Preview" → Opens in new tab
   - Reviews report
   - Clicks "Download HTML"
   - Saves file: `compliance-report-123e4567.html`

7. **User shares report**
   - Emails .html file to supervisor
   - Supervisor opens in browser (no dependencies)
   - Supervisor reviews step-by-step trace + snapshots
   - Approves compliance check

---

### Testing Strategy

#### Unit Tests (Optional - not in scope for PoC)
- Rule DB CRUD operations
- Trace step logging
- Report template rendering

#### Integration Tests
1. **Rule Library**
   - Add rule → Verify in DB → List rules → Verify in UI
   - Edit rule → Verify updates → Use rule → Verify prompt filled
   - Delete rule → Verify removed from DB + UI
   - Import JSON → Verify rules added
   - Export JSON → Verify valid format

2. **Trace Logging**
   - Start run → Verify trace created
   - Complete run → Verify trace updated
   - List traces → Verify in UI

3. **HTML Reporting**
   - Generate simple report → Verify HTML valid + images embedded
   - Generate detailed report → Verify trace included
   - Download report → Verify file downloaded
   - Preview report → Verify opens in new tab

#### End-to-End Tests
1. Load model → Select rule → Run check → Verify trace logged
2. Load model → Select rule → Run check → Generate report → Verify report accurate
3. Import rules → Select rule → Run check → Generate report → Verify full workflow

---

### Future Enhancements (Post-Phase 1)

#### Phase 2: Advanced Features
1. **Batch Checking**
   - Run multiple rules on one model
   - Generate combined report

2. **Rule Validation**
   - Test cases (expected verdict for specific models)
   - Automated regression testing

3. **Collaboration**
   - Share rules via URL (Base64 encoded JSON)
   - Community rule marketplace

4. **Analytics**
   - Aggregate statistics (pass/fail rates)
   - Performance metrics (avg steps per rule)

5. **Export Formats**
   - PDF export (via html2pdf.js)
   - JSON export (machine-readable)
   - CSV export (for Excel)

6. **Advanced Reporting**
   - Confidence graphs (line charts)
   - Navigation metrics visualization (heatmaps)
   - Comparative reports (multiple runs)

---

## Conclusion

This BIM compliance checker is a **well-architected, modular system** with a clean separation of concerns:

- ✅ **Viewer layer** (ThatOpen Components + Three.js) handles 3D rendering and model interaction
- ✅ **Module layer** (VLM checker, navigation agent, snapshot collector) handles business logic
- ✅ **Storage layer** (IndexedDB) handles persistence
- ✅ **UI layer** (BUI components) handles user interaction

**Phase 1 additions are minimal and non-invasive:**
- Rule library: New storage + UI section
- Trace logging: Extend existing storage + runner logging
- HTML reporting: New module + UI section

**The architecture is extensible** for future phases (batch checking, collaboration, analytics) without major refactoring.

**Total estimated effort:** 12-16 hours spread over 7 days

**Risk assessment:** Low - all changes are additive, no breaking changes, backwards compatible

---

**End of Analysis**

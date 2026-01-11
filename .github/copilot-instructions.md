# Copilot Instructions for TOC-based System

## Project Overview
This is a modular BIM (Building Information Modeling) viewer built on **@thatopen/components** (OBC), **Three.js**, and **Vite**. The system loads IFC files, classifies elements (by level, category, space), and provides interactive visualization with UI overlays.

**Tech Stack:** TypeScript + Vite, @thatopen/components v3.2.6, three.js, web-ifc

---

## Architecture

### Core Modules

**`src/main.ts`** (Entry Point)
- Initializes viewer, API, UI components in dependency order
- Creates four overlay containers: viewer, tree (top-left), panel (top-right), toast (bottom-left)
- Boots: viewer → viewerApi → UI components

**`src/viewer/`** (Viewer Layer)
- `initViewer.ts`: Sets up OBC Components, World, Scene, Camera, Renderer; configures IFC loader; handles model lifecycle
- `api.ts`: Stateless facade exposing camera poses, isolation, snapshots, element properties via ModelIdMap
- `state.ts`: Singleton state for active model/modelId (internal setter pattern with leading underscore)
- `events.ts`: Event bus for model lifecycle (modelLoaded, etc.)
- `ifc/classification.ts`: Rebuilds classifications (Levels, Categories, Spaces); Space-to-Level map utilities

**`src/ui/`** (UI Layer)
- `tree.ts`: Renders hierarchical model tree; renders categories with isolation on click; Reset button
- `panel.ts`, `toast.ts`: UI components (currently minimal/empty)
- `dom.ts`: Empty utility module (reserved for future DOM helpers)

**`src/utils/`** (Shared Utilities)
- `modelIdMap.ts`: Generic utilities for OBC's ModelIdMap structure (count, flatten, intersect)
- `geometry.ts`: Spatial utilities (getCenterY, getUnionBox)

### Data Flows

1. **Model Loading:** `initViewer` → onItemSet listener → emit modelLoaded → rebuild classifications
2. **Visibility Control:** UI clicks `viewerApi.isolate(map)` → hider.set() / hider.isolate()
3. **Classification:** classifier.byIfcBuildingStorey/byCategory → classifier.list provides Map<groupName, groupData>
4. **Camera:** getCameraPose/setCameraPose use THREE.Vector3; setLookAt for smooth transition

---

## Key Patterns & Conventions

### ModelIdMap
```typescript
type ModelIdMap = { [modelId: string]: Set<number> } // modelId → element local IDs
```
Used throughout for element selection/visibility. Utilities in `src/utils/modelIdMap.ts`:
- `countItems(map)`: Total element count
- `flattenLocalIds(map, modelId)`: Single model's IDs as array
- `intersect(a, b)`: Set intersection for filtering

### Classification Strategy
- **Levels:** `classifier.byIfcBuildingStorey()` groups by IfcBuildingStorey
- **Categories:** `classifier.byCategory()` splits by element type (IfcWall, IfcSpace, etc.)
- **Spaces:** Extract IfcSpace from Categories, then split into per-space groups via `rebuildClassifications`
- **Critical:** `classifier.list.clear()` before rebuild prevents duplicates but removes custom groups

### Visibility (Hider)
- `hider.set(true)`: Make everything visible
- `hider.isolate(map)`: Hide all except map elements
- Always called via `viewerApi` for consistency

### Pose/Camera
- Pose = `{ eye: {x,y,z}, target: {x,y,z} }`
- Use `world.camera.controls.setLookAt(...)` with fallback for older controls (see api.ts)
- Camera update triggered on "rest" event: `fragments.core.update(true)`

### State Management
- Active model tracked in `state.ts` via `getActiveModel()`, `_setActiveModel()` (internal)
- Single model at a time; alternative architectures could store Map<modelId, model> for multi-model

---

## Developer Workflows

### Build & Run
```bash
npm run dev      # Vite dev server at localhost:5173
npm run build    # TypeScript compile + Vite bundle
npm run preview  # Preview built output
```

### External Resources
- **WASM:** web-ifc WASM loaded from `https://unpkg.com/web-ifc@0.0.72/` (configured in initViewer)
- **Worker:** `/thatopen/worker.mjs` (public/) needed for FragmentsManager async processing

### Configuration
- **tsconfig.json:** ES modules, target ES2020
- **Vite config:** Implicit (default Vite + TypeScript)

---

## Important Notes for AI Agents

1. **Avoid Duplicate Classifications:** `classifier.list.clear()` is destructive; if extending with custom groups, consider selective clearing
2. **IFC Space Lookup:** Multiple possible keys (IfcSpace, IFCSPACE, Space); fallback search on substring match in classification.ts
3. **Type Safety:** Many OBC types use generics (`World<Scene, Camera, Renderer>`); cast as needed but validate at runtime
4. **UI Overlay Architecture:** All UI mounts to separate overlay divs (not nested); coordinate positioning in styles.css
5. **ModelIdMap Immutability:** Create new Maps/Sets for isolation logic; avoid mutation of existing classifier data
6. **Error Handling:** IFC loading, WASM fetch, classification rebuilds can fail silently; add logging/fallback handling
7. **Cross-Module Refs:** `tree.ts` depends on viewerApi, ctx, toast; keep API facade stable to minimize coupling

---

## File References for Common Tasks

- **Add UI element:** `src/ui/{component}.ts` + register in `main.ts` + style in `src/styles.css`
- **Extend classifier:** `src/viewer/ifc/classification.ts` (rebuildClassifications)
- **Add viewer command:** `src/viewer/api.ts` (createViewerApi) + emit event in `events.ts`
- **Model utilities:** `src/utils/modelIdMap.ts` (reusable across ui/viewer)
- **Camera control:** `src/viewer/api.ts` (getCameraPose/setCameraPose)

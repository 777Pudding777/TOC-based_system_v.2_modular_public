// src/viewer/api.ts
// viewer API: onModelLoaded, get/setCameraPose, isolate, getSnapshot, getElementProperties

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { getActiveModel, getActiveModelId } from "./state";
import { getActiveIfcModelId } from "./state";
import { getActiveIfcTypeIndex } from "./state";
import { viewerEvents } from "./events";
import type { ViewerContext } from "./initViewer";

export type VisibilityState = {
  mode: "all" | "isolate";
  lastIsolateCount?: number;
};


export type CameraPose = {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
};

export type ViewerSnapshot = {
  imageBase64Png: string;
  pose: CameraPose;
  meta: { timestampIso: string; modelId: string | null; note?: string };
};

/**
 * Deterministic camera presets.
 * - "iso": good general-purpose overview (shows vertical + horizontal structure)
 * - "top": plan-like view (good for layout, but can hide interiors)
 */
export type StartPosePreset = "iso" | "top";

export function createViewerApi(ctx: ViewerContext) {
  const { world, fragments, hider } = ctx;


// Depending on OBC version, components live in ctx.components or fragments.components

function getComponentsAny(): any {
  // Depending on OBC version, components live in ctx.components or fragments.components
  return (ctx as any).components ?? (fragments as any).components ?? null;
}

function findClassifier(components: any): any | null {
  if (!components) return null;

  // common patterns: components.get(ClassName) or components.tools[...]
  // We probe deterministically by checking known keys and known method shapes.
  const candidates: any[] = [];

  // A) components.get("IfcClassifier") style
  if (typeof components.get === "function") {
    for (const key of ["IfcClassifier", "Classifier", "FragmentClassifier"]) {
      try {
        const c = components.get(key);
        if (c) candidates.push(c);
      } catch {}
    }
  }

  // B) components.tools map
  const tools = (components as any).tools;
  if (tools && typeof tools === "object") {
    for (const key of ["IfcClassifier", "Classifier", "FragmentClassifier"]) {
      const c = tools[key];
      if (c) candidates.push(c);
    }
  }

  // C) brute: scan enumerable values once (still deterministic order by sorted keys)
  const keys = Object.keys(components).sort();
  for (const k of keys) {
    const v = (components as any)[k];
    if (!v) continue;
    // identify by method signature
    if (typeof v.getMap === "function" || typeof v.getAll === "function" || typeof v.find === "function") {
      candidates.push(v);
    }
  }

  // pick first that looks like classifier by having category→map method
  for (const c of candidates) {
    if (typeof c.getMap === "function") return c;
    if (typeof c.getModelIdMap === "function") return c;
    if (typeof c.find === "function") return c;
  }
  return null;
}

function logPlaneTest(plane: THREE.Plane, abs: number, upAxis: "y" | "z") {
  const above = upAxis === "y"
    ? new THREE.Vector3(0, abs + 0.5, 0)
    : new THREE.Vector3(0, 0, abs + 0.5);

  const below = upAxis === "y"
    ? new THREE.Vector3(0, abs - 0.5, 0)
    : new THREE.Vector3(0, 0, abs - 0.5);

  const da = plane.distanceToPoint(above);
  const db = plane.distanceToPoint(below);

  console.log("[PlanCut:PlaneTest]", { abs, daAbove: da, dbBelow: db });
}

function calibratePlaneKeepBelow(plane: THREE.Plane, absHeight: number, upAxis: "y" | "z") {
  // We want: keep BELOW the cut (below = visible), clip ABOVE.
  const above = upAxis === "y"
    ? new THREE.Vector3(0, absHeight + 0.5, 0)
    : new THREE.Vector3(0, 0, absHeight + 0.5);

  const below = upAxis === "y"
    ? new THREE.Vector3(0, absHeight - 0.5, 0)
    : new THREE.Vector3(0, 0, absHeight - 0.5);

  const dAbove = plane.distanceToPoint(above);
  const dBelow = plane.distanceToPoint(below);

  // Empirical rule for Three clipping:
  // If your result is inverted, negate() flips it.
  // We expect: above should be "more clipped side" than below.
  // So if dAbove < dBelow, the plane is likely inverted for your pipeline → flip.
  if (dAbove < dBelow) {
    plane.negate();
    return { flipped: true, dAbove, dBelow };
  }
  return { flipped: false, dAbove, dBelow };
}

// Get active group in fragments.list for active model (any version)
function getActiveGroupAny(): any | null {
  const modelKey = getActiveModelId();
  if (!modelKey) return null;
  const listAny: any = (fragments as any).list;
  return typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey] ?? null;
}

  // Keep a copy of the last isolate map (so navigation can "go to what is currently isolated")
  let lastIsolateMap: OBC.ModelIdMap | null = null;
  // Track hidden items so we can report evidence metadata to the VLM deterministically.
  // Keys are modelIds; values are sets of localIds.
  const hiddenMapByModel: Record<string, Set<number>> = {};

  function ensureHiddenSet(modelId: string) {
    hiddenMapByModel[modelId] ??= new Set<number>();
    return hiddenMapByModel[modelId];
  }

  // Accepts:
  // - "123" (localId on active model)
  // - "modelId:123"
  // Returns null if it can't be parsed.
  function parseObjectId(id: string): { modelId: string; localId: number } | null {
    const raw = String(id ?? "").trim();
    if (!raw) return null;

    const activeModelId = getActiveModelId();
    if (!activeModelId) return null;

    // modelId:localId
    if (raw.includes(":")) {
      const [m, l] = raw.split(":");
      const localId = Number(l);
      if (!m || !Number.isFinite(localId)) return null;
      return { modelId: m, localId };
    }

    // localId only -> assume active model
    const localId = Number(raw);
    if (!Number.isFinite(localId)) return null;
    return { modelId: activeModelId, localId };
  }

  // ----------------------------
  // Highlight / selection state
  // ----------------------------
  let lastPickedObjectId: string | null = null;

  // Store original materials so we can restore them after highlighting.
  // Keyed by mesh uuid (stable enough for session).
  const originalMaterialByMeshUuid = new Map<string, THREE.Material | THREE.Material[]>();

  // Single shared highlight materials (deterministic)
  const highlightPrimaryMat = new THREE.MeshBasicMaterial({
    color: 0xffd54a,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
  });

  const highlightWarnMat = new THREE.MeshBasicMaterial({
    color: 0xff4a4a,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
  });

  function pickHighlightMaterial(style?: "primary" | "warn") {
    return style === "warn" ? highlightWarnMat : highlightPrimaryMat;
  }

  function restoreAllHighlights() {
    for (const [uuid, mat] of originalMaterialByMeshUuid.entries()) {
      const obj = world.scene.three.getObjectByProperty("uuid", uuid) as any;
      if (obj && obj.material) obj.material = mat;
    }
    originalMaterialByMeshUuid.clear();
  }

  function buildModelIdMapFromObjectIds(objectIds: string[]): OBC.ModelIdMap {
    const map: OBC.ModelIdMap = {};
    for (const raw of objectIds ?? []) {
      const parsed = parseObjectId(raw);
      if (!parsed) continue;
      (map[parsed.modelId] ??= new Set<number>()).add(parsed.localId);
    }
    return map;
  }

  // Try hard to extract a localId from a raycast hit.
  // Works across OBC/fragments versions by probing common shapes.
  function extractLocalIdFromIntersection(hit: THREE.Intersection): number | null {
    const obj: any = hit.object as any;

    // A) Common userData patterns
    const ud = obj?.userData;
    for (const k of ["expressID", "expressId", "localId", "itemID", "itemId"]) {
      const v = ud?.[k];
      if (typeof v === "number" && isFinite(v)) return v;
    }

    // B) Geometry attribute per-vertex (expressID / itemID)
    const geom: any = obj?.geometry;
    const attrs = geom?.attributes;
    const attr =
      attrs?.expressID ??
      attrs?.expressId ??
      attrs?.itemID ??
      attrs?.itemId ??
      null;

    // Need indices + faceIndex to map triangle -> vertices
    if (!attr || !hit.faceIndex || !geom?.index) return null;

    const index = geom.index;
    const tri = hit.faceIndex;

    const a = index.getX(tri * 3 + 0);
    const b = index.getX(tri * 3 + 1);
    const c = index.getX(tri * 3 + 2);

    const va = attr.getX(a);
    const vb = attr.getX(b);
    const vc = attr.getX(c);

    // Pick majority value (robust)
    const arr = [va, vb, vc].filter((n) => typeof n === "number" && isFinite(n));
    if (!arr.length) return null;

    arr.sort((x, y) => x - y);
    // majority of 3: middle is majority if there is one
    const mid = arr[Math.floor(arr.length / 2)];
    return typeof mid === "number" && isFinite(mid) ? mid : null;
  }

  function toObjectId(modelId: string, localId: number) {
    return `${modelId}:${localId}`;
  }

  function cloneModelIdMap(map: OBC.ModelIdMap): OBC.ModelIdMap {
    const out: OBC.ModelIdMap = {};
    for (const [mid, set] of Object.entries(map)) out[mid] = new Set(set);
    return out;
  }

  // Normalize user-provided category string to IFC standard form
function normalizeIfcCategory(raw: string): string {
  const upper = String(raw ?? "").trim().toUpperCase();
  const synonymToIfc: Record<string, string> = {
    DOOR: "IFCDOOR",
    DOORS: "IFCDOOR",
    SLAB: "IFCSLAB",
    SLABS: "IFCSLAB",
    STAIR: "IFCSTAIR",
    STAIRS: "IFCSTAIR",
    CEILING: "IFCCOVERING",
    CEILINGS: "IFCCOVERING",
    ROOF: "IFCROOF",
    ROOFS: "IFCROOF",
    WINDOW: "IFCWINDOW",
    WINDOWS: "IFCWINDOW",
    WALL: "IFCWALL",
    WALLS: "IFCWALL",
  };
  if (!upper) return upper;
  if (upper.startsWith("IFC")) return upper;
  return synonymToIfc[upper] ?? upper;
}

// Plan cut state
let planCutState:
  | { enabled: false }
  | { enabled: true; planes: THREE.Plane[] } = { enabled: false };

type SavedMatState = {
  side: number;
  clippingPlanes?: THREE.Plane[] | null;
  clipIntersection?: boolean;
  clipping?: boolean;
};

let savedMaterialState: Map<string, SavedMatState> | null = null;

function forEachMaterial(obj: THREE.Object3D, fn: (m: THREE.Material) => void) {
  obj.traverse((child: any) => {
    const mat = child?.material;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach(fn);
    else fn(mat);
  });
}

function applyClippingPlanes(planes: THREE.Plane[]) {
  const model = getActiveModel();
  if (!model?.object) return;

  // ✅ enable clipping
  world.renderer.three.localClippingEnabled = true;

  // ✅ ALSO set global clipping planes (important for fragments/instancing edge cases)
  world.renderer.three.clippingPlanes = planes;

  // Save material state once when enabling plan cut
  if (!savedMaterialState) savedMaterialState = new Map();

  forEachMaterial(model.object, (m) => {
    const key = (m as any).uuid as string;
    if (!savedMaterialState!.has(key)) {
      savedMaterialState!.set(key, {
        side: (m as any).side,
        clippingPlanes: (m as any).clippingPlanes ?? null,
        clipIntersection: (m as any).clipIntersection,
      });
    }

    (m as any).side = THREE.DoubleSide;
    (m as any).clippingPlanes = planes;
    (m as any).clipIntersection = planes.length > 1;
    m.needsUpdate = true;
  });
}

function clearClippingPlanes() {
  const model = getActiveModel();
  if (!model?.object) return;

  // ✅ clear global clipping planes
  world.renderer.three.clippingPlanes = [];

  if (savedMaterialState) {
    forEachMaterial(model.object, (m) => {
      const key = (m as any).uuid as string;
      const prev = savedMaterialState!.get(key);
      if (!prev) return;

      (m as any).side = prev.side;
      (m as any).clippingPlanes = prev.clippingPlanes ?? null;
      (m as any).clipIntersection = prev.clipIntersection;
      m.needsUpdate = true;
    });

    savedMaterialState = null;
  }
}



function getUpAxis(): "y" | "z" {
  const up = world.camera.three.up;
  // tolerate small float drift
  if (Math.abs(up.z) > Math.abs(up.y)) return "z";
  return "y";
}

/**
 * Wait for camera controls to finish moving.  
 */
function waitForControlsRest(timeoutMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    const controls: any = world.camera.controls;

    // If controls expose a "rest" event, use it (you already do elsewhere).
    let done = false;
    const onRest = () => {
      if (done) return;
      done = true;
      controls.removeEventListener?.("rest", onRest);
      resolve();
    };

    controls.addEventListener?.("rest", onRest);

    // Fallback timeout (never hang snapshots)
    window.setTimeout(() => onRest(), timeoutMs);
  });
}

/**
 * Stabilize the scene for snapshot capture: 
 * - wait for camera to stop moving
 */

async function waitFrames(n = 2) {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
}

async function stabilizeSceneForSnapshot() {
  // 1) wait until camera stops (or timeout)
  await waitForControlsRest(1200);

  // 2) update fragments for the current camera
  fragments.core.update(true);

  // 3) give worker/main thread time to apply changes
  await waitFrames(3);

  // 4) update again (often fixes "half updated" frames)
  fragments.core.update(true);
  await waitFrames(2);

  // 5) force a render right before readback
  world.renderer.three.render(world.scene.three, world.camera.three);
}

  let visibilityState = {
    mode: "all" as const,
    lastIsolateCount: undefined as number | undefined,
  };

  function countItems(map: OBC.ModelIdMap): number {
    let total = 0;
    for (const ids of Object.values(map)) total += ids.size;
    return total;
  }

  /**
   * Compute model bounds as a bounding sphere.
   *
   * Critical assessment:
   * - Bounding sphere is a robust, exporter-agnostic way to place cameras.
   * - It works even if the model is not aligned to world axes.
   * - If model is missing/empty, return null (caller decides what to do).
   */
  function getModelBoundsSphere(): { center: THREE.Vector3; radius: number } | null {
    const model = getActiveModel();
    if (!model) return null;

    const obj = model.object;
    if (!obj) return null;

    const box = new THREE.Box3().setFromObject(obj);

    // If box is empty, we can't compute a meaningful camera pose
    if (box.isEmpty()) return null;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center.clone(), radius: sphere.radius };
  }

  let lastSelection: OBC.ModelIdMap | null = null;

  /**
   * Create a deterministic pose from a preset ("iso" or "top").
   *
   * Critical assessment:
   * - We derive distance from model radius => consistent framing across different model scales.
   * - "iso" direction uses a slightly elevated diagonal, good default for overview.
   * - "top" targets the center from above; works best when roofs/slabs aren't blocking.
   */
  function getPresetPose(preset: StartPosePreset): CameraPose | null {
    const s = getModelBoundsSphere();
    if (!s) return null;

    const { center, radius } = s;

    // Keep a minimum distance so small models are still visible
    const dist = Math.max(radius * 2.2, 5);

    if (preset === "iso") {
      // Slightly above horizon so vertical structure is visible
      const dir = new THREE.Vector3(1, 0.8, 1).normalize();
      const eye = center.clone().add(dir.multiplyScalar(dist));

      return {
        eye: { x: eye.x, y: eye.y, z: eye.z },
        target: { x: center.x, y: center.y, z: center.z },
      };
    }

    // "top"
    const eye = center.clone().add(new THREE.Vector3(0, dist, 0));
    return {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      target: { x: center.x, y: center.y, z: center.z },
    };
  }

  // Helpers for IFC type ID extraction from various shapes of output
function extractNumericIdsFromUnknown(out: any, preferredKey?: string): number[] | null {
  if (!out) return null;

  // direct array
  if (Array.isArray(out) && out.every((x) => typeof x === "number" && isFinite(x))) return out;

  // Set<number>
  if (out instanceof Set) {
    const arr = Array.from(out).filter((x) => typeof x === "number" && isFinite(x));
    return arr.length ? arr : null;
  }

  // Map<any, any>
  if (out instanceof Map) {
    // try preferred key first
    if (preferredKey != null && out.has(preferredKey)) {
      const v = out.get(preferredKey);
      const ids = extractNumericIdsFromUnknown(v);
      if (ids?.length) return ids;
    }

    // deterministic fallback: scan entries by sorted key string
    const entries = Array.from(out.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const [, v] of entries) {
      const ids = extractNumericIdsFromUnknown(v);
      if (ids?.length) return ids;
    }
    return null;
  }

  // plain object: try preferred key, then scan keys deterministically
  if (typeof out === "object") {
    if (preferredKey != null) {
      const v =
        (out as any)[preferredKey] ??
        (out as any)[preferredKey.toUpperCase()] ??
        (out as any)[preferredKey.toLowerCase()];
      const ids = extractNumericIdsFromUnknown(v);
      if (ids?.length) return ids;
    }

    // common container fields
    for (const k of ["ids", "items", "expressIds", "elements"]) {
      const ids = extractNumericIdsFromUnknown((out as any)[k]);
      if (ids?.length) return ids;
    }

    // scan all keys in sorted order for first numeric array/set/map
    const keys = Object.keys(out).sort();
    for (const k of keys) {
      const ids = extractNumericIdsFromUnknown((out as any)[k]);
      if (ids?.length) return ids;
    }
  }

  return null;
}

function debugDescribeOut(out: any) {
  const kind = Object.prototype.toString.call(out);
  const keys = out && typeof out === "object" && !(out instanceof Map) && !(out instanceof Set) ? Object.keys(out).slice(0, 30) : [];
  return { kind, keys };
}


  //---------------------------------------------------//
  //--------------- Viewer API methods ----------------//
  //------------------Returned object -----------------//
  //---------------------------------------------------//
  // Return object with viewer API methods
  return {
    // Event: model loaded
    onModelLoaded(cb: (p: { modelId: string; model: any }) => void) {
      return viewerEvents.on("modelLoaded", cb);
    },

    hasModelLoaded(): boolean {
      return Boolean(getActiveModel() && getActiveModelId());
    },

        // --- low-level helpers for external modules (navigation, metrics, etc.) ---
    getThreeCamera() {
      return world.camera.three;
    },

    getRendererDomElement() {
      return world.renderer.three.domElement;
    },

    renderNow() {
      world.renderer.three.render(world.scene.three, world.camera.three);
    },

    getLastSelection(): OBC.ModelIdMap | null {
  return lastSelection;
},

    getSceneObjects(): THREE.Object3D[] {
      // safest: the model root only, not helpers/grid
      const model = getActiveModel();
      return model?.object ? [model.object] : [];
    },

    async clearModel(): Promise<void> {
      const model = getActiveModel();
      const modelId = getActiveModelId();

      if (!model || !modelId) return;

      try {
        // Remove from scene
        world.scene.three.remove(model.object);

        // Try to dispose GPU resources if supported
        model.dispose?.();
        model.object?.traverse?.((obj: any) => {
          obj.geometry?.dispose?.();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
            else obj.material.dispose?.();
          }
        });

        // Remove from fragments list if possible
        fragments.list.delete?.(modelId);

        // Reset visibility state
        visibilityState = { mode: "all", lastIsolateCount: undefined };

        // Optional: emit event so UI modules can react
        viewerEvents.emit("modelUnloaded", {});
      } catch (err) {
        console.error("[ViewerApi] clearModel failed", err);
      }
    },

    async getCameraPose(): Promise<CameraPose> {
      const cam = world.camera.controls;

      // try to use control helpers if available, fallback otherwise
      // @ts-expect-error
      const pos = cam.getPosition ? cam.getPosition(new THREE.Vector3()) : world.camera.three.position.clone();
      // @ts-expect-error
      const tgt = cam.getTarget ? cam.getTarget(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);

      return {
        eye: { x: pos.x, y: pos.y, z: pos.z },
        target: { x: tgt.x, y: tgt.y, z: tgt.z },
      };
    },

    async setCameraPose(pose: CameraPose, smooth = true) {
      const { eye, target } = pose;
      await world.camera.controls.setLookAt(
        eye.x, eye.y, eye.z,
        target.x, target.y, target.z,
        smooth
      );
    },

    /**
     * Sets camera to a deterministic preset view (iso/top).
     *
     * Critical assessment:
     * - We do not do this automatically; caller decides when to enforce determinism.
     * - Used for: controlled experiments OR a fallback if user pose is too occluded.
     */
    async setPresetView(preset: StartPosePreset, smooth = true) {
      const pose = getPresetPose(preset);
      if (!pose) return;
      await this.setCameraPose(pose, smooth);
    },

    async moveCameraRelative(delta: { dx: number; dy: number; dz: number }, smooth = true) {
      const pose = await this.getCameraPose();
      await this.setCameraPose({
        eye: { x: pose.eye.x + delta.dx, y: pose.eye.y + delta.dy, z: pose.eye.z + delta.dz },
        target: { x: pose.target.x + delta.dx, y: pose.target.y + delta.dy, z: pose.target.z + delta.dz },
      }, smooth);
    },

    async isolate(map: OBC.ModelIdMap) {
      const count = countItems(map);
      if (count === 0) return;

      await hider.set(true);
      await hider.isolate(map);

      // update visibility state for metadata/logging
      lastIsolateMap = cloneModelIdMap(map);
      visibilityState = { mode: "isolate", lastIsolateCount: count };
    },

async resetVisibility() {
  await hider.set(true);
  lastIsolateMap = null;
  visibilityState = { mode: "all", lastIsolateCount: undefined };
  for (const k of Object.keys(hiddenMapByModel)) delete hiddenMapByModel[k];

  // ✅ clear plan cut too
  planCutState = { enabled: false, planes: [] }
  clearClippingPlanes();

  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},


    getVisibilityState(): VisibilityState {
      // Return a copy so external modules can't mutate internal state by accident.
      return { ...visibilityState };
    },

async isolateCategory(category: string): Promise<OBC.ModelIdMap | null> {
  const modelKey = getActiveModelId();
  if (!modelKey) return null;

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group) return null;

  if (typeof group.getItemsOfCategories !== "function") {
    console.warn("[viewerApi] isolateCategory: getItemsOfCategories not available");
    return null;
  }
  
  // ---- NEW: normalize + synonyms ----
  const raw = String(category ?? "").trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();

  // deterministic synonym mapping for common user words
  const synonymToIfc: Record<string, string> = {
    DOOR: "IFCDOOR",
    DOORS: "IFCDOOR",
    STAIR: "IFCSTAIR",
    STAIRS: "IFCSTAIR",
    STAIRCASE: "IFCSTAIR",
    WALL: "IFCWALL",
    WALLS: "IFCWALL",
    SLAB: "IFCSLAB",
    SLABS: "IFCSLAB",
    CEILING: "IFCCOVERING",
    CEILINGS: "IFCCOVERING",
    WINDOW: "IFCWINDOW",
    WINDOWS: "IFCWINDOW",
    SPACE: "IFCSPACE",
    SPACES: "IFCSPACE",
    RAMP: "IFCRAMP",
    RAMPS: "IFCRAMP",
  };

  // If user passed "IfcDoor" -> "IFCDOOR"
  const ifcLike = upper.startsWith("IFC") ? upper : synonymToIfc[upper] ?? upper;

  // Build candidate category patterns in priority order (deterministic)
  const candidates: string[] = [];
  candidates.push(ifcLike);

  // also try adding IFC prefix if user provided e.g. "DOOR" (already mapped) or "DOORFITTING"
  if (!ifcLike.startsWith("IFC")) candidates.push(`IFC${ifcLike}`);

  // if user passed "IFCDOOR", also try "IfcDoor" style is not needed because regex is i
  // ---- END NEW ----

  // Try exact matches first
  let out: any = null;
  for (const c of candidates) {
    const re = new RegExp(`^${c}$`, "i");
    try {
      out = await group.getItemsOfCategories([re]);
    } catch (e) {
      console.warn("[viewerApi] isolateCategory: getItemsOfCategories threw", e);
      return null;
    }

    const ids = extractNumericIdsFromUnknown(out, c);
    if (ids && ids.length) {
      const map: OBC.ModelIdMap = { [modelKey]: new Set(ids) };
      await this.isolate(map);
      return map;
    }
  }

  // Fallback: if getCategories exists, try to pick a best category by containment
  if (typeof group.getCategories === "function") {
    let cats: string[] = [];
    try {
      cats = (await group.getCategories()) ?? [];
    } catch {
      cats = [];
    }

    const want = ifcLike; // e.g., IFCDOOR
    const sorted = Array.from(new Set(cats.map((x) => String(x)))).sort();

    // deterministic fallback order: exact -> contains -> startsWith
    const pick =
      sorted.find((k) => k.toUpperCase() === want) ??
      sorted.find((k) => k.toUpperCase().includes(want)) ??
      sorted.find((k) => k.toUpperCase().startsWith(want));

    if (pick) {
      const re = new RegExp(`^${pick}$`, "i");
      try {
        out = await group.getItemsOfCategories([re]);
      } catch (e) {
        console.warn("[viewerApi] isolateCategory fallback threw", e);
        return null;
      }

      const ids = extractNumericIdsFromUnknown(out, pick.toUpperCase());
      if (ids && ids.length) {
        const map: OBC.ModelIdMap = { [modelKey]: new Set(ids) };
        await this.isolate(map);
        return map;
      }
    }
  }

  console.warn("[viewerApi] isolateCategory: no ids returned", {
    category,
    modelKey,
    candidates,
    outInfo: out ? debugDescribeOut(out) : null,
  });
  return null;
},

async listStoreys(): Promise<string[]> {
  const levels = (ctx as any).classifier?.list?.get?.("Levels");
  if (!levels) return [];
  return Array.from(levels.keys()).map((k) => String(k));
},

async isolateStorey(storeyId: string): Promise<OBC.ModelIdMap | null> {
  const levels = (ctx as any).classifier?.list?.get?.("Levels");
  if (!levels) {
    console.warn("[viewerApi] isolateStorey: Levels not available");
    return null;
  }

  // storeyId here is the levelName shown in the UI tree (e.g. "First floor")
  const entry = levels.get(String(storeyId));
  if (!entry?.get) {
    console.warn("[viewerApi] isolateStorey: unknown storeyId", storeyId);
    return null;
  }

  const map = await entry.get();
  const count =
    map && typeof map === "object"
      ? Object.values(map).reduce((acc: number, s: any) => acc + (s?.size ?? 0), 0)
      : 0;

  if (!map || count === 0) {
    console.warn("[viewerApi] isolateStorey: empty map", storeyId);
    return null;
  }

  await this.isolate(map);
  return map;
},

async isolateSpace(spaceId: string): Promise<OBC.ModelIdMap | null> {
  const spaces = (ctx as any).classifier?.list?.get?.("Spaces");
  if (!spaces) {
    console.warn("[viewerApi] isolateSpace: Spaces not available");
    return null;
  }

  const entry = spaces.get(String(spaceId));
  if (!entry?.get) {
    console.warn("[viewerApi] isolateSpace: unknown spaceId", spaceId);
    return null;
  }

  const map = await entry.get();
  const count =
    map && typeof map === "object"
      ? Object.values(map).reduce((acc: number, s: any) => acc + (s?.size ?? 0), 0)
      : 0;

  if (!map || count === 0) {
    console.warn("[viewerApi] isolateSpace: empty map", spaceId);
    return null;
  }

  await this.isolate(map);
  return map;
},



async setPlanCut(params: { height: number; thickness?: number; mode?: "WORLD_UP" | "CAMERA" }) {
  const height = params.height;
  if (!Number.isFinite(height)) return;

  const upAxis = getUpAxis();

  // Base: if storey isolated -> use its min; else use camera target (stable)
  let base = 0;
  const current = (this as any).getCurrentIsolateSelection?.() as OBC.ModelIdMap | null;

  if (current) {
    const box = await this.getSelectionWorldBox(current);
    if (box && !box.isEmpty()) base = upAxis === "y" ? box.min.y : box.min.z;
    else {
      const pose = await this.getCameraPose();
      base = upAxis === "y" ? pose.target.y : pose.target.z;
    }
  } else {
    const pose = await this.getCameraPose();
    base = upAxis === "y" ? pose.target.y : pose.target.z;
  }

  let abs = base + height;

  // Clamp inside model bounds so we never clip everything by accident
  const model = getActiveModel();
  if (model?.object) {
    const box = new THREE.Box3().setFromObject(model.object);
    if (!box.isEmpty()) {
      const minH = upAxis === "y" ? box.min.y : box.min.z;
      const maxH = upAxis === "y" ? box.max.y : box.max.z;
      const eps = (maxH - minH) * 0.01;
      abs = Math.max(minH + eps, Math.min(maxH - eps, abs));
    }
  }

  // Build plane intended to CLIP ABOVE abs and KEEP below abs.
  // We'll verify with distanceToPoint and flip if needed.
  const n = upAxis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const p0 = upAxis === "y" ? new THREE.Vector3(0, abs, 0) : new THREE.Vector3(0, 0, abs);

  let plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0);
  // Debug + auto-fix direction
  logPlaneTest(plane, abs, upAxis);

  // We want "above" to be clipped. If your renderer keeps the wrong side,
  // flip the plane. This condition is the robust part:
  //
  // If after applying plane you observe it keeps ABOVE and clips BELOW,
  // then you need plane.negate().
  //
  // We can't "apply then check" easily here, but we CAN use a deterministic
  // rule based on plane distances:
  //
  // If plane.distance(above) is NOT greater than plane.distance(below),
  // the orientation is likely wrong for our intended semantic.
  const abovePt = upAxis === "y" ? new THREE.Vector3(0, abs + 0.5, 0) : new THREE.Vector3(0, 0, abs + 0.5);
  const belowPt = upAxis === "y" ? new THREE.Vector3(0, abs - 0.5, 0) : new THREE.Vector3(0, 0, abs - 0.5);

  const da = plane.distanceToPoint(abovePt);
  const db = plane.distanceToPoint(belowPt);

  // If "above" isn't more on the normal side than "below", flip.
  if (!(da > db)) {
    plane = plane.clone().negate();
    console.log("[PlanCut] plane flipped");
    logPlaneTest(plane, abs, upAxis);
  }

  const planes = [plane];

  planCutState = { enabled: true, planes };
  applyClippingPlanes(planes);

  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);

  console.log("[PlanCut]", { upAxis, base, height, absoluteHeight: abs });
},


async clearPlanCut() {
  planCutState = { enabled: false, planes: [] };
  clearClippingPlanes();
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},

getPlanCutState() {
  return planCutState.enabled
    ? { enabled: true, planes: planCutState.planes.length }
    : { enabled: false };
},


async hideCategory(category: string): Promise<boolean> {
  const modelKey = getActiveModelId();
  if (!modelKey) return false;

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group?.getItemsOfCategories) return false;

  const norm = normalizeIfcCategory(category);
  if (!norm) return false;

  const re = new RegExp(`^${norm}$`, "i");

  let out: any;
  try {
    out = await group.getItemsOfCategories([re]);
  } catch (e) {
    console.warn("[viewerApi] hideCategory: getItemsOfCategories threw", e);
    return false;
  }

  const ids = extractNumericIdsFromUnknown(out, norm);
  if (!ids?.length) return false;

  const map: OBC.ModelIdMap = { [modelKey]: new Set(ids) };

  // track hidden for evidence (if you added hidden tracking earlier)
  for (const id of ids) ensureHiddenSet(modelKey).add(id);

  await hider.set(false, map);
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
  return true;
},

async showCategory(category: string): Promise<boolean> {
  const modelKey = getActiveModelId();
  if (!modelKey) return false;

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group?.getItemsOfCategories) return false;

  const norm = normalizeIfcCategory(category);
  if (!norm) return false;

  const re = new RegExp(`^${norm}$`, "i");

  let out: any;
  try {
    out = await group.getItemsOfCategories([re]);
  } catch (e) {
    console.warn("[viewerApi] showCategory: getItemsOfCategories threw", e);
    return false;
  }

  const ids = extractNumericIdsFromUnknown(out, norm);
  if (!ids?.length) return false;

  const map: OBC.ModelIdMap = { [modelKey]: new Set(ids) };

  const hs = (hiddenMapByModel as any)?.[modelKey] as Set<number> | undefined;
  if (hs) for (const id of ids) hs.delete(id);

  await hider.set(true, map);
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
  return true;
},


    async hideIds(ids: string[]) {
      const activeModelId = getActiveModelId();
      if (!activeModelId) return;

      // Build a ModelIdMap grouped by model
      const map: OBC.ModelIdMap = {};
      for (const raw of ids ?? []) {
        const parsed = parseObjectId(raw);
        if (!parsed) continue;
        (map[parsed.modelId] ??= new Set<number>()).add(parsed.localId);
        ensureHiddenSet(parsed.modelId).add(parsed.localId);
      }

      // Nothing to hide
      if (Object.keys(map).length === 0) return;

      // Hide just these items
      await hider.set(false, map); // <- This is the intended usage. :contentReference[oaicite:1]{index=1}
      fragments.core.update(true);
    },

    async showIds(ids: string[]) {
      const map: OBC.ModelIdMap = {};
      for (const raw of ids ?? []) {
        const parsed = parseObjectId(raw);
        if (!parsed) continue;
        (map[parsed.modelId] ??= new Set<number>()).add(parsed.localId);

        const s = hiddenMapByModel[parsed.modelId];
        if (s) s.delete(parsed.localId);
      }

      if (Object.keys(map).length === 0) return;

      // Show just these items (inverse of hide)
      await hider.set(true, map);
      fragments.core.update(true);
    },

    async getHiddenIds(): Promise<string[]> {
      // Return canonical "modelId:localId" strings (stable & multi-model safe)
      const out: string[] = [];
      const modelIds = Object.keys(hiddenMapByModel).sort();
      for (const mid of modelIds) {
        const ids = Array.from(hiddenMapByModel[mid] ?? []).filter(Number.isFinite).sort((a, b) => a - b);
        for (const localId of ids) out.push(toObjectId(mid, localId));
      }
      return out;
    },

async highlightIds(ids: string[], style?: "primary" | "warn") {
  const modelId = getActiveModelId();
  if (!modelId) return;

  const group = getActiveGroupAny();
  if (!group) return;

  // reset previous highlights
  if (typeof group.resetHighlight === "function") {
    group.resetHighlight();
  }

  // Convert objectIds to local numeric ids
  const localIds: number[] = [];
  for (const raw of ids ?? []) {
    const parsed = parseObjectId(raw);
    if (!parsed) continue;
    if (parsed.modelId !== modelId) continue;
    localIds.push(parsed.localId);
  }
  if (!localIds.length) return;

  // Best effort: group.highlight(ids, materialOrStyle?)
  // We keep it deterministic: same style string passed through if supported.
  if (typeof group.highlight === "function") {
    try {
      group.highlight(localIds, { style: style ?? "primary" });
    } catch {
      // many versions accept just ids
      group.highlight(localIds);
    }
  }

  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},


async pickObjectAt(x: number, y: number): Promise<string | null> {
  const modelId = getActiveModelId();
  if (!modelId) return null;

  const group = getActiveGroupAny();
  if (!group) return null;

  const canvas = world.renderer.three.domElement;
  const rect = canvas.getBoundingClientRect();

  // Convert to normalized device coords
  const nx = (x / rect.width) * 2 - 1;
  const ny = -(y / rect.height) * 2 + 1;

  // Prefer FragmentsGroup.raycast if available (it is, per your proto keys)
  if (typeof group.raycast === "function") {
    const hit = group.raycast(world.camera.three, new THREE.Vector2(nx, ny));
    // hit shape varies by version; try best-effort extraction
    const ids =
      (hit && (hit.ids ?? hit.items ?? hit.itemIds ?? hit.id)) ??
      null;

    const pickFirstNumber = (v: any): number | null => {
      if (typeof v === "number" && isFinite(v)) return v;
      if (Array.isArray(v)) {
        const n = v.find((q) => typeof q === "number" && isFinite(q));
        return n ?? null;
      }
      if (v instanceof Set) {
        for (const q of v) if (typeof q === "number" && isFinite(q)) return q;
      }
      return null;
    };

    const localId = pickFirstNumber(ids) ?? pickFirstNumber(hit?.item) ?? pickFirstNumber(hit?.localId);
    if (localId != null) {
      const objectId = `${modelId}:${localId}`;
      lastPickedObjectId = objectId;
      return objectId;
    }
  }

  return null;
},


        async getProperties(objectId: string): Promise<Record<string, unknown> | null> {
      const parsed = parseObjectId(objectId);
      if (!parsed) return null;

      // Current implementation only supports active model properties reliably.
      const active = getActiveModelId();
      if (!active || parsed.modelId !== active) return null;

      const props = await this.getElementProperties(parsed.localId);
      return (props ?? null) as any;
    },

async hideSelected(): Promise<void> {
  if (!lastPickedObjectId) return;
  await this.hideIds([lastPickedObjectId]);
},

        getLastPickedObjectId(): string | null {
      return lastPickedObjectId;
    },

__debug: {
  getActiveModelKeys: () => Object.keys((getActiveModel() as any) || {}),
  getActiveModel: () => getActiveModel(),
  getFragmentsKeys: () => Object.keys((fragments as any) || {}),
  getFragmentsCoreKeys: () => Object.keys(((fragments as any)?._core) || {}),
  getFragmentsComponentsKeys: () => Object.keys(((fragments as any)?.components) || {}),
getFragmentsListKeys: () => {
  const l: any = (fragments as any).list;
  if (!l) return [];
  // Map keys if possible
  if (typeof l.keys === "function") return Array.from(l.keys());
  return Object.getOwnPropertyNames(l);
},
getActiveFragmentsGroupKeys: () => {
  const modelKey = getActiveModelId();
  const l: any = (fragments as any).list;
  const g = modelKey && typeof l?.get === "function" ? l.get(modelKey) : null;
  if (!g) return [];
  return Object.getOwnPropertyNames(g).sort();
},
getActiveFragmentsGroupProtoKeys: () => {
  const modelKey = getActiveModelId();
  const l: any = (fragments as any).list;
  const g = modelKey && typeof l?.get === "function" ? l.get(modelKey) : null;
  if (!g) return [];
  return Object.getOwnPropertyNames(Object.getPrototypeOf(g) || {}).sort();
},
sampleGroupProperties: () => {
  const modelKey = getActiveModelId();
  const l: any = (fragments as any).list;
  const g = modelKey && typeof l?.get === "function" ? l.get(modelKey) : null;
  const pm: any = g?.properties;
  if (!pm?.entries) return null;
  const it = pm.entries();
  const first = it.next();
  if (first.done) return null;
  const [k, v] = first.value;
  return { keyType: typeof k, key: k, value: v };
},
getGroupCategories: () => {
  const modelKey = getActiveModelId();
  const listAny: any = (fragments as any).list;
  const group = modelKey && typeof listAny?.get === "function" ? listAny.get(modelKey) : null;
  if (!group) return [];
  if (typeof group.getCategories === "function") {
    try { return group.getCategories(); } catch { return []; }
  }
  return [];
},
sampleCategoryCount: (cat: string) => {
  const modelKey = getActiveModelId();
  const listAny: any = (fragments as any).list;
  const group = modelKey && typeof listAny?.get === "function" ? listAny.get(modelKey) : null;
  if (!group) return { ok: false, reason: "no-group" };

  const norm = String(cat).trim().toUpperCase();

  if (typeof group.getItemsOfCategories !== "function") {
    return { ok: false, reason: "no-getItemsOfCategories" };
  }

  try {
    const re = new RegExp(`^${norm}$`, "i");
    out = group.getItemsOfCategories([re]);


    const asArray = Array.isArray(out)
      ? out
      : out instanceof Set
        ? Array.from(out)
        : typeof out?.get === "function"
          ? (out.get(norm) ?? out.get(norm.toLowerCase()) ?? out.get(norm.toUpperCase()) ?? [])
          : (out?.[norm] ?? out?.[norm.toLowerCase()] ?? out?.[norm.toUpperCase()] ?? []);

    return { ok: true, norm, count: Array.isArray(asArray) ? asArray.length : 0, outKind: Object.prototype.toString.call(out) };
  } catch (e: any) {
    return { ok: false, norm, reason: String(e?.message ?? e) };
  }
},

dumpItemsOfCategories: async (cat: string) =>{
  const modelKey = getActiveModelId();
  const listAny: any = (fragments as any).list;
  const group = modelKey && typeof listAny?.get === "function" ? listAny.get(modelKey) : null;
  if (!group?.getItemsOfCategories) return { ok: false, reason: "no-getItemsOfCategories" };

  const norm = String(cat).trim().toUpperCase();
  const re = new RegExp(`^${norm}$`, "i");
  const out = await group.getItemsOfCategories([re]);



  return {
    ok: true,
    norm,
    outInfo: debugDescribeOut(out),
    // show a small sample deterministically (won’t blow up console)
    sampleIds: (extractNumericIdsFromUnknown(out, norm) ?? []).slice(0, 20),
  };
},




},



        getCurrentIsolateSelection(): OBC.ModelIdMap | null {
      return lastIsolateMap ? cloneModelIdMap(lastIsolateMap) : null;
    },

    // These three are used by the navigation agent for projection + forced renders
    getThreeCamera(): THREE.Camera {
      return world.camera.three;
    },

    getRendererDomElement(): HTMLCanvasElement {
      return world.renderer.three.domElement;
    },

    renderNow(): void {
      world.renderer.three.render(world.scene.three, world.camera.three);
    },

    /**
     * Compute a world-space bounding box for a selection.
     * If the library provides a direct method, use it.
     * Otherwise: fallback to model bounds (still useful for early PoC navigation).
     */
    async getSelectionWorldBox(map: OBC.ModelIdMap): Promise<THREE.Box3 | null> {
      const model = getActiveModel();
      if (!model?.object) return null;

      // Try common OBC/fragments helpers if they exist (version differences)
      const f: any = fragments as any;

      // 1) If fragments provides something like getBoundingBox(map)
      if (typeof f.getBoundingBox === "function") {
        try {
          const b = await f.getBoundingBox(map);
          if (b && b.isBox3 && !b.isEmpty()) return b as THREE.Box3;
        } catch {}
      }

      // 2) If model provides a selection bbox helper
      if (typeof (model as any).getBoundingBox === "function") {
        try {
          const b = await (model as any).getBoundingBox(map);
          if (b && b.isBox3 && !b.isEmpty()) return b as THREE.Box3;
        } catch {}
      }

      // 3) Fallback: model bounds (not selection-specific, but prevents null)
      const box = new THREE.Box3().setFromObject(model.object);
      if (box.isEmpty()) return null;
      return box;
    },

    async getSelectionMeshes(map: OBC.ModelIdMap): Promise<THREE.Object3D[]> {
  const modelKey = Object.keys(map ?? {})[0];
  if (!modelKey) return [];

  const ids = Array.from(map[modelKey] ?? []);
  if (!ids.length) return [];

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group) return [];

  const out: THREE.Object3D[] = [];
  const seen = new Set<string>();

  // Prefer batch method if available
  if (typeof group.getMeshesByItems === "function") {
    const meshes: THREE.Object3D[] = await group.getMeshesByItems(ids);
    for (const m of meshes ?? []) {
      if (!m) continue;
      if (!seen.has(m.uuid)) {
        seen.add(m.uuid);
        out.push(m);
      }
    }
    return out;
  }

  // Fallback: per-item
  if (typeof group.getMeshesByItem === "function") {
    for (const id of ids) {
      const meshes: THREE.Object3D[] = await group.getMeshesByItem(id);
      for (const m of meshes ?? []) {
        if (!m) continue;
        if (!seen.has(m.uuid)) {
          seen.add(m.uuid);
          out.push(m);
        }
      }
    }
    return out;
  }

  return [];
},

async stabilizeForSnapshot(): Promise<void> {
  await stabilizeSceneForSnapshot();
},

    async getSnapshot(opts?: { note?: string }): Promise<ViewerSnapshot> {
      // 1) Ensure fragments update (geometry + visibility state)
      await stabilizeSceneForSnapshot();
      fragments.core.update(true);

      // 2) Wait for the browser to actually paint at least once
      //    (two frames is safer for WebGL + async fragment updates)
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));

      // 3) Force an explicit render right before reading pixels
      world.renderer.three.render(world.scene.three, world.camera.three);

      const canvas = world.renderer.three.domElement;
const dataUrl = canvas.toDataURL("image/png");
const imageBase64Png = dataUrl.startsWith("data:image/")
  ? dataUrl.split(",")[1] ?? ""
  : dataUrl;


      const pose = await this.getCameraPose();

      return {
        imageBase64Png,
        pose,
        meta: {
          timestampIso: new Date().toISOString(),
          modelId: getActiveModelId(),
          note: opts?.note,
        },
      };
    },

async stabilizeForSnapshot(): Promise<void> {
  await stabilizeSceneForSnapshot();
},    
    async getElementProperties(localId: number): Promise<Record<string, any> | null> {
      const model = getActiveModel();
      if (!model) return null;

      try {
        if (typeof model.getProperties === "function") {
          return await model.getProperties(localId);
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

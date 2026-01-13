// src/viewer/api.ts
// viewer API: onModelLoaded, get/setCameraPose, isolate, getSnapshot, getElementProperties

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { getActiveModel, getActiveModelId } from "./state";
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




  // --- Navigation helpers / state ---

  // Keep a copy of the last isolate map (so navigation can "go to what is currently isolated")
  let lastIsolateMap: OBC.ModelIdMap | null = null;

  function cloneModelIdMap(map: OBC.ModelIdMap): OBC.ModelIdMap {
    const out: OBC.ModelIdMap = {};
    for (const [mid, set] of Object.entries(map)) out[mid] = new Set(set);
    return out;
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
    },

    getVisibilityState(): VisibilityState {
      // Return a copy so external modules can't mutate internal state by accident.
      return { ...visibilityState };
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
      const imageBase64Png = canvas.toDataURL("image/png");

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

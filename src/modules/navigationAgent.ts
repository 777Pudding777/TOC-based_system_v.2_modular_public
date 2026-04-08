// src/modules/navigationAgent.ts
// PoC Navigation Agent: finds a "good" viewpoint for a target selection
// using deterministic geometric metrics (projected area + optional occlusion).

import * as THREE from "three";
import type * as OBC from "@thatopen/components";
import type { CameraPose } from "../viewer/api";

type ToastFn = (msg: string, ms?: number) => void;

export type NavMetrics = {
  // fraction of viewport occupied by target's projected bbox (0..1)
  targetAreaRatio: number;

  // fraction occluded (0..1). In PoC can be null if disabled.
  occlusionRatio: number | null;

  // number of iterations performed
  steps: number;

  // whether stop criteria reached
  success: boolean;

  // for debugging/reports
  reason: string;
};

export type NavOptions = {
  // Stop thresholds
  minTargetAreaRatio?: number; // e.g. 0.10 = 10%
  maxOcclusionRatio?: number;  // e.g. 0.35
  focusBox?: THREE.Box3;

  // Iteration controls
  maxSteps?: number;
  epsilon?: number;            // convergence threshold
  convergenceWindow?: number;  // how many steps to check

  // Behavior tuning
  zoomFactor?: number;         // how aggressive zoom is per step
  orbitDegrees?: number;       // yaw step per iteration
  elevateFactor?: number;      // raise camera slightly if stuck

  // Occlusion sampling (optional)
  enableOcclusion?: boolean;
  occlusionSamples?: number;   // grid sampling density (e.g. 16 or 25)
};

export type GoToIsolateResult = {
  ok: boolean;
  method: "navigateToSelection";
  reason?: string;
  metrics?: NavMetrics;
};

export type NavigationAgent = {
  navigateToSelection: (map: OBC.ModelIdMap, opts?: NavOptions) => Promise<NavMetrics>;
  measureSelection: (map: OBC.ModelIdMap, opts?: Pick<NavOptions, "enableOcclusion" | "occlusionSamples" | "focusBox">) => Promise<NavMetrics>;

  // NEW: what your panel calls
  goToCurrentIsolateSelection: (opts?: NavOptions) => Promise<GoToIsolateResult>;
};


export function createNavigationAgent(params: {
  viewerApi: {
    hasModelLoaded: () => boolean;
    getCameraPose: () => Promise<CameraPose>;
    setCameraPose: (pose: CameraPose, smooth?: boolean) => Promise<void>;
    getSelectionWorldBox: (map: OBC.ModelIdMap) => Promise<THREE.Box3 | null>;
    getSelectionMeshes?: (map: OBC.ModelIdMap) => Promise<THREE.Object3D[]>;
    getCurrentIsolateSelection: () => OBC.ModelIdMap | null;
    getThreeCamera: () => THREE.Camera;
    getRendererDomElement: () => HTMLCanvasElement;
    renderNow: () => void;

    // ✅ add this here (recommended: keep it on viewerApi, not top-level)
    getSceneObjects?: () => THREE.Object3D[];
  };
  toast?: ToastFn;
}) : NavigationAgent {
const { viewerApi, toast } = params;


  // --- utilities ---
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  function degToRad(d: number) {
    return (d * Math.PI) / 180;
  }

  function areaOfRect(r: { w: number; h: number }) {
    return Math.max(0, r.w) * Math.max(0, r.h);
  }

  function projectBoxToScreenRect(box: THREE.Box3, camera: THREE.Camera, canvas: HTMLCanvasElement) {
    // Project 8 corners into NDC -> screen space
    const pts = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const p of pts) {
      p.project(camera); // NDC [-1,1]
      const sx = (p.x * 0.5 + 0.5) * canvas.width;
      const sy = (-p.y * 0.5 + 0.5) * canvas.height;
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx);
      maxY = Math.max(maxY, sy);
    }

    // clamp to viewport bounds (projection can go slightly outside)
    minX = Math.max(0, Math.min(canvas.width, minX));
    maxX = Math.max(0, Math.min(canvas.width, maxX));
    minY = Math.max(0, Math.min(canvas.height, minY));
    maxY = Math.max(0, Math.min(canvas.height, maxY));

    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function computeTargetAreaRatio(box: THREE.Box3): number {
    const camera = viewerApi.getThreeCamera();
    const canvas = viewerApi.getRendererDomElement();
    const rect = projectBoxToScreenRect(box, camera, canvas);

    const targetArea = areaOfRect(rect);
    const viewArea = canvas.width * canvas.height;

    if (viewArea <= 0) return 0;
    return clamp01(targetArea / viewArea);
  }

  /**
   * Occlusion ratio PoC:
   * - sample points in target screen rect
   * - raycast into scene, check if first hit is on target meshes or not
   *
   * Critical assessment:
   * - This is approximate.
   * - Expensive if you do too many samples.
   * - Useful as a heuristic (not ground truth).
   */
  async function computeOcclusionRatio(
    box: THREE.Box3,
    map: OBC.ModelIdMap,
    samples = 16
  ): Promise<number | null> {
    // Need a way to know which meshes are the target
    if (!viewerApi.getSelectionMeshes) return null;

    const camera = viewerApi.getThreeCamera() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const canvas = viewerApi.getRendererDomElement();
    const rect = projectBoxToScreenRect(box, camera, canvas);

    if (rect.w * rect.h < 50) return 0;

    const targetRoots = await viewerApi.getSelectionMeshes(map);
    if (!targetRoots.length) return null;

    // Build a set of all target objects (fast membership test)
    const targetSet = new Set<THREE.Object3D>();
    for (const root of targetRoots) root.traverse((o: THREE.Object3D) => targetSet.add(o));

    // Raycast against the whole scene (not just target)
    const sceneObjects = viewerApi.getSceneObjects?.() ?? [];
    if (!sceneObjects.length) return null;

    const raycaster = new THREE.Raycaster();
    const step = Math.max(1, Math.floor(Math.sqrt(samples)));

    let total = 0;
    let occluded = 0;

    for (let iy = 0; iy < step; iy++) {
      for (let ix = 0; ix < step; ix++) {
        total++;

        const u = (ix + 0.5) / step;
        const v = (iy + 0.5) / step;
        const sx = rect.x + u * rect.w;
        const sy = rect.y + v * rect.h;

        const ndc = new THREE.Vector2(
          (sx / canvas.width) * 2 - 1,
          -((sy / canvas.height) * 2 - 1)
        );

        raycaster.setFromCamera(ndc, camera);

        // Intersect full scene
        const hits = raycaster.intersectObjects(sceneObjects, true);

        if (!hits.length) {
          // If nothing hit, treat as occluded/no-signal
          occluded++;
          continue;
        }

        const first = hits[0].object;
        const visible = targetSet.has(first);

        if (!visible) occluded++;
      }
    }

    return total > 0 ? clamp01(occluded / total) : null;
  }



  function orbitPoseAroundTarget(current: CameraPose, center: THREE.Vector3, radiansYaw: number): CameraPose {
    const eye = new THREE.Vector3(current.eye.x, current.eye.y, current.eye.z);

    // Keep target fixed at center (more stable than orbiting target point from previous view)
    const offset = eye.clone().sub(center);

    // rotate around Y axis (world up)
    const rot = new THREE.Matrix4().makeRotationY(radiansYaw);
    const newOffset = offset.clone().applyMatrix4(rot);

    const newEye = center.clone().add(newOffset);

    return {
      eye: { x: newEye.x, y: newEye.y, z: newEye.z },
      target: { x: center.x, y: center.y, z: center.z },
    };
  }

  function zoomPoseTowardTarget(current: CameraPose, center: THREE.Vector3, factor: number): CameraPose {
    // factor > 0 zooms in; <0 zooms out
    const eye = new THREE.Vector3(current.eye.x, current.eye.y, current.eye.z);
    const dir = center.clone().sub(eye);
    const newEye = eye.clone().add(dir.multiplyScalar(factor));

    return {
      eye: { x: newEye.x, y: newEye.y, z: newEye.z },
      target: { x: center.x, y: center.y, z: center.z },
    };
  }

  function elevatePose(current: CameraPose, dy: number): CameraPose {
    return {
      eye: { x: current.eye.x, y: current.eye.y + dy, z: current.eye.z },
      target: { x: current.target.x, y: current.target.y + dy, z: current.target.z },
    };
  }

  async function navigateToSelection(map: any, opts?: NavOptions): Promise<NavMetrics> {
    if (!viewerApi.hasModelLoaded()) {
      return { targetAreaRatio: 0, occlusionRatio: null, steps: 0, success: false, reason: "no-model" };
    }

    const {
      minTargetAreaRatio = 0.12,
      maxOcclusionRatio = 0.35,
      maxSteps = 30,
      epsilon = 0.01,
      convergenceWindow = 8,
      zoomFactor = 0.18,
      orbitDegrees = 18,
      elevateFactor = 0.2,
      enableOcclusion = false,
      occlusionSamples = 16,
    } = opts ?? {};

    const box = opts?.focusBox?.isBox3
      ? opts.focusBox.clone()
      : await viewerApi.getSelectionWorldBox(map);
    if (!box) {
      return { targetAreaRatio: 0, occlusionRatio: null, steps: 0, success: false, reason: "empty-selection-box" };
    }

    const center = new THREE.Vector3();
    box.getCenter(center);

    const history: Array<{ area: number; occ: number | null }> = [];

    // Iterative loop
    for (let step = 1; step <= maxSteps; step++) {
      // Render once at current pose (helps projection)
      viewerApi.renderNow();

      const area = computeTargetAreaRatio(box);
      const occ = enableOcclusion ? await computeOcclusionRatio(box, map, occlusionSamples) : null;

      history.push({ area, occ });

      // Check stop criteria
      const occOk = occ === null ? true : occ <= maxOcclusionRatio;
      const areaOk = area >= minTargetAreaRatio;

      if (areaOk && occOk) {
        toast?.(`Navigation success (area ${(area*100).toFixed(1)}%)`);
        return { targetAreaRatio: area, occlusionRatio: occ, steps: step, success: true, reason: "thresholds-met" };
      }

      // Convergence check: if not improving anymore, stop
      if (history.length >= convergenceWindow) {
        const last = history[history.length - 1];
        const prev = history[history.length - convergenceWindow];

        const areaDelta = last.area - prev.area;
        // occlusion delta is inverted improvement (lower is better)
        const occDelta = (prev.occ ?? 0) - (last.occ ?? 0);

        const areaStuck = Math.abs(areaDelta) < epsilon;
        const occStuck = enableOcclusion ? Math.abs(occDelta) < epsilon : true;

        if (areaStuck && occStuck) {
          toast?.("Navigation stopped (converged)");
          return { targetAreaRatio: area, occlusionRatio: occ, steps: step, success: false, reason: "converged-no-solution" };
        }
      }

      // Decide next action (simple heuristic):
      // 1) if target too small => zoom in
      // 2) else if occluded => orbit + slight elevate
      // 3) else orbit to explore
      const currentPose = await viewerApi.getCameraPose();

      if (area < minTargetAreaRatio) {
        const next = zoomPoseTowardTarget(currentPose, center, zoomFactor);
        await viewerApi.setCameraPose(next, true);
      } else {
        // explore around target
        const nextOrbit = orbitPoseAroundTarget(currentPose, center, degToRad(orbitDegrees));
        await viewerApi.setCameraPose(nextOrbit, true);

        if (enableOcclusion && occ !== null && occ > maxOcclusionRatio) {
          // small lift to reduce likely occlusion by floors/walls
          const dy = Math.max(box.getSize(new THREE.Vector3()).y * elevateFactor * 0.05, 0.2);
          await viewerApi.setCameraPose(elevatePose(nextOrbit, dy), true);
        }
      }
    }

    // Step cap reached
    const last = history[history.length - 1] ?? { area: 0, occ: null };
    toast?.("Navigation stopped (max steps)");
    return {
      targetAreaRatio: last.area,
      occlusionRatio: last.occ,
      steps: maxSteps,
      success: false,
      reason: "max-steps",
    };
  }

  async function measureSelection(
    map: any,
    opts?: Pick<NavOptions, "enableOcclusion" | "occlusionSamples" | "focusBox">
  ): Promise<NavMetrics> {
    if (!viewerApi.hasModelLoaded()) {
      return { targetAreaRatio: 0, occlusionRatio: null, steps: 0, success: false, reason: "no-model" };
    }

    const {
      enableOcclusion = false,
      occlusionSamples = 16,
    } = opts ?? {};

    const box = opts?.focusBox?.isBox3
      ? opts.focusBox.clone()
      : await viewerApi.getSelectionWorldBox(map);
    if (!box) {
      return { targetAreaRatio: 0, occlusionRatio: null, steps: 0, success: false, reason: "empty-selection-box" };
    }

    viewerApi.renderNow();
    const area = computeTargetAreaRatio(box);
    const occ = enableOcclusion ? await computeOcclusionRatio(box, map, occlusionSamples) : null;

    return {
      targetAreaRatio: area,
      occlusionRatio: occ,
      steps: 0,
      success: true,
      reason: "measured-current-view",
    };
  }

  async function goToCurrentIsolateSelection(opts?: NavOptions): Promise<GoToIsolateResult> {
    const sel = viewerApi.getCurrentIsolateSelection();
    if (!sel) return { ok: false, method: "navigateToSelection", reason: "no-isolate-selection" };

    const metrics = await navigateToSelection(sel, opts);
    return {
      ok: metrics.success,
      method: "navigateToSelection",
      reason: metrics.success ? undefined : metrics.reason,
      metrics,
    };
  }

  return { navigateToSelection, measureSelection, goToCurrentIsolateSelection };

}

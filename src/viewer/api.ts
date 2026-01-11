// src/viewer/api.ts
// viewer API: onModelLoaded, get/setCameraPose, isolate, getSnapshot, getElementProperties

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { getActiveModel, getActiveModelId } from "./state";
import { viewerEvents } from "./events";
import type { ViewerContext } from "./initViewer";

export type CameraPose = {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
};

export type ViewerSnapshot = {
  imageBase64Png: string;
  pose: CameraPose;
  meta: { timestampIso: string; modelId: string | null; note?: string };
};

export function createViewerApi(ctx: ViewerContext) {
  const { world, fragments, hider } = ctx;

  function countItems(map: OBC.ModelIdMap): number {
    let total = 0;
    for (const ids of Object.values(map)) total += ids.size;
    return total;
  }

  return {
    onModelLoaded(cb: (p: { modelId: string; model: any }) => void) {
      return viewerEvents.on("modelLoaded", cb);
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
    },

    async resetVisibility() {
      await hider.set(true);
    },

    async getSnapshot(opts?: { note?: string }) : Promise<ViewerSnapshot> {
      fragments.core.update(true);
      const canvas = world.renderer.three.domElement;
      const imageBase64Png = canvas.toDataURL("image/png");
      const pose = await this.getCameraPose();

      return {
        imageBase64Png,
        pose,
        meta: {
          timestampIso: new Date().toISOString(),
          modelId: getActiveModelId(),
          note: opts?.note
        }
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

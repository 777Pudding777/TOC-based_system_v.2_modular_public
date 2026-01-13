// src/viewer/initViewer.ts
// initializes the viewer, returns context (components, world, loaders, etc.)

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { viewerEvents } from "./events";
import { _setActiveModel } from "./state";

export type ViewerContext = {
  components: OBC.Components;
  world: OBC.World<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >;
  ifcLoader: any;
  fragments: any;
  hider: any;
  classifier: any;
};


// Compute an ISO start pose given an object and its bounding sphere
async function waitForNonEmptyBounds(obj: THREE.Object3D, maxFrames = 30) {
  const box = new THREE.Box3();

  for (let i = 0; i < maxFrames; i++) {
    box.setFromObject(obj);

    if (!box.isEmpty()) return box.clone();

    // wait one frame and try again
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  return null;
}




export async function initViewer(viewerDiv: HTMLDivElement): Promise<ViewerContext> {
  const components = new OBC.Components();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >();

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = new THREE.Color("#202932");

  world.renderer = new OBC.SimpleRenderer(components, viewerDiv);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  // Ensure snapshots include rendered image data
(world.renderer.three as any).preserveDrawingBuffer = true;


  // your initial pose
  await world.camera.controls.setLookAt(78, 20, -2.2, 26, -4, 25);

  components.init();
  components.get(OBC.Grids).create(world);

  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: { path: "https://unpkg.com/web-ifc@0.0.72/", absolute: true },
  });

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init("/thatopen/worker.mjs");

  world.camera.controls.addEventListener("rest", () => fragments.core.update(true));

  const hider = components.get(OBC.Hider);
  const classifier = components.get(OBC.Classifier);

  // When model is added to fragments list
  fragments.list.onItemSet.add(async ({ value: model }: any) => {
    let modelId: string | null = null;
    for (const [id, m] of fragments.list) {
      if (m === model) { modelId = id; break; }
    }
    if (!modelId) return;

    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);




    // fit camera
// fit camera (robust baseline)
// ensure fragments update (sometimes necessary before bounds are valid)
fragments.core.update(true);

// Wait until geometry exists so Box3 isn't empty
const box = await waitForNonEmptyBounds(model.object, 40);

if (!box) {
  console.warn("[Viewer] Model bounds still empty after waiting; keeping current camera pose");
} else {
  const sphere = box.getBoundingSphere(new THREE.Sphere());

  // Baseline fit (good fallback)
  world.camera.controls.fitToSphere(sphere, true);

  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  try {
    // --- deterministic ISO from box (your previous approach) ---
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5;

    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    const dist = Math.max(radius * 2.2, 15);

    const eye = center.clone().add(dir.clone().multiplyScalar(dist));
    const target = center.clone().add(dir.clone().multiplyScalar(-radius * 0.6));

    // clipping
    world.camera.three.near = Math.max(radius / 2000, 0.02);
    world.camera.three.far = Math.max(radius * 80, 8000);
    world.camera.three.updateProjectionMatrix();

    await world.camera.controls.setLookAt(
      eye.x, eye.y, eye.z,
      target.x, target.y, target.z,
      true
    );
  } catch (e) {
    console.warn("[Viewer] ISO start view failed; keeping fitToSphere pose", e);
  }

  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}




    _setActiveModel(model, modelId);
    viewerEvents.emit("modelLoaded", { modelId, model });
  });

  return { components, world, ifcLoader, fragments, hider, classifier };
}

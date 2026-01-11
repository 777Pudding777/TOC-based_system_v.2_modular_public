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
    const box = new THREE.Box3().setFromObject(model.object);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    world.camera.controls.fitToSphere(sphere, true);

    await new Promise(requestAnimationFrame);

    _setActiveModel(model, modelId);
    viewerEvents.emit("modelLoaded", { modelId, model });
  });

  return { components, world, ifcLoader, fragments, hider, classifier };
}

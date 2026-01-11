// src/viewer/state.ts
// activeModel, activeModelId, accessors, internal setters

import type { OBC } from "./types"; // optional; or just use any

let activeModel: any | null = null;
let activeModelId: string | null = null;

export function getActiveModel() {
  return activeModel;
}

export function getActiveModelId() {
  return activeModelId;
}

export function hasActiveModel() {
  return Boolean(activeModel && activeModelId);
}

/**
 * Internal setter (only viewer/init should call this).
 * We export it, but by convention treat it as internal.
 * If you want stricter enforcement, don’t export and instead expose a function in initViewer.
 */
export function _setActiveModel(model: any, modelId: string) {
  activeModel = model;
  activeModelId = modelId;
}

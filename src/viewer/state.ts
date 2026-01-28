// src/viewer/state.ts
// activeModel, activeModelId (string key), activeIfcModelId (numeric IFC handle), accessors, internal setters

let activeModel: any | null = null;

// This is your app-level model key (currently file name like "Solibri Building.ifc")
let activeModelId: string | null = null;

// This is the numeric handle used by ifcManager.getAllItemsOfType(...)
let activeIfcModelId: number | null = null;

// Optional IFC type index for the active model (type name => EXPRESS IDs)
let activeIfcTypeIndex: Record<string, number[]> | null = null;

export function getActiveIfcTypeIndex() {
  return activeIfcTypeIndex;
}

export function _setActiveIfcTypeIndex(index: Record<string, number[]> | null) {
  activeIfcTypeIndex = index;
}


export function getActiveModel() {
  return activeModel;
}

export function getActiveModelId() {
  return activeModelId;
}

export function getActiveIfcModelId() {
  return activeIfcModelId;
}

export function hasActiveModel() {
  return Boolean(activeModel && activeModelId);
}

/**
 * Internal setter (only viewer/init/upload should call this).
 * Keep string modelId stable for DB/UI; store numeric IFC model id for IFC queries.
 */
export function _setActiveModel(model: any, modelId: string, ifcModelId?: number | null) {
  activeModel = model;
  activeModelId = modelId;
  activeIfcModelId = ifcModelId ?? null;
  activeIfcTypeIndex = null; // ✅ clear on new model
}


/** Optional convenience for clearing state when model is unloaded */
export function _clearActiveModel() {
  activeModel = null;
  activeModelId = null;
  activeIfcModelId = null;
}

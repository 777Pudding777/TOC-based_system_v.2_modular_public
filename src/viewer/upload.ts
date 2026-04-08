// src/viewer/upload.ts
/**
 * IFC Upload helper (viewer-side).
 *
 * Why this exists:
 * - Keeps file input + IFC loading logic out of UI components.
 * - UI should only trigger "open dialog" and show messages.
 *
 * Critical assessment:
 * - We load IFC directly from ArrayBuffer -> Uint8Array to match your previous code.
 * - We keep the input hidden and programmatically click it (common practice).
 * - For security reasons, browsers require user interaction to open the file picker,
 *   so openFileDialog() MUST be called from a click handler.
 */

import { _setActiveIfcTypeIndex } from "./state";


export type ToastFn = (msg: string, ms?: number) => void;

export function createIfcUpload(params: {
  ifcLoader: any;
  viewerApi: { clearModel: () => Promise<void>; hasModelLoaded: () => boolean };
  toast?: ToastFn;
  onLoadingChange?: (isLoading: boolean) => void;

  // ✅ add this
  onModelLoaded?: (p: { model: any; modelId: string; ifcModelId: number | null }) => void;
}) {

  const { ifcLoader, viewerApi, toast, onLoadingChange } = params;

  let isLoading = false;

  function setLoading(v: boolean) {
    isLoading = v;
    onLoadingChange?.(v);
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".ifc";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  // Deterministic IFC model ID resolution helper
function resolveIfcModelIdDeterministic(ifcLoader: any, model: any): number | null {
  const asNum = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);

  // 1) common fields on returned model (including alt casings)
  const direct =
    asNum(model?.modelID) ??
    asNum(model?.modelId) ??
    asNum(model?.ifcModelId) ??
    asNum(model?.ifcID) ??
    asNum(model?.id) ??
    asNum(model?._id) ??
    asNum(model?.ifcMetadata?.modelID) ??
    asNum(model?.ifcMetadata?.modelId) ??
    null;
  if (direct != null) return direct;

  // 2) manager / api object (prototype methods not enumerable => access directly)
  const mgr: any = ifcLoader?.ifcManager;
  if (!mgr) return null;

  const mgrDirect =
    asNum(mgr.modelID) ??
    asNum(mgr.modelId) ??
    asNum(mgr.currentModelID) ??
    asNum(mgr.currentModelId) ??
    null;
  if (mgrDirect != null) return mgrDirect;

  // 3) state access via "in" (works even if getter/non-enumerable)
  const state = ("state" in mgr) ? mgr.state : null;
  if (state) {
    const stateDirect =
      asNum(state.modelID) ??
      asNum(state.modelId) ??
      asNum(state.currentModelID) ??
      asNum(state.currentModelId) ??
      null;
    if (stateDirect != null) return stateDirect;

    const models = (state as any).models;

    // array of models
    if (Array.isArray(models)) {
      for (let i = models.length - 1; i >= 0; i--) {
        const mid = asNum(models[i]?.modelID) ?? asNum(models[i]?.modelId) ?? asNum(models[i]?.id);
        if (mid != null) return mid;
      }
    }

    // map/object of models
    if (models && typeof models === "object") {
      const values = Object.values(models);
      for (const v of values) {
        const mid = asNum((v as any)?.modelID) ?? asNum((v as any)?.modelId) ?? asNum((v as any)?.id);
        if (mid != null) return mid;
      }
    }
  }

  return null;
}


// Build a lightweight IFC type index (type name => EXPRESS IDs) best-effort
async function buildIfcTypeIndexBestEffort(model: any): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};

  // Strategy A: model exposes a list of element IDs
  let ids: number[] =
    typeof model?.getAllExpressIds === "function"
      ? await model.getAllExpressIds()
      : Array.isArray(model?.expressIDs)
        ? model.expressIDs
        : [];

  // Strategy B: infer ids from model.properties map/object
  if (!ids.length) {
    const propsStore: any = model?.properties;
    if (propsStore instanceof Map) {
      ids = Array.from(propsStore.keys()).filter((x) => typeof x === "number" && isFinite(x));
    } else if (propsStore && typeof propsStore === "object") {
      ids = Object.keys(propsStore).map((k) => Number(k)).filter((x) => Number.isFinite(x));
    }
  }
  if (!ids.length) throw new Error("No way to enumerate express IDs.");

  // Deterministic iteration order
  ids.sort((a, b) => a - b);

  const readProps = async (id: number): Promise<any> => {
    if (typeof model?.getProperties === "function") {
      return await model.getProperties(id);
    }
    const propsStore: any = model?.properties;
    if (propsStore instanceof Map) return propsStore.get(id) ?? null;
    if (propsStore && typeof propsStore === "object") return propsStore[id] ?? propsStore[String(id)] ?? null;
    return null;
  };

  for (const id of ids) {
    const props = await readProps(id);
    const t =
      props?.type ??
      props?.ifcType ??
      props?.entity ??
      props?.Entity ??
      null;

    if (typeof t !== "string" || !t) continue;

    if (!out[t]) out[t] = [];
    out[t].push(id);
  }

  return out;
}


// Load IFC from a File object
  async function loadIfcFromFile(file: File) {
    setLoading(true);
    toast?.(`Loading IFC: ${file.name}`);

    try {
      if (viewerApi.hasModelLoaded()) {
        await viewerApi.clearModel();
      }

      const data = await file.arrayBuffer();
      const buffer = new Uint8Array(data);

      console.log("[IFC] starting load:", file.name, file.size);
const model = await ifcLoader.load(buffer, false, file.name);
// Loader shape debug (prototype-aware)
const loaderProto = Object.getPrototypeOf(ifcLoader);
console.log("[IFC] ifcLoader debug", {
  loaderOwnKeys: Object.getOwnPropertyNames(ifcLoader).slice(0, 120),
  loaderProtoKeys: loaderProto ? Object.getOwnPropertyNames(loaderProto).slice(0, 200) : [],
});

const ifcModelId = resolveIfcModelIdDeterministic(ifcLoader, model);

params.onModelLoaded?.({
  model,
  modelId: file.name,
  ifcModelId,
});

// Build a tiny IFC type index (best-effort, deterministic).
// If we can't build it, keep null and category isolation stays unavailable.
try {
  const index = await buildIfcTypeIndexBestEffort(model);
  _setActiveIfcTypeIndex(index);
  console.log("[IFC] type index built", Object.keys(index).slice(0, 10), "…");
} catch (e) {
  console.info("[IFC] type index not available in this build; category isolation may be limited.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcTypeIndex(null);
}


console.log("[IFC] loaded model ids", { modelId: file.name, ifcModelId });

// If still null, log *only* lightweight structural info (no huge objects)
if (ifcModelId == null) {
  const mgr: any = (ifcLoader as any)?.ifcManager;

  const mgrProto = mgr ? Object.getPrototypeOf(mgr) : null;
  const mgrProtoKeys = mgrProto ? Object.getOwnPropertyNames(mgrProto) : [];

  // Access state via "in" operator (works even if non-enumerable / getter)
  const hasState = mgr ? ("state" in mgr) : false;
  const stateVal = hasState ? (mgr as any).state : undefined;
  const stateProto = stateVal ? Object.getPrototypeOf(stateVal) : null;

  console.info("[IFC] numeric ifcModelId unavailable in this loader build (continuing). Debug:", {
    modelKeys: Object.getOwnPropertyNames(model ?? {}).slice(0, 80),
    modelProtoKeys: model ? Object.getOwnPropertyNames(Object.getPrototypeOf(model)).slice(0, 80) : [],
    ifcManagerType: mgr ? typeof mgr : "missing",
    ifcManagerProtoKeys: mgrProtoKeys.slice(0, 120),
    hasState,
    stateType: typeof stateVal,
    stateOwnKeys: stateVal ? Object.getOwnPropertyNames(stateVal).slice(0, 120) : [],
    stateProtoKeys: stateProto ? Object.getOwnPropertyNames(stateProto).slice(0, 120) : [],
    modelsType: stateVal ? typeof (stateVal as any).models : "no-state",
  });
}


// -------------------------------------------------------------------------------

      console.log("[IFC] finished load:", file.name);

      toast?.(`Loaded IFC: ${file.name}`);
    } catch (err) {
      console.error("[IFC] load failed", err);
      toast?.("IFC load failed. Check console for details.");
    } finally {
      fileInput.value = "";
      setLoading(false); // <-- only this (no extra onLoadingChange call)
    }
  }



// Open file dialog programmatically
  function openFileDialog() {
    if (isLoading) return;
    fileInput.click();
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await loadIfcFromFile(file);
  });

  return {
    openFileDialog,
    loadIfcFromFile,
    isLoading: () => isLoading,
  };
}

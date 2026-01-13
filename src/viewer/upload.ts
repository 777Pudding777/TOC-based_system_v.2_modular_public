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

export type ToastFn = (msg: string, ms?: number) => void;

export function createIfcUpload(params: {
  ifcLoader: any;
  viewerApi: { clearModel: () => Promise<void>; hasModelLoaded: () => boolean };
  toast?: ToastFn;
  onLoadingChange?: (isLoading: boolean) => void;
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
      await ifcLoader.load(buffer, false, file.name);
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

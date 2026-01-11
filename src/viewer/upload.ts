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
  toast?: ToastFn;
}) {
  const { ifcLoader, toast } = params;

  // Hidden input so the panel can trigger it.
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".ifc";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  /**
   * Load IFC from a File object.
   * Separated so you can reuse it later for drag&drop or remote fetching.
   */
  async function loadIfcFromFile(file: File) {
    toast?.(`Loading IFC: ${file.name}`);

    const data = await file.arrayBuffer();
    const buffer = new Uint8Array(data);

    console.log("[IFC] starting load:", file.name, file.size);

    // same call you used previously:
    // - second arg false: do not coordinate-to-origin? (depends on thatopen)
    // - third arg: model name
    await ifcLoader.load(buffer, false, file.name);

    console.log("[IFC] finished load:", file.name);
    toast?.(`Loaded IFC: ${file.name}`);

    // Important: allow selecting the same file again
    fileInput.value = "";
  }

  /**
   * Opens the file picker.
   * Must be called from a user gesture (button click).
   */
  function openFileDialog() {
    fileInput.click();
  }

  // When user picks a file, load it
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    console.log("[UI] fileInput change fired:", file?.name);

    if (!file) return;

    try {
      await loadIfcFromFile(file);
    } catch (err) {
      console.error("[IFC] load failed", err);
      toast?.("IFC load failed. Check console for details.");
      fileInput.value = "";
    }
  });

  return {
    openFileDialog,
    loadIfcFromFile, // exported for future drag/drop or tests
  };
}

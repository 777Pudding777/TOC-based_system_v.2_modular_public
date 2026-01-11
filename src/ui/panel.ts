// src/ui/panel.ts
// Minimal Panel UI (top-right).


import * as BUI from "@thatopen/ui";

/**
 * Minimal Panel UI (top-right).
 *
 * Design decisions:
 * - Uses ThatOpen UI components like your old version (bim-panel, bim-button).
 * - Stateless: it receives dependencies (viewerApi + upload) as parameters.
 * - This keeps UI independent of loader implementation details.
 *
 * Critical assessment:
 * - BUI.Manager.init() should be called once in main.ts (not here),
 *   to avoid accidental double-initialization when hot reloading.
 */

type ToastFn = (msg: string, ms?: number) => void;

export function mountPanel(params: {
  panelRoot: HTMLDivElement;
  viewerApi: {
    resetVisibility: () => Promise<void>;
  };
  upload: {
    openFileDialog: () => void;
  };
  toast?: ToastFn;
}) {
  const { panelRoot, viewerApi, upload } = params;

  // Clean previous mounts (Vite HMR can mount twice)
  panelRoot.innerHTML = "";

  const panel = BUI.Component.create(() => BUI.html`
    <bim-panel>
      <bim-panel-section label="Model">
        <bim-button
          label="Load local IFC"
          @click=${() => {
            console.log("[UI] Load button clicked");
            upload.openFileDialog();
          }}
        ></bim-button>

        <bim-button
          label="Reset visibility"
          @click=${async () => {
            await viewerApi.resetVisibility();
          }}
        ></bim-button>

        <div style="font-size: 12px; opacity: 0.8; margin-top: 6px;">
          Tip: Ctrl+click Storey/Space to isolate.
        </div>
      </bim-panel-section>
    </bim-panel>
  `);

  panelRoot.append(panel);
}

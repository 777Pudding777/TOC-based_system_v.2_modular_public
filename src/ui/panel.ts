// src/ui/panel.ts
import * as BUI from "@thatopen/ui";
import type { CameraPose } from "../viewer/api";
import type { VlmDecision } from "../modules/vlmChecker";

type ToastFn = (msg: string, ms?: number) => void;

export function mountPanel(params: {
  panelRoot: HTMLDivElement;

  viewerApi: {
    resetVisibility: () => Promise<void>;
    hasModelLoaded: () => boolean;
    setPresetView: (preset: "iso" | "top", smooth?: boolean) => Promise<void>;
    setCameraPose: (pose: CameraPose, smooth?: boolean) => Promise<void>;
  };

  upload: {
    openFileDialog: () => void;
    isLoading: () => boolean;
  };

  snapshotCollector: {
    capture: (note?: string, mode?: any) => Promise<any>;
    getRun: () => any;
    reset?: () => Promise<void>;
    db?: null | {
      listRuns: () => Promise<any[]>;
      listArtifacts: (runId: string) => Promise<any[]>;
      loadArtifact: (artifactId: string) => Promise<any>;
      clearAll?: () => Promise<void>;
    };
  };

  // VLM checker + decision DB
  vlmChecker: {
    adapterName: string;
    check: (input: { prompt: string; artifact: any }) => Promise<VlmDecision>;
  };

  complianceDb: {
    saveDecision: (runId: string, decision: VlmDecision) => Promise<void>;
    listDecisions: (runId: string) => Promise<VlmDecision[]>;
    clearAll: () => Promise<void>;
  };

  // ✅ NEW: orchestrator runner
  complianceRunner: {
    start: (p: {
      prompt: string;
      deterministic:
        | { enabled: false }
        | { enabled: true; mode: "iso" | "top" }
        | { enabled: true; mode: "custom"; pose: CameraPose };
      maxSteps?: number;
    }) => Promise<any>;
    parseCustomPose: (text: string) => CameraPose | null;
  };

  // ✅ Optional: navigationAgent only if you mounted it in main.ts
  navigationAgent?: {
    goToCurrentIsolateSelection: (opts?: { smooth?: boolean; padding?: number }) => Promise<any>;
  };

  toast?: ToastFn;
}) {
  const {
    panelRoot,
    viewerApi,
    upload,
    snapshotCollector,
    toast,
    vlmChecker,
    complianceDb,
    complianceRunner,
    navigationAgent,
  } = params;

  // Local UI state (PoC approach: keep in closure)
  let rulePrompt = "";
  let deterministicEnabled = false;
  let deterministicMode: "iso" | "top" | "custom" = "iso";
  let customPoseText = `{
  "eye": {"x": 0, "y": 10, "z": 20},
  "target": {"x": 0, "y": 0, "z": 0}
}`;

  // popup-safe image preview helper
  function openImageInNewTab(dataUrl: string): boolean {
    const win = window.open("about:blank", "_blank");
    if (!win) return false;

    const isValid = typeof dataUrl === "string" && dataUrl.startsWith("data:image/");
    win.document.open();
    win.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>Snapshot preview</title>
          <meta charset="utf-8"/>
          <style>
            html,body{margin:0;height:100%;background:#111;}
            .wrap{height:100%;display:flex;align-items:center;justify-content:center;}
            img{max-width:100%;max-height:100%;display:block;}
            .err{color:#fff;font-family:system-ui;padding:16px;}
          </style>
        </head>
        <body>
          <div class="wrap">
            ${isValid ? `<img src="${dataUrl}" alt="snapshot"/>` : `<div class="err">Invalid image data.</div>`}
          </div>
        </body>
      </html>
    `);
    win.document.close();
    return true;
  }

  function pickLatestBy<T>(items: T[], key: (x: T) => string | undefined): T | null {
    let best: T | null = null;
    let bestKey = "";
    for (const it of items) {
      const k = key(it) ?? "";
      if (k > bestKey) {
        bestKey = k;
        best = it;
      }
    }
    return best;
  }

  async function startComplianceCheck() {
    const hasModel = viewerApi.hasModelLoaded();
    if (!hasModel) return toast?.("Load a model first.");

    const prompt = (rulePrompt ?? "").trim();
    if (!prompt) return toast?.("Please enter a compliance rule / prompt.");

    // Build deterministic config
    let deterministic:
      | { enabled: false }
      | { enabled: true; mode: "iso" | "top" }
      | { enabled: true; mode: "custom"; pose: CameraPose } = { enabled: false };

    if (deterministicEnabled) {
      if (deterministicMode === "iso" || deterministicMode === "top") {
        deterministic = { enabled: true, mode: deterministicMode };
      } else {
        const pose = complianceRunner.parseCustomPose(customPoseText);
        if (!pose) return toast?.("Custom pose JSON invalid. Check format.");
        deterministic = { enabled: true, mode: "custom", pose };
      }
    }

    try {
      const res = await complianceRunner.start({
        prompt,
        deterministic,
        maxSteps: 6,
      });

      if (res?.ok === false) toast?.(`Compliance start failed: ${res.reason}`);
    } catch (e) {
      console.error(e);
      toast?.("Compliance error (see console).");
    }
  }

  function render() {
    panelRoot.innerHTML = "";

    const loading = upload.isLoading();
    const hasModel = viewerApi.hasModelLoaded();

    const loadLabel = loading
      ? "Loading…"
      : hasModel
        ? "Replace model (upload new)"
        : "Load local IFC";

    const panel = BUI.Component.create(() => BUI.html`
      <bim-panel>
        <bim-panel-section label="Model">
          <bim-button
            label=${loadLabel}
            ?disabled=${loading}
            @click=${() => {
              if (loading) return;
              upload.openFileDialog();
            }}
          ></bim-button>

          <bim-button
            label="ISO view"
            ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.setPresetView("iso", true)}
          ></bim-button>

          <bim-button
            label="Top view"
            ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.setPresetView("top", true)}
          ></bim-button>

          <bim-button
            label="Reset visibility"
            ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.resetVisibility()}
          ></bim-button>

          <div style="font-size:12px;margin-top:8px;color:#fff;opacity:0.9;text-shadow:0 1px 2px rgba(0,0,0,0.6);">
            Tip: <b>Ctrl+Click</b> Storey/Space in the tree to isolate.
          </div>
        </bim-panel-section>

        <bim-panel-section label="Compliance Checking">
          <div style="display:flex;flex-direction:column;gap:8px;">
            <textarea
              style="width:100%;min-height:92px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
              placeholder="Enter the compliance rule / prompt here…"
              @input=${(e: any) => { rulePrompt = e.target.value; }}
            >${rulePrompt}</textarea>

            <label style="display:flex;align-items:center;gap:8px;color:#fff;opacity:0.9;">
              <input
                type="checkbox"
                .checked=${deterministicEnabled}
                @change=${(e: any) => { deterministicEnabled = !!e.target.checked; render(); }}
              />
              Deterministic start
            </label>

            <div style="display:flex;gap:8px;align-items:center;">
              <span style="color:#fff;opacity:0.9;font-size:12px;">Start view:</span>
              <select
                style="flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                ?disabled=${!deterministicEnabled}
                @change=${(e: any) => { deterministicMode = String(e.target.value) as any; render(); }}
              >
                <option value="iso" ?selected=${deterministicMode === "iso"}>ISO</option>
                <option value="top" ?selected=${deterministicMode === "top"}>Top</option>
                <option value="custom" ?selected=${deterministicMode === "custom"}>Custom pose</option>
              </select>
            </div>

            ${
              deterministicEnabled && deterministicMode === "custom"
                ? BUI.html`
                  <textarea
                    style="width:100%;min-height:96px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"
                    @input=${(e: any) => { customPoseText = e.target.value; }}
                  >${customPoseText}</textarea>
                  <div style="color:#fff;opacity:0.75;font-size:11px;">
                    Expected: {"{"}"eye":{"{"}"x,y,z{"}"},"target":{"{"}"x,y,z{"}"}{"}"}
                  </div>
                `
                : null
            }

            <bim-button
              label=${`Start checking (${vlmChecker.adapterName})`}
              ?disabled=${loading || !hasModel}
              @click=${async () => startComplianceCheck()}
            ></bim-button>

            <div style="color:#fff;opacity:0.75;font-size:11px;">
              One rule per project: Start will reset state, then capture the first snapshot and run the checker.
            </div>
          </div>
        </bim-panel-section>

        <bim-panel-section label="Debug">
          <bim-button
            label="Capture snapshot"
            ?disabled=${loading || !hasModel}
            @click=${async () => {
              try {
                const a = await snapshotCollector.capture("manual");
                toast?.("Saved " + a.id);
                console.log("[Snapshot] captured artifact:", a);
              } catch (err) {
                console.error(err);
                toast?.("Snapshot capture failed (see console).");
              }
            }}
          ></bim-button>

          <bim-button
            label="List runs (console)"
            @click=${async () => {
              const db = snapshotCollector.db;
              if (!db) return toast?.("No DB attached.");
              const runs = await db.listRuns();
              console.log("[SnapshotDB] runs:", runs);
              toast?.("Runs: " + runs.length + " (see console)");
            }}
          ></bim-button>

          <bim-button
            label="Preview latest snapshot"
            ?disabled=${loading}
            @click=${async () => {
              try {
                const db = snapshotCollector.db;
                if (db) {
                  const runs = await db.listRuns();
                  if (runs.length) {
                    const latestRun = pickLatestBy(runs, (r) => r.startedIso) ?? runs[runs.length - 1];
                    const arts = await db.listArtifacts(latestRun.runId);
                    if (arts.length) {
                      const latestArt = pickLatestBy(arts, (a) => a.timestampIso) ?? arts[arts.length - 1];
                      const full = await db.loadArtifact(latestArt.artifactId);
                      const url = full?.images?.[0]?.imageBase64Png;
                      if (url) {
                        const ok = openImageInNewTab(url);
                        if (!ok) toast?.("Popup blocked. Allow popups.");
                        return;
                      }
                    }
                  }
                }

                const mem = snapshotCollector.getRun();
                if (mem?.artifacts?.length) {
                  const lastMem = mem.artifacts[mem.artifacts.length - 1];
                  const url = lastMem?.images?.[0]?.imageBase64Png;
                  if (url) {
                    const ok = openImageInNewTab(url);
                    if (!ok) toast?.("Popup blocked. Allow popups.");
                    return;
                  }
                }

                toast?.("No snapshots found.");
              } catch (err) {
                console.error(err);
                toast?.("Preview failed (see console).");
              }
            }}
          ></bim-button>

<bim-button
  label="Navigate to isolate selection"
  ?disabled=${loading || !hasModel || !navigationAgent}
  @click=${async () => {
    try {
      if (!navigationAgent) {
        toast?.("Navigation agent not attached.");
        return;
      }

      const res = await navigationAgent.goToCurrentIsolateSelection({
        smooth: true,
        padding: 1.25, // ✅ number
      });

      toast?.(res.ok ? `Navigation ok (${res.method})` : `Navigation failed: ${res.reason}`);
      console.log("[Navigation] result:", res);
    } catch (e) {
      console.error(e);
      toast?.("Navigation error (see console).");
    }
  }}
></bim-button>

<bim-button
  label="Clear DB (reset project)"
  @click=${async () => {
    try {
      if (snapshotCollector.db?.clearAll) await snapshotCollector.db.clearAll();
      await complianceDb.clearAll();
      if (snapshotCollector.reset) await snapshotCollector.reset();
      await viewerApi.resetVisibility();
      toast?.("Project reset: snapshots + decisions cleared.");
    } catch (err) {
      console.error(err);
      toast?.("Reset failed (see console).");
    }
  }}
></bim-button>

        </bim-panel-section>
      </bim-panel>
    `);

    panelRoot.append(panel);
  }

  render();
  return { rerender: render };
}

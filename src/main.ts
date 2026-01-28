import "./styles.css";

import * as BUI from "@thatopen/ui";

import { initViewer } from "./viewer/initViewer";
import { createViewerApi } from "./viewer/api";
import { createToast } from "./ui/toast";
import { mountTree } from "./ui/tree";
import { mountPanel } from "./ui/panel";
import { createIfcUpload } from "./viewer/upload";
import { createSnapshotCollector } from "./modules/snapshotCollector";
import { createSnapshotDb } from "./storage/snapshotDb";
import { createMockVlmAdapter, createVlmChecker, type VlmAdapter } from "./modules/vlmChecker";
import { createComplianceDb } from "./storage/complianceDb";
import { createNavigationAgent } from "./modules/navigationAgent";
import { createComplianceRunner } from "./modules/complianceRunner";
import { createOpenRouterVlmAdapter, type OpenRouterAdapterConfig } from "./modules/vlmAdapters/openrouter";
import { _setActiveModel } from "./viewer/state";


// ✅ add this import
import { createOpenAiVlmAdapter, type OpenAiAdapterConfig } from "./modules/vlmAdapters/openai";

// ---------- VLM adapter UI config (persisted) ----------
type VlmUiConfig =
  | { provider: "mock" }
  | { provider: "openai"; openai: Omit<OpenAiAdapterConfig, "apiKey"> & { apiKey?: string } }
  | { provider: "openrouter"; openrouter: Omit<OpenRouterAdapterConfig, "apiKey"> & { apiKey?: string } };


const VLM_CFG_KEY = "bimacc.vlmConfig.v1";

function loadVlmUiConfig(): VlmUiConfig {
  const keys = loadVlmKeys();

  try {
    const raw = localStorage.getItem(VLM_CFG_KEY);
    if (!raw) return { provider: "mock" };
    const parsed = JSON.parse(raw);

    if (parsed?.provider === "openai" && parsed?.openai?.model) {
      return {
        provider: "openai",
        openai: {
          apiKey: keys.openai ?? "",
          model: String(parsed.openai.model ?? ""),
          endpoint: parsed.openai.endpoint ? String(parsed.openai.endpoint) : undefined,
          imageDetail: parsed.openai.imageDetail ?? "high",
          requestTimeoutMs:
            typeof parsed.openai.requestTimeoutMs === "number" ? parsed.openai.requestTimeoutMs : undefined,
        },
      };
    }

    if (parsed?.provider === "openrouter" && parsed?.openrouter?.model) {
      return {
        provider: "openrouter",
        openrouter: {
          apiKey: keys.openrouter ?? "",
          model: String(parsed.openrouter.model ?? ""),
          endpoint: parsed.openrouter.endpoint ? String(parsed.openrouter.endpoint) : undefined,
          requestTimeoutMs:
            typeof parsed.openrouter.requestTimeoutMs === "number"
              ? parsed.openrouter.requestTimeoutMs
              : undefined,
          appTitle: parsed.openrouter.appTitle ? String(parsed.openrouter.appTitle) : undefined,
          appReferer: parsed.openrouter.appReferer ? String(parsed.openrouter.appReferer) : undefined,
          temperature: typeof parsed.openrouter.temperature === "number" ? parsed.openrouter.temperature : undefined,
          top_p: typeof parsed.openrouter.top_p === "number" ? parsed.openrouter.top_p : undefined,
          max_tokens: typeof parsed.openrouter.max_tokens === "number" ? parsed.openrouter.max_tokens : undefined,
        },
      };
    }

    return { provider: "mock" };
  } catch {
    return { provider: "mock" };
  }
}


function saveVlmUiConfig(cfg: VlmUiConfig) {
  // Never persist secrets to localStorage.
  if (cfg.provider === "openai") {
    const { apiKey, ...rest } = cfg.openai as any;
    localStorage.setItem(VLM_CFG_KEY, JSON.stringify({ provider: "openai", openai: rest }));
    saveVlmKeys({ ...loadVlmKeys(), openai: String(apiKey ?? "") });
    return;
  }

  if (cfg.provider === "openrouter") {
    const { apiKey, ...rest } = cfg.openrouter as any;
    localStorage.setItem(VLM_CFG_KEY, JSON.stringify({ provider: "openrouter", openrouter: rest }));
    saveVlmKeys({ ...loadVlmKeys(), openrouter: String(apiKey ?? "") });
    return;
  }

  localStorage.setItem(VLM_CFG_KEY, JSON.stringify(cfg));
}


// ---------- VLM adapter keys (session only) ----------
const VLM_KEYS_KEY = "bimacc.vlmKeys.v1";
type VlmKeys = { openai?: string; openrouter?: string };

function loadVlmKeys(): VlmKeys {
  try {
    const raw = sessionStorage.getItem(VLM_KEYS_KEY);
    return raw ? (JSON.parse(raw) as VlmKeys) : {};
  } catch {
    return {};
  }
}

function saveVlmKeys(keys: VlmKeys) {
  sessionStorage.setItem(VLM_KEYS_KEY, JSON.stringify(keys));
}

// On unload, persist any API keys from session to local (for UI convenience)

function buildAdapterFromConfig(cfg: VlmUiConfig): VlmAdapter {
  if (cfg.provider === "openai") {
    return createOpenAiVlmAdapter({
      ...cfg.openai,
      apiKey: String((cfg.openai as any).apiKey ?? ""),
    } as OpenAiAdapterConfig);
  }

  if (cfg.provider === "openrouter") {
    return createOpenRouterVlmAdapter({
      ...cfg.openrouter,
      apiKey: String((cfg.openrouter as any).apiKey ?? ""),
      // Sensible defaults for determinism
      temperature: (cfg.openrouter as any).temperature ?? 0,
      top_p: (cfg.openrouter as any).top_p ?? 1,
      max_tokens: (cfg.openrouter as any).max_tokens ?? 900,
      appTitle: (cfg.openrouter as any).appTitle ?? "BIM ACC",
      appReferer: (cfg.openrouter as any).appReferer ?? window.location.origin,
    } as OpenRouterAdapterConfig);
  }

  return createMockVlmAdapter();
}


// Application Initialization
BUI.Manager.init(); // do this immediately once

const viewerDiv = document.getElementById("viewer") as HTMLDivElement;
const treeRoot = document.getElementById("overlay-top-left") as HTMLDivElement;
const panelRoot = document.getElementById("overlay-top-right") as HTMLDivElement;
const toastRoot = document.getElementById("overlay-bottom-left") as HTMLDivElement;

const toast = createToast(toastRoot);

const ctx = await initViewer(viewerDiv);
(window as any).ifcLoader = ctx.ifcLoader;
(window as any).ifcManager = (ctx.ifcLoader as any)?.ifcManager;
const viewerApi = createViewerApi(ctx);

// Navigation Agent module initialization
const navigationAgent = createNavigationAgent({
  viewerApi,
  toast,
});
(window as any).navigationAgent = navigationAgent;

// Snapshot Collector and Storage DB module initialization
const snapshotDb = createSnapshotDb();

const snapshotCollector = createSnapshotCollector({
  viewerApi,
  toast,
  autoCaptureOnModelLoad: false,
  defaultMode: "RENDER_PLUS_JSON_METADATA",
  persistToIndexedDb: true,
});
snapshotCollector.start();
(window as any).snapshotCollector = snapshotCollector;

let panelHandle: { rerender: () => void } | null = null;

const upload = createIfcUpload({
  ifcLoader: ctx.ifcLoader,
  viewerApi,
  toast,
  onLoadingChange: () => panelHandle?.rerender(),
  onModelLoaded: ({ model, modelId, ifcModelId }) => {
    _setActiveModel(model, modelId, ifcModelId);
    console.log("[STATE] active model set", { modelId, ifcModelId });
  },
});


(window as any).snapshotDb = snapshotDb; // handy for debugging

// -------------------- ✅ VLM checker (mutable) --------------------
let vlmUiConfig: VlmUiConfig = loadVlmUiConfig();
let currentChecker = createVlmChecker(buildAdapterFromConfig(vlmUiConfig));

// Facade object stays stable for determinism + runner references.
// Swapping providers updates currentChecker, not references.
const vlmChecker = {
  get adapterName() {
    return currentChecker.adapterName;
  },
  async check(input: Parameters<typeof currentChecker.check>[0]) {
    return currentChecker.check(input);
  },
  // allow UI to swap provider/config deterministically
  setConfig(next: VlmUiConfig) {
    vlmUiConfig = next;
    saveVlmUiConfig(next);
    currentChecker = createVlmChecker(buildAdapterFromConfig(next));
  },
  getConfig() {
    return vlmUiConfig;
  },
};

(window as any).vlmChecker = vlmChecker;

// Compliance DB
const complianceDb = createComplianceDb();
(window as any).complianceDb = complianceDb;

// Compliance Runner module initialization
const complianceRunner = createComplianceRunner({
  viewerApi,
  snapshotCollector,
  // ✅ pass facade; runner keeps working if provider switches
  vlmChecker,
  complianceDb,
  navigationAgent, // optional
  toast,
});

(window as any).complianceRunner = complianceRunner;

// UI Mounting
panelHandle = mountPanel({
  panelRoot,
  viewerApi,
  upload,
  snapshotCollector,
  vlmChecker,
  complianceDb,
  complianceRunner,
  navigationAgent, // optional
  toast,
});

(window as any).viewerApi = viewerApi;

viewerApi.onModelLoaded(() => panelHandle?.rerender());
mountTree({ treeRoot, ctx, viewerApi, toast });

toast("Viewer booted");

console.log("[BOOT] app initialized", new Date().toISOString());



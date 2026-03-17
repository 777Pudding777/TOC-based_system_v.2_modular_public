// main.ts - Application entry point. Initializes viewer, modules, and UI components, and wires them together.
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

// Phase 1: New imports for rule management and inspection
import { createRuleDb } from "./storage/ruleDb";
import { createTraceDb } from "./storage/traceDb";
import { initializeRuleLibrary } from "./modules/ruleLoader";
import { validateEnvironment, getEnvironmentConfig } from "./config/environment";

// OpenAI adapter
import { createOpenAiVlmAdapter, type OpenAiAdapterConfig } from "./modules/vlmAdapters/openai";
import type { WebEvidenceRecord } from "./types/trace.types";

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
BUI.Manager.init();

// Phase 1: Validate environment configuration
const envValidation = validateEnvironment();
if (envValidation.warnings.length > 0) {
  console.warn("[ENV] Configuration warnings:", envValidation.warnings);
}
void getEnvironmentConfig();

const viewerDiv = document.getElementById("viewer") as HTMLDivElement;
const treeRoot = document.getElementById("overlay-top-left") as HTMLDivElement;
const panelRoot = document.getElementById("overlay-top-right") as HTMLDivElement;
const toastRoot = document.getElementById("overlay-bottom-left") as HTMLDivElement;

const toast = createToast(toastRoot);

const ctx = await initViewer(viewerDiv);
(window as any).ifcLoader = ctx.ifcLoader;
(window as any).ifcManager = (ctx.ifcLoader as any)?.ifcManager;
const viewerApi = createViewerApi(ctx);

// Navigation Agent
const navigationAgent = createNavigationAgent({ viewerApi, toast });
(window as any).navigationAgent = navigationAgent;

// Snapshot Collector and Storage DB
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

let panelHandle: { rerender: () => void; refreshRules?: () => Promise<void> } | null = null;

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

(window as any).snapshotDb = snapshotDb;

// Temporary in-memory store for web evidence collected during a run, to be included in trace and report outputs. Cleared on each new run.
let currentRunWebEvidence: WebEvidenceRecord[] = [];

function hasRunWebEvidenceForUrl(url: string): boolean {
  return currentRunWebEvidence.some((e) => e.ok && e.url === url);
}

// -------------------- VLM checker (mutable) --------------------
function createAppChecker(cfg: VlmUiConfig) {
  return createVlmChecker(buildAdapterFromConfig(cfg), {
    onWebEvidence: (entry) => {
      currentRunWebEvidence.push(entry);
      console.log("[WEB_EVIDENCE] pushed", {
        len: currentRunWebEvidence.length,
        url: entry.url,
        ok: entry.ok,
        via: entry.via,
      });
    },
    hasWebEvidenceForUrl: (url: string) => {
      const seen = currentRunWebEvidence.some((e) => e.ok && e.url === url);
      console.log("[WEB_EVIDENCE] hasUrl", { url, seen });
      return seen;
    },
    getProviderConfig: () => cfg,
  });
}

let vlmUiConfig: VlmUiConfig = loadVlmUiConfig();

let currentChecker = createAppChecker(vlmUiConfig);

const vlmChecker = {
  get adapterName() { return currentChecker.adapterName; },
  async check(input: Parameters<typeof currentChecker.check>[0]) {
    return currentChecker.check(input);
  },
  setConfig(next: VlmUiConfig) {
    vlmUiConfig = next;
    saveVlmUiConfig(next);
    currentChecker = createAppChecker(next);
  },
  resetRunWebEvidence() {
    currentRunWebEvidence = [];
    console.log("[WEB_EVIDENCE] reset");
  },
  getRunWebEvidence() {
    console.log("[WEB_EVIDENCE] get", currentRunWebEvidence.length);
    return [...currentRunWebEvidence];
  },
  getConfig() { return vlmUiConfig; },
};

(window as any).vlmChecker = vlmChecker;

// Compliance DB
const complianceDb = createComplianceDb();
(window as any).complianceDb = complianceDb;

// Phase 1: Rule Database and Trace Database
const ruleDb = createRuleDb();
const traceDb = createTraceDb();
(window as any).ruleDb = ruleDb;
(window as any).traceDb = traceDb;

// Initialize rule library on first run
initializeRuleLibrary(ruleDb).catch((e) => {
  console.error("[BOOT] Failed to initialize rule library:", e);
});

// Compliance Runner
const complianceRunner = createComplianceRunner({
  viewerApi,
  snapshotCollector,
  vlmChecker,
  complianceDb,
  navigationAgent,
  toast,
});

(window as any).complianceRunner = complianceRunner;

// ==================== UI Mounting ====================
// Mount a single unified panel with inspection features integrated
panelHandle = mountPanel({
  panelRoot,
  viewerApi,
  upload,
  snapshotCollector,
  vlmChecker,
  complianceDb,
  complianceRunner,
  navigationAgent,
  ruleDb,
  traceDb,
  toast,
});

(window as any).viewerApi = viewerApi;

viewerApi.onModelLoaded(() => panelHandle?.rerender());
mountTree({ treeRoot, ctx, viewerApi, toast });

// Refresh rules in panel after library initialization completes
setTimeout(async () => {
  try {
    await panelHandle?.refreshRules?.();
  } catch { /* ignore */ }
}, 1500);

toast("Viewer booted");

console.log("[BOOT] app initialized", new Date().toISOString());
console.log("[BOOT] Phase 1 modules loaded: ruleDb, traceDb, integrated inspection panel");

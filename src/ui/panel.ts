// src/ui/panel.ts
import * as BUI from "@thatopen/ui";
import type { CameraPose } from "../viewer/api";
import type { VlmDecision, VlmVerdict } from "../modules/vlmChecker";
import type { ComplianceRule } from "../types/rule.types";
import type {
  ConversationTrace,
  SceneState,
  SnapshotNoveltyMetrics,
  WebEvidenceRecord,
} from "../types/trace.types";
import type { RuleDb } from "../storage/ruleDb";
import type { TraceDb } from "../storage/traceDb";
import { downloadHtmlReport } from "../reporting/reportGenerator";
import { OPENROUTER_VISION_MODELS, getDefaultModel, findModelById } from "../config/openRouterModels";
import {
  getPrototypeRuntimeSettings,
  resetPrototypeRuntimeSettings,
  type PrototypeRuntimeSettings,
  updatePrototypeRuntimeSettings,
} from "../config/prototypeSettings";
import { deleteDatabase } from "../storage/dbConfig";
import { buildPromptFromRule } from "../modules/vlmAdapters/prompts/promptWrappers";
import type { CompactTaskGraphState } from "../modules/taskGraph";
import { runJudgeAgent } from "../modules/judgeAgent";

type ToastFn = (msg: string, ms?: number) => void;

function readSnapshotNoveltyMetrics(value: unknown): SnapshotNoveltyMetrics | undefined {
  return value && typeof value === "object" && "approximateNoveltyScore" in value
    ? (value as SnapshotNoveltyMetrics)
    : undefined;
}

type ComplianceDeterministicConfig =
  | { enabled: false }
  | { enabled: true; mode: "iso" | "top" }
  | { enabled: true; mode: "custom"; pose: CameraPose };

type QueuedComplianceTaskStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "stopped";

type QueuedComplianceTask = {
  id: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  status: QueuedComplianceTaskStatus;
  label: string;
  prompt: string;
  promptSource: "rule_library" | "custom_user_prompt";
  promptSourceLabel: string;
  sourceText: string;
  ruleSnapshot: ComplianceRule | null;
  deterministic: ComplianceDeterministicConfig;
  maxSteps: number;
  runtimeSettings: PrototypeRuntimeSettings;
  vlmProvider: "mock" | "openai" | "openrouter";
  vlmAdapterName: string;
  modelId: string;
  vlmConfig: any;
  traceId?: string;
  verdict?: VlmVerdict;
  error?: string;
};

export function mountPanel(params: {
  panelRoot: HTMLDivElement;

  viewerApi: {
    resetVisibility: () => Promise<void>;
    hasModelLoaded: () => boolean;
    setPresetView: (preset: "iso" | "top", smooth?: boolean) => Promise<void>;
    setCameraPose: (pose: CameraPose, smooth?: boolean) => Promise<void>;
    isolate?: (map: Record<string, Set<number>>) => Promise<void>;
    isolateStorey?: (storeyId: string) => Promise<any>;
    isolateSpace?: (spaceId: string) => Promise<any>;
    isolateCategory?: (category: string) => Promise<any>;
    hideIds?: (ids: string[]) => Promise<void>;
    clearPlanCut?: () => Promise<void>;
    setPlanCut?: (p: {
      height?: number;
      absoluteHeight?: number;
      thickness?: number;
      mode?: "WORLD_UP" | "CAMERA";
      source?: "relative" | "absolute" | "highlight-top";
      storeyId?: string;
    }) => Promise<void>;
    getRendererDomElement?: () => HTMLCanvasElement;
    pickObjectAt?: (x: number, y: number) => Promise<string | null>;
    highlightIds?: (ids: string[], style?: "primary" | "warn") => Promise<void>;
    onModelLoaded?: (cb: (payload: any) => void) => () => void;
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
  check: (input: { prompt: string; artifacts: any[]; evidenceViews: any[] }) => Promise<VlmDecision>;
  setConfig: (cfg: any) => void;
  getConfig: () => any;
  resetRunWebEvidence: () => void;
  getRunWebEvidence: () => WebEvidenceRecord[];
};

  complianceDb: {
    saveDecision: (runId: string, decision: VlmDecision) => Promise<void>;
    listDecisions: (runId: string) => Promise<VlmDecision[]>;
    clearAll: () => Promise<void>;
  };

  complianceRunner: {
    start: (p: {
      prompt: string;
      deterministic:
        | { enabled: false }
        | { enabled: true; mode: "iso" | "top" }
        | { enabled: true; mode: "custom"; pose: CameraPose };
      maxSteps?: number;
      shouldStop?: () => "continue" | "stop" | "skip";
      onStep?: (step: number, decision: VlmDecision) => void;
      onProgress?: (update: {
        stage: "starting" | "seeded" | "captured" | "decision" | "followup" | "finished";
        step: number;
        summary: string;
        taskGraph?: CompactTaskGraphState;
        lastActionReason?: string | null;
        verdict?: VlmDecision["verdict"];
        confidence?: number;
        thinking?: string;
        followUpSummary?: string;
      }) => void;
    }) => Promise<any>;
    getNavigationActions?: () => ConversationTrace["navigationActions"];
    parseCustomPose: (text: string) => CameraPose | null;
  };

  navigationAgent?: {
    goToCurrentIsolateSelection: (opts?: any) => Promise<any>;
  };

  // Phase 1: Rule and Trace databases for inspection integration
  ruleDb: RuleDb;
  traceDb: TraceDb;

  toast?: ToastFn;
}) {
  const {
    panelRoot,
    viewerApi,
    upload,
    snapshotCollector,
    toast,
    vlmChecker,
    complianceRunner,
    navigationAgent,
    ruleDb,
    traceDb,
  } = params;

  panelRoot.classList.add("hud-panel-root");
  const viewerOverlayHost = panelRoot.parentElement;
  let bottomDockRoot = viewerOverlayHost?.querySelector("#overlay-bottom-center") as HTMLDivElement | null;
  if (!bottomDockRoot && viewerOverlayHost) {
    bottomDockRoot = document.createElement("div");
    bottomDockRoot.id = "overlay-bottom-center";
    viewerOverlayHost.appendChild(bottomDockRoot);
  }

  // ───────────────── Local UI state ─────────────────
  let rulePrompt = "";
  let deterministicEnabled = true;
  let deterministicMode: "iso" | "top" | "custom" = "iso";
  let customPoseText = `{
  "eye": {"x": 0, "y": 10, "z": 20},
  "target": {"x": 0, "y": 0, "z": 0}
}`;

  // VLM provider config
  let vlmProvider: "mock" | "openai" | "openrouter" = "mock";
  let openAiApiKey = "";
  let openAiModel = "gpt-4.1-mini";
  let openAiEndpoint = "";

  let openRouterApiKey = "";
  let openRouterModel = getDefaultModel().id;
  let openRouterStatus:
    | { state: "idle" }
    | { state: "checking" }
    | { state: "valid"; label: string; summary: string; remaining: string | null; used: string | null; limit: string | null; checkedAtIso: string }
    | { state: "invalid"; error: string; checkedAtIso: string } = { state: "idle" };

  let openRouterAutoRefresh = true;
  let openRouterLastKeyForStatus = "";
  const modelLoadedAtMount = viewerApi.hasModelLoaded();
  let vlmProviderOpen = modelLoadedAtMount;
  let complianceCheckingOpen = modelLoadedAtMount;
  let debugOpen = false;
  let modelSectionsAutoOpened = modelLoadedAtMount;

  // ───────────────── Inspection state ─────────────────
  type InspectionStatus = "idle" | "running" | "completed" | "failed";
  type InspectionPhase = "idle" | "checking" | "generating_report";
  let inspectionStatus: InspectionStatus = "idle";
  let inspectionPhase: InspectionPhase = "idle";
  let inspectionStep = 0;
  let prototypeRuntimeSettings = getPrototypeRuntimeSettings();
  let inspectionMaxSteps = prototypeRuntimeSettings.maxComplianceSteps;
  let prototypeSettingsOpen = false;
  let inspectionHistoryOpen = false;
  let inspectionTrace: ConversationTrace | null = null;
  let inspectionSceneStepIndex = -1;
  let inspectionError: string | null = null;
  let inspectionStartTime: number | null = null;
  let inspectionDecisions: VlmDecision[] = [];
  let inspectionTaskHud: CompactTaskGraphState | null = null;
  let inspectionLiveFeed: string[] = [];
  let inspectionThinking = "";
  let inspectionFollowUpDone = "";
  let complianceQueue: QueuedComplianceTask[] = [];
  let queueProcessing = false;
  let activeRunInterruption: "continue" | "stop" | "skip" = "continue";
  let debugPickModeEnabled = false;
  let debugPickListenerAttached = false;
  function getPromptTextForReport(decision: VlmDecision, fallbackPrompt: string): string {  
   const adapterPrompt = decision.meta?.adapterPromptText?.trim();
   if (adapterPrompt) return adapterPrompt;
   const composedPrompt = decision.meta?.composedPromptText?.trim();
   if (composedPrompt) return composedPrompt;
   return fallbackPrompt;
  }

  function getComplianceTokensUsed(decisions: VlmDecision[]): number {
    return decisions.reduce((sum, decision) => {
      const usage = decision.meta?.tokenUsage;
      if (!usage) return sum;
      const total =
        usage.totalTokens ??
        (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number"
          ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
          : 0);
      return sum + (Number.isFinite(total) ? total : 0);
    }, 0);
  }

  function toMaxTwoSentences(text: string | null | undefined): string {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    const parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [normalized];
    return parts.slice(0, 2).join(" ").trim();
  }

  // Rule library state
  let rules: ComplianceRule[] = [];
  let selectedRule: ComplianceRule | null = null;
  let ruleInputMode: "library" | "custom" = "custom"; // default to custom so existing behavior preserved

  // Recent traces
  let recentTraces: ConversationTrace[] = [];

  // ───────────────── Load rules and traces ─────────────────
  async function loadRules() {
    try {
      rules = (await ruleDb.listEnabledRules()).slice().sort((a, b) => {
        const categoryCmp = a.category.localeCompare(b.category);
        if (categoryCmp !== 0) return categoryCmp;
        return a.title.localeCompare(b.title);
      });
      if (selectedRule) {
        selectedRule = rules.find((rule) => rule.id === selectedRule?.id) ?? null;
      }
    } catch (e) {
      console.error("[Panel] Failed to load rules:", e);
      rules = [];
      selectedRule = null;
    }
  }

  async function loadTraces() {
    try {
      recentTraces = await traceDb.listRecentTraces(5);
    } catch (e) {
      console.error("[Panel] Failed to load traces:", e);
      recentTraces = [];
    }
  }

  // Initialize rules and traces
  void (async () => {
    await loadRules();
    await loadTraces();
    render();
  })();

  viewerApi.onModelLoaded?.(() => {
    if (!modelSectionsAutoOpened) {
      vlmProviderOpen = true;
      complianceCheckingOpen = true;
      modelSectionsAutoOpened = true;
      render();
    }
    return () => {};
  });

  // ───────────────── VLM config helpers ─────────────────
  function loadVlmCfgFromFacade() {
    const cfg = vlmChecker.getConfig?.();
    if (cfg?.provider === "openai") {
      vlmProvider = "openai";
      openAiApiKey = String(cfg.openai?.apiKey ?? "");
      openAiModel = String(cfg.openai?.model ?? openAiModel);
      openAiEndpoint = String(cfg.openai?.endpoint ?? "");
      return;
    }
    if (cfg?.provider === "openrouter") {
      vlmProvider = "openrouter";
      openRouterApiKey = String(cfg.openrouter?.apiKey ?? "");
      openRouterModel = String(cfg.openrouter?.model ?? openRouterModel);
      return;
    }
    vlmProvider = "mock";
  }
  loadVlmCfgFromFacade();

  // Auto-refresh OpenRouter budget every 60s
  window.setInterval(() => {
    if (!openRouterAutoRefresh) return;
    if (vlmProvider !== "openrouter") return;
    const k = (openRouterApiKey ?? "").trim();
    if (!k) return;
    if (openRouterLastKeyForStatus && openRouterLastKeyForStatus !== k) return;
    if (openRouterStatus.state === "checking") return;
    void validateOpenRouterKey(k);
  }, 60_000);

  function formatOpenRouterBudget(json: any): { label: string; summary: string; remaining: string | null; used: string | null; limit: string | null } {
    const data = json?.data ?? json;
    const name = String(data?.label ?? data?.name ?? data?.key?.label ?? "OpenRouter key");
    const used = data?.usage?.toString?.() ?? data?.usage ?? data?.total_usage ?? data?.spent ?? null;
    const limit = data?.limit?.toString?.() ?? data?.limit ?? data?.spend_limit ?? null;
    const remaining = data?.remaining?.toString?.() ?? data?.remaining ?? data?.limit_remaining ?? data?.credits_remaining ?? null;
    const parts: string[] = [];
    if (remaining != null) parts.push(`Remaining: ${remaining}`);
    if (used != null) parts.push(`Used: ${used}`);
    if (limit != null) parts.push(`Limit: ${limit}`);
    return {
      label: name,
      summary: parts.length ? parts.join(" | ") : "Key is valid (budget fields unavailable).",
      remaining: remaining != null ? String(remaining) : null,
      used: used != null ? String(used) : null,
      limit: limit != null ? String(limit) : null,
    };
  }

  function parseNumeric(value: unknown): number | null {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  async function fetchOpenRouterUsageValue(key: string): Promise<number | null> {
    const k = (key ?? "").trim();
    if (!k) return null;
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
        method: "GET",
        headers: { Authorization: `Bearer ${k}` },
      });
      if (!resp.ok) return null;
      const json = await resp.json().catch(() => null);
      const data = json?.data ?? json;
      return (
        parseNumeric(data?.usage) ??
        parseNumeric(data?.total_usage) ??
        parseNumeric(data?.spent) ??
        null
      );
    } catch {
      return null;
    }
  }

  async function validateOpenRouterKey(key: string) {
    const k = (key ?? "").trim();
    if (!k) {
      openRouterStatus = { state: "invalid", error: "Missing API key.", checkedAtIso: new Date().toISOString() };
      render();
      return;
    }
    openRouterStatus = { state: "checking" };
    openRouterLastKeyForStatus = k;
    render();
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
        method: "GET",
        headers: { Authorization: `Bearer ${k}` },
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = json?.error?.message ?? json?.message ?? `Request failed (${resp.status}).`;
        openRouterStatus = { state: "invalid", error: String(msg), checkedAtIso: new Date().toISOString() };
        render();
        return;
      }
      const { label, summary, remaining, used, limit } = formatOpenRouterBudget(json);
      openRouterStatus = { state: "valid", label, summary, remaining, used, limit, checkedAtIso: new Date().toISOString() };
      render();
    } catch (e: any) {
      openRouterStatus = {
        state: "invalid",
        error: e?.name === "AbortError" ? "Request timed out." : "Network error while validating key.",
        checkedAtIso: new Date().toISOString(),
      };
      render();
    }
  }

  async function applySelectedVlmProvider(options?: { silent?: boolean }) {
    try {
      if (vlmProvider === "openrouter") {
        const k = (openRouterApiKey ?? "").trim();
        if (!k) {
          toast?.("OpenRouter key missing.");
          return false;
        }
        if (openRouterStatus.state !== "valid" || openRouterLastKeyForStatus !== k) {
          await validateOpenRouterKey(k);
        }
        if (openRouterStatus.state !== "valid" || openRouterLastKeyForStatus !== k) {
          toast?.("OpenRouter key invalid. Fix and try again.");
          return false;
        }
        vlmChecker.setConfig({
          provider: "openrouter",
          openrouter: {
            apiKey: k,
            model: (openRouterModel ?? "").trim(),
            maxImages: prototypeRuntimeSettings.maxSnapshotsPerRequest,
          },
        });
      } else if (vlmProvider === "openai") {
        vlmChecker.setConfig({
          provider: "openai",
          openai: {
            apiKey: openAiApiKey,
            model: openAiModel,
            endpoint: openAiEndpoint || undefined,
            imageDetail: "high",
            requestTimeoutMs: 90_000,
          },
        });
      } else {
        vlmChecker.setConfig({ provider: "mock" });
      }
      if (!options?.silent) {
        toast?.(`VLM provider set: ${vlmChecker.adapterName}`);
      }
      render();
      return true;
    } catch (e) {
      console.error(e);
      toast?.("Failed to apply provider (see console).");
      return false;
    }
  }

  // ───────────────── Image / helpers ─────────────────
  function ensureDataImageUrl(maybeBase64OrDataUrl: string): string | null {
    const s = String(maybeBase64OrDataUrl ?? "").trim();
    if (!s) return null;
    if (s.startsWith("data:image/")) return s;
    const cleaned = s.replace(/\s+/g, "");
    return `data:image/png;base64,${cleaned}`;
  }

  function openImageInNewTab(dataUrl: string): boolean {
    const win = window.open("about:blank", "_blank");
    if (!win) return false;
    const normalized = ensureDataImageUrl(dataUrl);
    const isValid = !!normalized;
    win.document.open();
    win.document.write(`<!doctype html><html><head><title>Snapshot preview</title><meta charset="utf-8"/>
      <style>html,body{margin:0;height:100%;background:#111;}.wrap{height:100%;display:flex;align-items:center;justify-content:center;}
      img{max-width:100%;max-height:100%;display:block;}.err{color:#fff;font-family:system-ui;padding:16px;}</style></head><body>
      <div class="wrap">${isValid ? `<img src="${normalized}" alt="snapshot"/>` : `<div class="err">Invalid image data.</div>`}</div></body></html>`);
    win.document.close();
    return true;
  }

  function pickLatestBy<T>(items: T[], key: (x: T) => string | undefined): T | null {
    let best: T | null = null;
    let bestKey = "";
    for (const it of items) {
      const k = key(it) ?? "";
      if (k > bestKey) { bestKey = k; best = it; }
    }
    return best;
  }

  function setDebugPickMode(enabled: boolean) {
    debugPickModeEnabled = enabled;
    const canvas = viewerApi.getRendererDomElement?.();
    if (!canvas || !viewerApi.pickObjectAt || !viewerApi.highlightIds) return;

    if (!enabled && debugPickListenerAttached) {
      canvas.removeEventListener("click", onDebugPickClick);
      debugPickListenerAttached = false;
      return;
    }

    if (enabled && !debugPickListenerAttached) {
      canvas.addEventListener("click", onDebugPickClick);
      debugPickListenerAttached = true;
    }
  }

  async function onDebugPickClick(ev: MouseEvent) {
    if (!debugPickModeEnabled) return;
    const canvas = viewerApi.getRendererDomElement?.();
    if (!canvas || !viewerApi.pickObjectAt || !viewerApi.highlightIds) return;

    try {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const id = await viewerApi.pickObjectAt(x, y);
      if (!id) {
        toast?.("Debug pick: no object.");
        return;
      }
      await viewerApi.highlightIds([id], "warn");
      toast?.(`Debug pick highlighted: ${id}`);
      console.log("[DebugPick] highlighted", { id, x, y });
    } catch (error) {
      console.error("[DebugPick] failed", error);
      toast?.("Debug pick failed (see console).");
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}m ${secs}s`;
  }

  function formatTraceTimestamp(iso?: string): string {
    if (!iso) return "Unknown time";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function getSceneStates(trace: ConversationTrace | null | undefined): SceneState[] {
    if (!trace?.sceneStates?.length) return [];
    return trace.sceneStates.filter((state) => !!state?.cameraPose);
  }

  function clampSceneStepIndex(trace: ConversationTrace | null | undefined, requested?: number): number {
    const states = getSceneStates(trace);
    if (!states.length) return -1;
    if (typeof requested !== "number" || Number.isNaN(requested)) return states.length - 1;
    return Math.max(0, Math.min(states.length - 1, requested));
  }

  function syncSceneStepIndex(trace: ConversationTrace | null | undefined, requested?: number) {
    inspectionSceneStepIndex = clampSceneStepIndex(trace, requested);
  }

  function describeSceneState(state: SceneState | undefined): string[] {
    if (!state) return [];
    const details: string[] = [];
    if (state.viewPreset) details.push(`View: ${state.viewPreset.toUpperCase()}`);
    if (state.isolatedStorey) details.push(`Storey: ${state.isolatedStorey}`);
    if (state.isolatedSpace) details.push(`Space: ${state.isolatedSpace}`);
    if (state.isolatedIds?.length) details.push(`Isolated: ${state.isolatedIds.length}`);
    if (state.isolatedCategories?.length) details.push(`Categories: ${state.isolatedCategories.join(", ")}`);
    if (state.highlightedIds?.length) details.push(`Highlights: ${state.highlightedIds.length}`);
    if (state.hiddenIds?.length) details.push(`Hidden: ${state.hiddenIds.length}`);
    if (state.planCut?.absoluteHeight != null || state.planCut?.height != null) {
      const mode = state.planCut.mode ? `${state.planCut.mode}` : "active";
      details.push(`Cut: ${mode}`);
    }
    return details;
  }

  function buildModelIdMapFromObjectIds(ids: string[]): Record<string, Set<number>> {
    const map: Record<string, Set<number>> = {};
    for (const raw of ids ?? []) {
      const [modelId, localIdText] = String(raw).split(":");
      const localId = Number(localIdText);
      if (!modelId || !Number.isFinite(localId)) continue;
      (map[modelId] ??= new Set<number>()).add(localId);
    }
    return map;
  }

  async function restoreSceneState(trace: ConversationTrace, sceneIndex: number) {
    const states = getSceneStates(trace);
    const nextIndex = clampSceneStepIndex(trace, sceneIndex);
    const state = states[nextIndex];
    if (!state) return;

    try {
      await viewerApi.resetVisibility();

      if (state.isolatedIds?.length && viewerApi.isolate) {
        const isolateMap = buildModelIdMapFromObjectIds(state.isolatedIds);
        if (Object.keys(isolateMap).length) {
          await viewerApi.isolate(isolateMap);
        }
      } else if (state.isolatedStorey && viewerApi.isolateStorey) {
        await viewerApi.isolateStorey(state.isolatedStorey);
      } else if (state.isolatedSpace && viewerApi.isolateSpace) {
        await viewerApi.isolateSpace(state.isolatedSpace);
      } else if (state.isolatedCategories?.length && viewerApi.isolateCategory) {
        await viewerApi.isolateCategory(state.isolatedCategories[0]);
      }

      if (state.hiddenIds?.length && viewerApi.hideIds) {
        await viewerApi.hideIds(state.hiddenIds);
      }

      await viewerApi.setCameraPose(state.cameraPose, true);

      if (state.planCut?.enabled !== false && state.planCut?.absoluteHeight != null && viewerApi.setPlanCut) {
        await viewerApi.setPlanCut({
          absoluteHeight: state.planCut.absoluteHeight,
          height: state.planCut.height,
          thickness: state.planCut.thickness,
          mode: state.planCut.mode === "CAMERA" ? "CAMERA" : "WORLD_UP",
          source:
            state.planCut.source === "relative" ||
            state.planCut.source === "absolute" ||
            state.planCut.source === "highlight-top"
              ? state.planCut.source
              : undefined,
          storeyId: state.planCut.storeyId,
        });
      } else if (viewerApi.clearPlanCut) {
        await viewerApi.clearPlanCut();
      }

      if (viewerApi.highlightIds) {
        await viewerApi.highlightIds(state.highlightedIds ?? [], "primary");
      }

      inspectionSceneStepIndex = nextIndex;
      render();
    } catch (error) {
      console.error("[Panel] Failed to restore scene state", error);
      toast?.("Could not restore that inspection step.");
    }
  }

  async function loadInspectionTrace(traceId: string) {
    const fullTrace = await traceDb.getTrace(traceId);
    if (!fullTrace) {
      toast?.("Could not open that inspection trace.");
      return;
    }
    inspectionTrace = fullTrace;
    inspectionStatus = fullTrace.status === "completed" ? "completed" : "failed";
    inspectionError = fullTrace.errorMessage ?? null;
    syncSceneStepIndex(fullTrace);
    render();
    if (getSceneStates(fullTrace).length) {
      await restoreSceneState(fullTrace, inspectionSceneStepIndex);
    }
  }

  function verdictBadgeHtml(verdict?: VlmVerdict): string {
    const colors: Record<string, string> = { PASS: "#22c55e", FAIL: "#ef4444", UNCERTAIN: "#f59e0b" };
    const color = verdict ? colors[verdict] : "#6b7280";
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${verdict ?? "PENDING"}</span>`;
  }

  function queueStatusBadgeHtml(status: QueuedComplianceTaskStatus): string {
    const colors: Record<QueuedComplianceTaskStatus, string> = {
      queued: "#6366f1",
      running: "#3b82f6",
      completed: "#22c55e",
      failed: "#ef4444",
      skipped: "#f59e0b",
      stopped: "#fb7185",
    };
    return `<span style="background:${colors[status]};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${status.toUpperCase()}</span>`;
  }

  // ───────────────── Build VLM prompt from rule ─────────────────
  function buildCoupledPrompt(args: {
    source: "rule_library" | "custom_user_prompt";
    sourceLabel: string;
    sourceText: string;
    rule?: ComplianceRule | null;
  }): string {
    const header =
      args.source === "rule_library"
        ? [
            "INSPECTION_INPUT_CONTEXT:",
            "SOURCE: RULE_LIBRARY",
            `RULE_ID: ${args.rule?.id ?? "unknown"}`,
            `RULE_TITLE: ${args.rule?.title ?? args.sourceLabel}`,
            `RULE_CATEGORY: ${args.rule?.category ?? "unknown"}`,
            `RULE_SEVERITY: ${args.rule?.severity ?? "unknown"}`,
          ]
        : [
            "INSPECTION_INPUT_CONTEXT:",
            "SOURCE: CUSTOM_USER_PROMPT",
            `PROMPT_LABEL: ${args.sourceLabel}`,
          ];

    return [...header, "", "SOURCE_PROMPT_TEXT:", args.sourceText].join("\n");
  }

  function updatePrototypeSetting(key: keyof typeof prototypeRuntimeSettings, rawValue: unknown) {
    const value = Number(rawValue);
    prototypeRuntimeSettings = updatePrototypeRuntimeSettings({ [key]: value });
    inspectionMaxSteps = prototypeRuntimeSettings.maxComplianceSteps;
    render();
  }

  function resetPrototypeSettings() {
    prototypeRuntimeSettings = resetPrototypeRuntimeSettings();
    inspectionMaxSteps = prototypeRuntimeSettings.maxComplianceSteps;
    render();
    toast?.("Prototype settings reset to file defaults.");
  }

  function syncRuntimeSettingsToVlmConfig() {
    const cfg = vlmChecker.getConfig?.();
    if (cfg?.provider !== "openrouter") return;
    vlmChecker.setConfig({
      ...cfg,
      openrouter: {
        ...cfg.openrouter,
        maxImages: prototypeRuntimeSettings.maxSnapshotsPerRequest,
      },
    });
  }


  // ───────────────── Compliance check (enhanced) ─────────────────
  function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value ?? null));
  }

  function buildComplianceTaskFromCurrentSettings(status: QueuedComplianceTaskStatus): QueuedComplianceTask | null {
    let prompt = "";
    let promptSource: "rule_library" | "custom_user_prompt" = "custom_user_prompt";
    let promptSourceLabel = "Custom Prompt";
    let sourceText = "";
    const ruleSnapshot = selectedRule ? cloneJson(selectedRule) : null;

    if (ruleInputMode === "library" && selectedRule) {
      sourceText = buildPromptFromRule(selectedRule);
      promptSource = "rule_library";
      promptSourceLabel = selectedRule.title;
      prompt = buildCoupledPrompt({
        source: "rule_library",
        sourceLabel: selectedRule.title,
        sourceText,
        rule: selectedRule,
      });
    } else {
      sourceText = (rulePrompt ?? "").trim();
      prompt = buildCoupledPrompt({
        source: "custom_user_prompt",
        sourceLabel: "Custom Prompt",
        sourceText,
      });
    }
    if (!sourceText) {
      toast?.("Please select a rule or enter a compliance prompt.");
      return null;
    }

    let deterministic: ComplianceDeterministicConfig = { enabled: false };
    if (deterministicEnabled) {
      if (deterministicMode === "iso" || deterministicMode === "top") {
        deterministic = { enabled: true, mode: deterministicMode };
      } else {
        const pose = complianceRunner.parseCustomPose(customPoseText);
        if (!pose) {
          toast?.("Custom pose JSON invalid. Check format.");
          return null;
        }
        deterministic = { enabled: true, mode: "custom", pose };
      }
    }

    const runtimeSettings = getPrototypeRuntimeSettings();
    const vlmConfig = cloneJson(vlmChecker.getConfig?.() ?? { provider: "mock" });
    const taskProvider =
      vlmConfig?.provider === "openrouter" || vlmConfig?.provider === "openai" || vlmConfig?.provider === "mock"
        ? vlmConfig.provider
        : vlmProvider;
    const modelId =
      taskProvider === "openrouter"
        ? String(vlmConfig?.openrouter?.model ?? openRouterModel)
        : taskProvider === "openai"
          ? String(vlmConfig?.openai?.model ?? openAiModel)
          : "mock";
    return {
      id: crypto.randomUUID(),
      queuedAt: new Date().toISOString(),
      status,
      label: promptSource === "rule_library" ? promptSourceLabel : sourceText.slice(0, 80) || "Custom Prompt",
      prompt,
      promptSource,
      promptSourceLabel,
      sourceText,
      ruleSnapshot,
      deterministic,
      maxSteps: runtimeSettings.maxComplianceSteps,
      runtimeSettings,
      vlmProvider: taskProvider,
      vlmAdapterName: vlmChecker.adapterName,
      modelId,
      vlmConfig,
    };
  }

  function applyTaskSettings(task: QueuedComplianceTask) {
    prototypeRuntimeSettings = updatePrototypeRuntimeSettings(task.runtimeSettings);
    inspectionMaxSteps = task.maxSteps;
    vlmProvider = task.vlmProvider;
    if (task.vlmProvider === "openrouter") openRouterModel = task.modelId;
    if (task.vlmProvider === "openai") openAiModel = task.modelId;
    if (task.vlmConfig) vlmChecker.setConfig(task.vlmConfig);
    syncRuntimeSettingsToVlmConfig();
  }

  function describeTaskStart(task: QueuedComplianceTask): string {
    if (!task.deterministic.enabled) return "Start view: adaptive";
    if (task.deterministic.mode === "custom") return "Start view: custom pose";
    return `Start view: ${task.deterministic.mode.toUpperCase()}`;
  }

  function queueComplianceTask() {
    if (!viewerApi.hasModelLoaded()) return toast?.("Load a model first.");
    const task = buildComplianceTaskFromCurrentSettings("queued");
    if (!task) return;
    complianceQueue = [...complianceQueue, task];
    inspectionHistoryOpen = true;
    toast?.(`Queued compliance task: ${task.label}`);
    render();
  }

  async function processComplianceQueue() {
    if (queueProcessing) return;
    if (inspectionStatus === "running") return;
    queueProcessing = true;
    try {
      while (true) {
        const nextTask = complianceQueue.find((task) => task.status === "queued");
        if (!nextTask) break;
        await startComplianceCheck(nextTask);
      }
    } finally {
      queueProcessing = false;
      render();
    }
  }

  async function startComplianceCheck(queuedTask?: QueuedComplianceTask) {
    const hasModel = viewerApi.hasModelLoaded();
    if (!hasModel) return toast?.("Load a model first.");

    const task = queuedTask ?? buildComplianceTaskFromCurrentSettings("running");
    if (!task) return;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    applyTaskSettings(task);
    const { deterministic, prompt, promptSource, promptSourceLabel, sourceText } = task;
    const ruleSnapshot = task.ruleSnapshot;

    // Set inspection state
    inspectionStatus = "running";
    inspectionPhase = "checking";
    inspectionStep = 0;
    inspectionDecisions = [];
    inspectionTrace = null;
    inspectionError = null;
    inspectionStartTime = Date.now();
    inspectionTaskHud = null;
    inspectionLiveFeed = [queuedTask ? `Starting queued task: ${task.label}` : "Preparing inspection run..."];
    inspectionThinking = "";
    inspectionFollowUpDone = "";
    activeRunInterruption = "continue";
    render();

    try {
      syncRuntimeSettingsToVlmConfig();
      let openRouterUsageBefore: number | null = null;
      const taskOpenRouterApiKey = String(task.vlmConfig?.openrouter?.apiKey ?? openRouterApiKey ?? "");
      if (task.vlmProvider === "openrouter") {
        openRouterUsageBefore = await fetchOpenRouterUsageValue(taskOpenRouterApiKey);
      }

      vlmChecker.resetRunWebEvidence();
      const res = await complianceRunner.start({
        prompt,
        deterministic,
        maxSteps: inspectionMaxSteps,
        shouldStop: () => activeRunInterruption,
        onStep: (step, _decision) => {
          inspectionStep = step;
          render();
        },
        onProgress: (update) => {
          inspectionStep = Math.max(inspectionStep, update.step);
          inspectionTaskHud = update.taskGraph ?? inspectionTaskHud;
          if (update.thinking) inspectionThinking = update.thinking;
          if (typeof update.followUpSummary === "string") inspectionFollowUpDone = update.followUpSummary;
          if (update.summary) {
            const last = inspectionLiveFeed[inspectionLiveFeed.length - 1];
            if (last !== update.summary) {
              inspectionLiveFeed = [...inspectionLiveFeed, update.summary].slice(-5);
            }
          }
          render();
        },
      });

      if (res?.reason === "user-stop-requested" || res?.reason === "user-skip-requested") {
        inspectionStatus = "idle";
        inspectionPhase = "idle";
        task.status = res.reason === "user-skip-requested" ? "skipped" : "stopped";
        task.completedAt = new Date().toISOString();
        inspectionHistoryOpen = true;
        inspectionLiveFeed = [
          ...inspectionLiveFeed,
          res.reason === "user-skip-requested"
            ? "Skipped the current check and left the next queued tasks untouched."
            : "Stopped the current check.",
        ].slice(-5);
        activeRunInterruption = "continue";
        render();
        return;
      }

      if (res?.ok === false && (!res.decisions || res.decisions.length === 0)) {
        inspectionStatus = "failed";
        inspectionPhase = "idle";
        inspectionError = res.reason ?? "Compliance check failed";
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.error = inspectionError ?? undefined;
      } else {
        inspectionPhase = "generating_report";
        inspectionLiveFeed = [...inspectionLiveFeed, "Compliance complete. Generating report and trace..."].slice(-5);
        render();
        // Build a trace from results
        const endTime = Date.now();
        const startTime = inspectionStartTime ?? endTime;
        const decisions: VlmDecision[] = res?.decisions ?? inspectionDecisions;
        const navigationActions =
          typeof complianceRunner.getNavigationActions === "function" ? complianceRunner.getNavigationActions() : [];
        const webEvidenceRecords = [...(vlmChecker.getRunWebEvidence() ?? [])].sort(
          (a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime()
        );
        const ruleInfo = ruleSnapshot
          ? { id: ruleSnapshot.id, title: ruleSnapshot.title, description: ruleSnapshot.description, category: ruleSnapshot.category, severity: ruleSnapshot.severity }
          : { id: "custom", title: "Custom Rule", description: prompt.slice(0, 200), category: "custom", severity: "moderate" };

        console.log("[TRACE] getRunWebEvidence()", vlmChecker.getRunWebEvidence());  
        const run = snapshotCollector.getRun();
        const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : [];
        let complianceUsageDelta: number | null = null;
        if (task.vlmProvider === "openrouter") {
          const openRouterUsageAfter = await fetchOpenRouterUsageValue(taskOpenRouterApiKey);
          if (
            typeof openRouterUsageBefore === "number" &&
            isFinite(openRouterUsageBefore) &&
            typeof openRouterUsageAfter === "number" &&
            isFinite(openRouterUsageAfter)
          ) {
            complianceUsageDelta = Math.max(0, openRouterUsageAfter - openRouterUsageBefore);
          }
        }
        const modelId = task.modelId;
        const decisionTimes = decisions.map((d) => new Date(d.timestampIso).getTime());
        const getStepWebSources = (index: number) => {
          const from = index === 0 ? Number.NEGATIVE_INFINITY : decisionTimes[index - 1];
          const to = decisionTimes[index];
          const entries = webEvidenceRecords.filter((entry) => {
            const t = new Date(entry.fetchedAt).getTime();
            return t > from && t <= to;
          });
          const seen = new Set<string>();
          return entries
            .filter((entry) => {
              const key = `${entry.sourceType}|${entry.url}|${entry.via ?? ""}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((entry) => ({
              sourceType: entry.sourceType,
              url: entry.url,
              via: entry.via,
            }));
        };
        const snapshots = artifacts.map((artifact: any, index: number) => ({
          snapshotId: artifact.id,
          reason: artifact.meta?.note ?? `Snapshot ${index + 1}`,
          cameraPose: artifact.meta?.camera ?? {
            eye: { x: 0, y: 0, z: 0 },
            target: { x: 0, y: 0, z: 0 },
          },
          timestamp: artifact.meta?.timestampIso ?? new Date(startTime).toISOString(),
          mode: artifact.mode,
          isolatedElements: artifact.meta?.context?.isolatedIds,
          hiddenElements: artifact.meta?.context?.hiddenIds,
          planCut: artifact.meta?.context?.planCut
            ? {
                height: artifact.meta.context.planCut.height,
                thickness: artifact.meta.context.planCut.thickness,
              }
            : undefined,
          activeEntityId:
            typeof artifact.meta?.context?.activeEntityId === "string"
              ? artifact.meta.context.activeEntityId
              : undefined,
          novelty: readSnapshotNoveltyMetrics(artifact.meta?.context?.snapshotNovelty),
          semanticEvidenceProgress:
            artifact.meta?.context?.semanticEvidenceProgress &&
            typeof artifact.meta.context.semanticEvidenceProgress === "object"
              ? artifact.meta.context.semanticEvidenceProgress
              : undefined,
          imageBase64: artifact.images?.[0]?.imageBase64Png,
        }));
        const sceneStates: SceneState[] = artifacts.map((artifact: any, index: number) => {
          const context = artifact.meta?.context ?? {};
          const novelty = readSnapshotNoveltyMetrics(context.snapshotNovelty);
          const planCut = context.planCut && typeof context.planCut === "object"
            ? {
                enabled: typeof context.planCut.enabled === "boolean" ? context.planCut.enabled : undefined,
                height: typeof context.planCut.height === "number" ? context.planCut.height : undefined,
                absoluteHeight:
                  typeof context.planCut.absoluteHeight === "number" ? context.planCut.absoluteHeight : undefined,
                thickness: typeof context.planCut.thickness === "number" ? context.planCut.thickness : undefined,
                mode: typeof context.planCut.mode === "string" ? context.planCut.mode : undefined,
                source: typeof context.planCut.source === "string" ? context.planCut.source : undefined,
                storeyId: typeof context.planCut.storeyId === "string" ? context.planCut.storeyId : undefined,
              }
            : undefined;
          return {
            step: typeof context.step === "number" ? context.step : index + 1,
            snapshotId: artifact.id,
            label: artifact.meta?.note ?? `Step ${index + 1}`,
            action: typeof context.lastActionReason === "string" ? context.lastActionReason : undefined,
            cameraPose: context.cameraPose ?? artifact.meta?.camera ?? {
              eye: { x: 0, y: 0, z: 0 },
              target: { x: 0, y: 0, z: 0 },
            },
            viewPreset:
              context.viewPreset === "iso" || context.viewPreset === "top" || context.viewPreset === "front" || context.viewPreset === "custom"
                ? context.viewPreset
                : undefined,
            isolatedStorey: typeof context.scope?.storeyId === "string" ? context.scope.storeyId : undefined,
            isolatedSpace: typeof context.scope?.spaceId === "string" ? context.scope.spaceId : undefined,
            isolatedCategories: Array.isArray(context.isolatedCategories) ? context.isolatedCategories : undefined,
            isolatedIds: Array.isArray(context.isolatedIds) ? context.isolatedIds : undefined,
            hiddenIds: Array.isArray(context.hiddenIds) ? context.hiddenIds : undefined,
            highlightedIds: Array.isArray(context.highlightedIds) ? context.highlightedIds : undefined,
            planCut,
            activeEntityId: typeof context.activeEntityId === "string" ? context.activeEntityId : undefined,
            novelty,
            semanticEvidenceProgress:
              context.semanticEvidenceProgress && typeof context.semanticEvidenceProgress === "object"
                ? context.semanticEvidenceProgress
                : undefined,
          };
        });
        const stepBySnapshotId = new Map(
          sceneStates
            .filter((state) => state.step != null && Boolean(state.snapshotId))
            .map((state) => [state.snapshotId as string, state.step as number])
        );
        const inferDecisionStep = (decision: VlmDecision, fallbackIndex: number): number => {
          const noteStep = String(decision.evidence?.note ?? "").match(/compliance_step_(\d+)_/);
          if (noteStep) {
            const parsed = Number(noteStep[1]);
            if (Number.isFinite(parsed)) return parsed;
          }

          const evidenceSteps = (decision.evidence?.snapshotIds ?? [])
            .map((snapshotId) => stepBySnapshotId.get(snapshotId))
            .filter((step): step is number => typeof step === "number" && Number.isFinite(step));
          if (evidenceSteps.length) return Math.max(...evidenceSteps);

          return fallbackIndex + 1;
        };
        const decisionsWithSteps = decisions.map((decision: VlmDecision, index: number) => ({
          decision,
          step: inferDecisionStep(decision, index),
          index,
        }));
        const trace: ConversationTrace = {
          traceId: crypto.randomUUID(),
          runId: res?.runId ?? crypto.randomUUID(),
          rule: ruleInfo,
          model: {
          id: modelId,
            provider: task.vlmProvider,
            name: task.vlmAdapterName,
          },
          startedAt: new Date(startTime).toISOString(),
          completedAt: new Date(endTime).toISOString(),
          status: "completed",
          prompts: decisionsWithSteps.map(({ decision: d, step, index: i }) => ({
            step,
            promptText: getPromptTextForReport(d, prompt),
            promptSource,
            promptSourceLabel,
            sourceText,
            webSourcesUsed: getStepWebSources(i),
            ruleContext: {
              ruleId: ruleSnapshot?.id ?? "custom",
              ruleTitle: ruleSnapshot?.title ?? "Custom Rule",
              ruleDescription: ruleSnapshot?.description ?? prompt.slice(0, 200),
              evaluationCriteria: ruleSnapshot?.evaluationCriteria ?? { pass: [], fail: [], uncertain: [] },
              visualEvidence:
                ruleSnapshot?.visualEvidence ??
                { lookFor: [], passIndicators: [], failIndicators: [], uncertainIndicators: [] },
            },
            snapshotIds: d.meta?.inputSnapshotIds ?? d.evidence?.snapshotIds ?? [],
            timestamp: d.timestampIso,
            modelId,
          })),
          responses: decisionsWithSteps.map(({ decision: d, step }) => ({
            step,
            decision: d,
            responseTimeMs: 0,
            timestamp: d.timestampIso,
          })),
          snapshots,
          navigationActions,
          sceneStates,
          stepMetrics: [],
          stressedFindings: [],
          finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : undefined,
          finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : undefined,
          finalRationale: decisions.length > 0 ? decisions[decisions.length - 1].rationale : undefined,
          metrics: {
            totalSnapshots: snapshots.length,
            totalVlmCalls: decisions.length,
            totalNavigationSteps: navigationActions.length,
            totalDurationMs: endTime - startTime,
            avgVlmResponseTimeMs: 0,
            avgConfidence: decisions.length > 0 ? decisions.reduce((s: number, d: VlmDecision) => s + d.confidence, 0) / decisions.length : 0,
            finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : "UNCERTAIN",
            finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : 0,
            uncertainSteps: decisions.filter((d: VlmDecision) => d.verdict === "UNCERTAIN").length,
            failureNotes: [],
            complianceTokensUsed: complianceUsageDelta ?? getComplianceTokensUsed(decisions),
          },
          webEvidence: webEvidenceRecords,
        };
        try {
          inspectionLiveFeed = [...inspectionLiveFeed, "Running secondary judge agent..."].slice(-5);
          render();
          trace.judgeReport = await runJudgeAgent(trace, vlmChecker.getConfig());
          trace.finalVerdict = trace.judgeReport.verdict;
          trace.finalConfidence = trace.judgeReport.confidence;
          trace.finalRationale = trace.judgeReport.rationale;
          if (trace.metrics) {
            trace.metrics.finalVerdict = trace.judgeReport.verdict;
            trace.metrics.finalConfidence = trace.judgeReport.confidence;
            trace.metrics.totalVlmCalls += 1;
          }
        } catch (judgeError: any) {
          console.warn("[Panel] Judge agent failed:", judgeError);
          trace.judgeReport = {
            createdAtIso: new Date().toISOString(),
            provider: task.vlmProvider,
            modelId,
            verdict: trace.finalVerdict ?? "UNCERTAIN",
            confidence: trace.finalConfidence ?? 0,
            rationale: trace.finalRationale ?? "Judge agent failed before producing an independent report.",
            taskVerdicts: [],
            suggestionsForUser: ["Review the primary VLM snapshots, rationales, and regulatory/web evidence manually."],
            debuggingAndSuggestions: {
              primaryDecisionAssessment: "Secondary judge call failed, so the primary VLM decision could not be independently checked.",
              possibleMistakes: [],
              capabilityNotes: ["No independent judge analysis is available for this run."],
              improvementSuggestions: ["Check provider credentials, model support for images/JSON output, and request timeout settings."],
            },
            error: judgeError?.message ?? "Judge agent failed.",
          };
        }
        console.log("[TRACE] trace.webEvidence", trace.webEvidence);
        
        inspectionTrace = trace;
        syncSceneStepIndex(trace);
        await traceDb.saveTrace(trace);
        await loadTraces();
        inspectionStatus = "completed";
        inspectionPhase = "idle";
        task.status = "completed";
        task.completedAt = trace.completedAt;
        task.traceId = trace.traceId;
        task.verdict = trace.finalVerdict;
        inspectionHistoryOpen = true;
        toast?.(`Inspection complete: ${trace.finalVerdict ?? "N/A"}`);
      }
    } catch (e: any) {
      console.error("[Panel] Compliance error:", e);
      inspectionStatus = "failed";
      inspectionPhase = "idle";
      inspectionError = e?.message ?? "Compliance error (see console).";
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = inspectionError ?? undefined;
    }

    activeRunInterruption = "continue";
    render();
  }

  // ───────────────── Export helpers ─────────────────
  async function exportTraceJson() {
    if (!inspectionTrace) return toast?.("No trace to export.");
    const success = await traceDb.downloadTraceAsJson(inspectionTrace.traceId);
    toast?.(success ? "Trace exported as JSON." : "Export failed.");
  }

  function exportHtmlReport() {
    if (!inspectionTrace) return toast?.("No trace to export.");
    try {
      downloadHtmlReport(inspectionTrace, { embedImages: true });
      toast?.("HTML report downloaded.");
    } catch (e) {
      console.error("[Panel] Report generation failed:", e);
      toast?.("Report generation failed.");
    }
  }

  // ───────────────── JSON contract test (existing debug tool) ─────────────────
  async function runJsonContractTest() {
    const hasModel = viewerApi.hasModelLoaded();
    if (!hasModel) return toast?.("Load a model first.");
    try {
      const run = snapshotCollector.getRun();
      const artifacts = run.artifacts;
      if (artifacts.length < 2) {
        toast?.("Need at least 2 snapshots for multi-evidence test.");
        return;
      }
      const prompt =
        "MULTI-EVIDENCE JSON TEST. " +
        "You are given MULTIPLE snapshots of the same scene. " +
        "Return ONLY valid JSON. " +
        'verdict MUST be "UNCERTAIN", confidence MUST be exactly 0.55, ' +
        'rationale MUST include the phrase "multiple views considered"';
      const decision = await vlmChecker.check({
        prompt,
        artifacts,
        evidenceViews: artifacts.map((a: any) => ({
          snapshotId: a.id,
          mode: a.mode,
          note: a.meta.note,
          nav: undefined,
        })),
      } as any);
      console.log("[JSON TEST] decision:", decision);
      toast?.(`JSON test: ${decision.verdict} ${(decision.confidence * 100).toFixed(0)}%`);
      return decision;
    } catch (e) {
      console.error("[JSON TEST] failed", e);
      toast?.("JSON test failed (see console).");
      return null;
    }
  }

  // ───────────────── RENDER ─────────────────
  function render() {
    panelRoot.innerHTML = "";

    const loading = upload.isLoading();
    const hasModel = viewerApi.hasModelLoaded();

    const hasQueuedTasks = complianceQueue.some((task) => task.status === "queued");
    const loadLabel = loading ? "Loading…" : hasModel ? "Replace model (upload new)" : "Load local IFC";

    const panel = BUI.Component.create(() => BUI.html`
      <bim-panel class="hud-panel">

        <bim-panel-section label="Model">
          <bim-button label=${loadLabel} ?disabled=${loading}
            @click=${() => { if (!loading) upload.openFileDialog(); }}></bim-button>
          <div class="hud-view-grid">
            <bim-button label="ISO view" ?disabled=${loading || !hasModel}
              @click=${async () => viewerApi.setPresetView("iso", true)}></bim-button>
            <bim-button label="Top view" ?disabled=${loading || !hasModel}
              @click=${async () => viewerApi.setPresetView("top", true)}></bim-button>
          </div>
          <bim-button label="Reset visibility" ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.resetVisibility()}></bim-button>
        </bim-panel-section>

        <details
          class="hud-native-section"
          ?open=${hasModel && vlmProviderOpen}
          @toggle=${(e: any) => { vlmProviderOpen = !!e.target.open; }}
        >
          <summary class="hud-native-section-summary">
            <span>VLM Provider</span>
          </summary>
          <div class="hud-stack hud-native-section-body">
            <div class="hud-inline-row">
              <span class="hud-field-label">Provider</span>
              <select style="flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                @change=${(e: any) => { vlmProvider = String(e.target.value) as any; render(); }}>
                <option value="mock" ?selected=${vlmProvider === "mock"}>Mock (deterministic)</option>
                <option value="openrouter" ?selected=${vlmProvider === "openrouter"}>OpenRouter (VLM)</option>
                <option value="openai" ?selected=${vlmProvider === "openai"}>OpenAI / ChatGPT</option>
              </select>
            </div>

            ${vlmProvider === "openai" ? BUI.html`
              <input style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="OpenAI API key (dev/test only - client-side)" type="password" .value=${openAiApiKey}
                @input=${(e: any) => { openAiApiKey = e.target.value; }}/>
              <input style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="Model (must support vision + structured outputs)" .value=${openAiModel}
                @input=${(e: any) => { openAiModel = e.target.value; }}/>
              <input style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="Endpoint (optional)" .value=${openAiEndpoint}
                @input=${(e: any) => { openAiEndpoint = e.target.value; }}/>
            ` : null}

            ${vlmProvider === "openrouter" ? BUI.html`
              <input style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="OpenRouter API key (dev/test only - client-side)" type="password" .value=${openRouterApiKey}
                @input=${(e: any) => { openRouterApiKey = e.target.value; openRouterStatus = { state: "idle" }; openRouterLastKeyForStatus = ""; }}
                @blur=${() => { const k = (openRouterApiKey ?? "").trim(); if (k) void validateOpenRouterKey(k); }}/>
              <div class="hud-inline-row">
                <span class="hud-field-label">Model</span>
                <select style="flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                  @change=${async (e: any) => {
                    openRouterModel = e.target.value;
                    render();
                    await applySelectedVlmProvider({ silent: true });
                  }}>
                  ${OPENROUTER_VISION_MODELS.map((m) => BUI.html`
                    <option value=${m.id} ?selected=${openRouterModel === m.id}>
                      ${m.label} (${m.provider})
                    </option>
                  `)}
                </select>
              </div>
              ${(() => {
                const info = findModelById(openRouterModel);
                return info ? BUI.html`
                  <div style="color:rgba(255,255,255,0.6);font-size:10px;line-height:1.3;padding:0 2px;">
                    ${info.description}<br/>
                    <span style="opacity:0.7;">ID: ${info.id}</span>
                  </div>
                ` : null;
              })()}
              <div class="hud-inline-row wrap">
                <bim-button label=${openRouterStatus.state === "checking" ? "Checking..." : "Validate key"}
                  ?disabled=${openRouterStatus.state === "checking"}
                  @click=${() => void validateOpenRouterKey((openRouterApiKey ?? "").trim())}></bim-button>
                <label class="hud-checkbox-row">
                  <input type="checkbox" .checked=${openRouterAutoRefresh}
                    @change=${(e: any) => { openRouterAutoRefresh = !!e.target.checked; }}/>Auto-refresh
                </label>
              </div>
              <div class="hud-status-card">
                <div class="hud-status-title">API key status</div>
                ${openRouterStatus.state === "valid" ? BUI.html`
                  <div class="hud-status-pair-row">
                    <span class="hud-status-note">Status: Valid key</span>
                    <span class="hud-status-note">Limit: ${openRouterStatus.limit ?? "Unavailable"}</span>
                  </div>
                  <div class="hud-status-pair-row">
                    <span class="hud-status-note">Remaining: ${openRouterStatus.remaining ?? "Unavailable"}</span>
                    <span class="hud-status-note">Used: ${openRouterStatus.used ?? "Unavailable"}</span>
                  </div>
                ` : openRouterStatus.state === "invalid" ? BUI.html`
                  <div class="hud-status-note">Invalid key.</div>
                  <div class="hud-status-note">${openRouterStatus.error}</div>
                ` : BUI.html`
                  <div class="hud-status-note">
                    ${openRouterStatus.state === "idle" ? "Not validated yet."
                      : openRouterStatus.state === "checking" ? "Validating key..."
                      : "Not validated yet."}
                  </div>
                `}
              </div>
            ` : null}

            <bim-button label="Apply provider" @click=${() => void applySelectedVlmProvider()}></bim-button>

            <div style="color:#fff;opacity:0.75;font-size:11px;">
              Determinism: requests use temperature=0 and strict JSON schema. Provider/model are stored locally for reproducibility.
            </div>
          </div>
        </details>

        <details
          class="hud-native-section"
          ?open=${hasModel && complianceCheckingOpen}
          @toggle=${(e: any) => { complianceCheckingOpen = !!e.target.open; }}
        >
          <summary class="hud-native-section-summary">
            <span>Compliance Checking</span>
          </summary>
          <div class="hud-stack hud-native-section-body">
            ${inspectionStatus !== "idle" || inspectionPhase === "generating_report" ? BUI.html`
              <div style="padding:8px;background:rgba(0,0,0,0.25);border-radius:8px;text-align:center;border:1px solid ${
                inspectionStatus === "running" || inspectionPhase === "generating_report" ? "rgba(59,130,246,0.5)"
                : inspectionStatus === "completed" ? "rgba(34,197,94,0.5)"
                : "rgba(239,68,68,0.5)"
              } ;">
                <div style="color:#fff;font-size:13px;">
                  Status: <strong>${inspectionPhase === "generating_report" ? "COMPLETED" : inspectionStatus.toUpperCase()}</strong>
                </div>
                ${inspectionPhase === "generating_report" ? BUI.html`
                  <div style="margin-top:4px;color:rgba(255,255,255,0.74);font-size:11px;">Current task: generating report...</div>
                ` : null}
              </div>
            ` : null}

            <div style="display:flex;gap:4px;">
              <button style="flex:1;padding:6px;border-radius:6px 0 0 6px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;color:#fff;font-size:12px;background:${ruleInputMode === "library" ? "rgba(59,130,246,0.4)" : "rgba(0,0,0,0.25)"};"
                @click=${() => { ruleInputMode = "library"; render(); }}>Rule Library</button>
              <button style="flex:1;padding:6px;border-radius:0 6px 6px 0;border:1px solid rgba(255,255,255,0.15);cursor:pointer;color:#fff;font-size:12px;background:${ruleInputMode === "custom" ? "rgba(59,130,246,0.4)" : "rgba(0,0,0,0.25)"};"
                @click=${() => { ruleInputMode = "custom"; render(); }}>Custom Prompt</button>
            </div>

            ${ruleInputMode === "library" ? BUI.html`
              <div class="hud-field">
                <select style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                  @change=${(e: any) => {
                    const ruleId = e.target.value;
                    selectedRule = rules.find((r) => r.id === ruleId) ?? null;
                    render();
                  }}>
                  <option value="" ?selected=${!selectedRule}>Select compliance rule</option>
                  ${rules.map((rule) => BUI.html`
                    <option value=${rule.id} ?selected=${selectedRule?.id === rule.id}>
                      ${rule.title} (${rule.category})
                    </option>
                  `)}
                </select>
              </div>
              ${selectedRule ? BUI.html`
                <div style="padding:10px;background:rgba(0,0,0,0.2);border-radius:8px;border:1px solid rgba(255,255,255,0.08);">
                  <div style="color:#fff;font-weight:600;font-size:13px;margin-bottom:4px;">${selectedRule.title}</div>
                  <div style="color:rgba(255,255,255,0.75);font-size:11px;margin-bottom:8px;line-height:1.4;">${selectedRule.description}</div>
                </div>
              ` : null}
            ` : BUI.html`
              <textarea style="width:100%;min-height:92px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="Enter the compliance rule / prompt here..."
                @input=${(e: any) => { rulePrompt = e.target.value; }}
              >${rulePrompt}</textarea>
            `}

            <div class="hud-inline-row">
              <span class="hud-field-label">Start view</span>
              <select style="flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                ?disabled=${!deterministicEnabled}
                @change=${(e: any) => { deterministicMode = String(e.target.value) as any; render(); }}>
                <option value="iso" ?selected=${deterministicMode === "iso"}>ISO</option>
                <option value="top" ?selected=${deterministicMode === "top"}>Top</option>
                <option value="custom" ?selected=${deterministicMode === "custom"}>Custom pose</option>
              </select>
              <label class="hud-checkbox-row">
                <input type="checkbox" .checked=${deterministicEnabled}
                  @change=${(e: any) => { deterministicEnabled = !!e.target.checked; render(); }}/>
                Deterministic start
              </label>
            </div>

            ${deterministicEnabled && deterministicMode === "custom" ? BUI.html`
              <textarea
                style="width:100%;min-height:96px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"
                @input=${(e: any) => { customPoseText = e.target.value; }}
              >${customPoseText}</textarea>
            ` : null}

            <details
              ?open=${prototypeSettingsOpen}
              class="hud-settings-card"
              @toggle=${(e: any) => { prototypeSettingsOpen = !!e.target.open; }}
            >
              <summary class="hud-settings-summary">
                Prototype Settings
              </summary>
              <div class="hud-settings-body">
                <div class="hud-settings-note">
                  Runtime-only controls. New prototype starts use the current defaults from prototypeSettings.ts.
                </div>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>DEFAULT_MAX_COMPLIANCE_STEPS</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.maxComplianceSteps}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="5" max="30" step="1" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.maxComplianceSteps)}
                    @input=${(e: any) => updatePrototypeSetting("maxComplianceSteps", e.target.value)} />
                </label>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>ENTITY_UNCERTAIN_TERMINATION_STEPS</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.entityUncertainTerminationSteps}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="3" max="10" step="1" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.entityUncertainTerminationSteps)}
                    @input=${(e: any) => updatePrototypeSetting("entityUncertainTerminationSteps", e.target.value)} />
                </label>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.entityUncertainTerminationConfidence.toFixed(2)}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="0" max="1" step="0.05" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.entityUncertainTerminationConfidence)}
                    @input=${(e: any) => updatePrototypeSetting("entityUncertainTerminationConfidence", e.target.value)} />
                </label>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>DEFAULT_MAX_SNAPSHOTS_PER_REQUEST</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.maxSnapshotsPerRequest}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="1" max="10" step="1" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.maxSnapshotsPerRequest)}
                    @input=${(e: any) => { updatePrototypeSetting("maxSnapshotsPerRequest", e.target.value); syncRuntimeSettingsToVlmConfig(); }} />
                </label>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>DEFAULT_REDUCED_TAVILY_MAX_CHARS</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.reducedTavilyMaxChars}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="500" max="10000" step="100" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.reducedTavilyMaxChars)}
                    @input=${(e: any) => updatePrototypeSetting("reducedTavilyMaxChars", e.target.value)} />
                </label>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>ORBIT_MAX_HIGHLIGHT_OCCLUSION_RATIO</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.orbitMaxHighlightOcclusionRatio.toFixed(2)}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="0" max="1" step="0.05" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.orbitMaxHighlightOcclusionRatio)}
                    @input=${(e: any) => updatePrototypeSetting("orbitMaxHighlightOcclusionRatio", e.target.value)} />
                </label>
                <label class="hud-setting-row">
                  <span class="hud-setting-row-header">
                    <span>SNAPSHOT_NOVELTY_REDUNDANCY_THRESHOLD</span>
                    <span class="hud-setting-value">${prototypeRuntimeSettings.snapshotNoveltyRedundancyThreshold.toFixed(2)}</span>
                  </span>
                  <input class="hud-settings-range" type="range" min="0" max="1" step="0.05" ?disabled=${inspectionStatus === "running"} .value=${String(prototypeRuntimeSettings.snapshotNoveltyRedundancyThreshold)}
                    @input=${(e: any) => updatePrototypeSetting("snapshotNoveltyRedundancyThreshold", e.target.value)} />
                </label>
                <bim-button label="Reset to file defaults" ?disabled=${inspectionStatus === "running"} @click=${resetPrototypeSettings}></bim-button>
              </div>
            </details>
            <bim-button
              class=${`hud-action-button${inspectionStatus === "running" ? " is-danger" : ""}`}
              label=${inspectionStatus === "running"
                ? activeRunInterruption === "stop"
                  ? "Stopping..."
                  : activeRunInterruption === "skip"
                    ? "Skipping..."
                    : hasQueuedTasks
                      ? "Skip this check"
                      : "Stop checking"
                : hasQueuedTasks
                  ? "Run queued tasks"
                  : "Start checking"}
              ?disabled=${loading || !hasModel || inspectionPhase === "generating_report" || (!hasQueuedTasks && ruleInputMode === "library" && !selectedRule) || (!hasQueuedTasks && ruleInputMode === "custom" && !(rulePrompt ?? "").trim())}
              @click=${async () => {
                if (inspectionStatus === "running") {
                  activeRunInterruption = hasQueuedTasks ? "skip" : "stop";
                  render();
                  return;
                }
                if (hasQueuedTasks) {
                  await processComplianceQueue();
                  return;
                }
                await startComplianceCheck();
              }}
            ></bim-button>

            <bim-button
              label="Queue task"
              ?disabled=${loading || !hasModel || (ruleInputMode === "library" && !selectedRule)}
              @click=${queueComplianceTask}
            ></bim-button>

          </div>
        </details>

        <!-- ═══════════ INSPECTION HISTORY (native collapse to avoid bim-panel-section layout flicker) ═══════════ -->
        <details
          class="hud-native-section"
          ?open=${inspectionHistoryOpen}
          @toggle=${(e: any) => { inspectionHistoryOpen = !!e.target.open; }}
        >
          <summary class="hud-native-section-summary">
            <span>Inspection History</span>
          </summary>
          <div class="hud-stack hud-native-section-body hud-history-section-body">
            ${complianceQueue.length ? BUI.html`
              <div class="hud-history-list">
                ${complianceQueue.slice().reverse().map((task) => BUI.html`
                  <button
                    type="button"
                    class="hud-history-item"
                    title=${task.traceId ? `Open ${task.label}` : task.label}
                    ?disabled=${!task.traceId}
                    @click=${() => { if (task.traceId) void loadInspectionTrace(task.traceId); }}
                  >
                    <div class="hud-history-row">
                      <span class="hud-history-title">${task.label}</span>
                      <span .innerHTML=${task.verdict ? verdictBadgeHtml(task.verdict) : queueStatusBadgeHtml(task.status)}></span>
                    </div>
                    <div class="hud-history-meta">
                      Queued ${formatTraceTimestamp(task.queuedAt)} • ${task.vlmProvider}/${task.modelId} • ${describeTaskStart(task)} • Max steps: ${task.maxSteps}
                    </div>
                    ${task.error ? BUI.html`
                      <div class="hud-history-meta">Error: ${task.error}</div>
                    ` : null}
                  </button>
                `)}
              </div>
            ` : null}
            ${recentTraces.length === 0 && complianceQueue.length === 0 ? BUI.html`
              <div class="hud-empty-state">
                No inspection runs saved yet.
              </div>
            ` : recentTraces.length ? BUI.html`
              <div class="hud-history-list">
                ${recentTraces.map((trace) => BUI.html`
                  <button
                    type="button"
                    class="hud-history-item"
                    title=${`Open ${trace.rule.title}`}
                    @click=${() => void loadInspectionTrace(trace.traceId)}
                  >
                    <div class="hud-history-row">
                      <span class="hud-history-title">${trace.rule.title}</span>
                      <span .innerHTML=${verdictBadgeHtml(trace.finalVerdict)}></span>
                    </div>
                    <div class="hud-history-meta">
                      ${formatTraceTimestamp(trace.completedAt ?? trace.startedAt)}
                    </div>
                  </button>
                `)}
              </div>
            ` : null}
            <bim-button
              label="Clear Finished Queue Items"
              ?disabled=${!complianceQueue.some((task) => task.status === "completed" || task.status === "failed" || task.status === "skipped" || task.status === "stopped")}
              @click=${() => {
                complianceQueue = complianceQueue.filter((task) => task.status === "queued" || task.status === "running");
                render();
              }}
            ></bim-button>
            <bim-button
              label="Clear History"
              ?disabled=${recentTraces.length === 0}
              @click=${async () => {
                await traceDb.clearAll();
                await loadTraces();
                inspectionTrace = null;
                inspectionSceneStepIndex = -1;
                inspectionStatus = "idle";
                inspectionPhase = "idle";
                render();
                toast?.("History cleared.");
              }}
            ></bim-button>
          </div>
        </details>

        <!-- ═══════════ DEBUG SECTION ═══════════ -->
        <details
          class="hud-native-section"
          ?open=${debugOpen}
          @toggle=${(e: any) => { debugOpen = !!e.target.open; }}
        >
          <summary class="hud-native-section-summary">
            <span>Debug</span>
          </summary>
          <div class="hud-stack hud-native-section-body">
          <bim-button
            label=${debugPickModeEnabled ? "Disable pick highlight debug" : "Enable pick highlight debug"}
            ?disabled=${loading || !hasModel || !viewerApi.pickObjectAt || !viewerApi.highlightIds || !viewerApi.getRendererDomElement}
            @click=${() => {
              setDebugPickMode(!debugPickModeEnabled);
              render();
              toast?.(debugPickModeEnabled ? "Pick highlight debug enabled. Click model to highlight." : "Pick highlight debug disabled.");
            }}
          ></bim-button>
          
          <bim-button label="Capture snapshot" ?disabled=${loading || !hasModel}
            @click=${async () => {
              try {
                const a = await snapshotCollector.capture("manual");
                toast?.("Saved " + a.id);
                console.log("[Snapshot] captured artifact:", a);
              } catch (err) { console.error(err); toast?.("Snapshot capture failed (see console)."); }
            }}></bim-button>

          <bim-button label="List runs (console)"
            @click=${async () => {
              const db = snapshotCollector.db;
              if (!db) return toast?.("No DB attached.");
              const runs = await db.listRuns();
              console.log("[SnapshotDB] runs:", runs);
              toast?.("Runs: " + runs.length + " (see console)");
            }}></bim-button>

          <bim-button label="Preview latest snapshot" ?disabled=${loading}
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
                      if (url) { openImageInNewTab(url); return; }
                    }
                  }
                }
                const mem = snapshotCollector.getRun();
                if (mem?.artifacts?.length) {
                  const lastMem = mem.artifacts[mem.artifacts.length - 1];
                  const url = lastMem?.images?.[0]?.imageBase64Png;
                  if (url) { openImageInNewTab(url); return; }
                }
                toast?.("No snapshots found.");
              } catch (err) { console.error(err); toast?.("Preview failed (see console)."); }
            }}></bim-button>

          <bim-button label=${`Run JSON test (${vlmChecker.adapterName})`}
            ?disabled=${loading || !hasModel}
            @click=${async () => { await runJsonContractTest(); }}></bim-button>

          <bim-button label="Navigate to isolate selection" ?disabled=${loading || !hasModel || !navigationAgent}
            @click=${async () => {
              try {
                if (!navigationAgent) { toast?.("Navigation agent not attached."); return; }
                const res = await navigationAgent.goToCurrentIsolateSelection({ smooth: true, padding: 1.25 });
                toast?.(res.ok ? `Navigation ok (${res.method})` : `Navigation failed: ${res.reason}`);
                console.log("[Navigation] result:", res);
              } catch (e) { console.error(e); toast?.("Navigation error (see console)."); }
            }}></bim-button>

          <bim-button label="Clear DB (reset project)"
            @click=${async () => {
              try {
                // Delete the entire shared IndexedDB to avoid version conflicts
                await deleteDatabase();
                if (snapshotCollector.db?.clearAll) await snapshotCollector.db.clearAll();
                if (snapshotCollector.reset) await snapshotCollector.reset();
                await viewerApi.resetVisibility();
                inspectionStatus = "idle";
                inspectionPhase = "idle";
                inspectionTrace = null;
                inspectionError = null;
                rules = [];
                recentTraces = [];
                render();
                toast?.("Project reset: all databases cleared. Reload to re-initialize rules.");
              } catch (err) { console.error(err); toast?.("Reset failed (see console)."); }
            }}></bim-button>
          </div>
        </details>

      </bim-panel>
    `);

    panelRoot.append(panel);

    if (bottomDockRoot) {
      bottomDockRoot.innerHTML = "";
      const shouldShowBottomDock =
        inspectionStatus === "running" ||
        inspectionPhase === "generating_report" ||
        inspectionStatus === "completed" ||
        complianceQueue.length > 0;
      if (shouldShowBottomDock) {
        const dock = BUI.Component.create(() => BUI.html`
          ${(() => {
            const queuedCount = complianceQueue.filter((task) => task.status === "queued").length;
            if (inspectionTrace) {
              return BUI.html`
                <div class="hud-bottom-dock">
                  <div class="hud-bottom-card hud-bottom-card-wide">
                    <div class="hud-bottom-title">Completed check</div>
                    <div class="hud-bottom-subtle">
                      <span .innerHTML=${verdictBadgeHtml(inspectionTrace.finalVerdict)}></span>
                      <span style="margin-left:8px;">Confidence: ${((inspectionTrace.finalConfidence ?? 0) * 100).toFixed(0)}%</span>
                    </div>
                    ${inspectionTrace.finalRationale ? BUI.html`
                      <div class="hud-bottom-subtle">${inspectionTrace.finalRationale}</div>
                    ` : null}
                    ${inspectionTrace.metrics ? BUI.html`
                      <div class="hud-bottom-summary-grid">
                        <div class="hud-bottom-summary-cell hud-bottom-summary-button">
                          <bim-button label="Generate Report" @click=${exportHtmlReport}></bim-button>
                        </div>
                        <div class="hud-bottom-summary-cell hud-bottom-summary-button">
                          <bim-button label="Export Trace" @click=${exportTraceJson}></bim-button>
                        </div>
                        <div class="hud-bottom-summary-cell hud-bottom-metric">
                          <div class="hud-bottom-metric-value">${inspectionTrace.metrics.totalSnapshots}</div>
                          <div class="hud-bottom-metric-label">Snapshots</div>
                        </div>
                        <div class="hud-bottom-summary-cell hud-bottom-metric">
                          <div class="hud-bottom-metric-value">${inspectionTrace.metrics.totalVlmCalls}</div>
                          <div class="hud-bottom-metric-label">VLM Calls</div>
                        </div>
                        <div class="hud-bottom-summary-cell hud-bottom-metric">
                          <div class="hud-bottom-metric-value">${formatDuration(inspectionTrace.metrics.totalDurationMs)}</div>
                          <div class="hud-bottom-metric-label">Duration</div>
                        </div>
                      </div>
                    ` : BUI.html`
                      <div class="hud-bottom-actions">
                        <bim-button label="Generate Report" @click=${exportHtmlReport}></bim-button>
                        <bim-button label="Export Trace" @click=${exportTraceJson}></bim-button>
                      </div>
                    `}
                    ${getSceneStates(inspectionTrace).length ? BUI.html`
                      ${(() => {
                        const activeScene = getSceneStates(inspectionTrace)[inspectionSceneStepIndex];
                        const sceneDetails = describeSceneState(activeScene);
                        return BUI.html`
                          <div class="hud-stepper-info">
                            <div class="hud-stepper-label">
                              ${activeScene?.label ?? `Step ${inspectionSceneStepIndex + 1}`}
                            </div>
                            ${activeScene?.action ? BUI.html`
                              <div class="hud-stepper-subtle">State: ${activeScene.action}</div>
                            ` : null}
                            ${sceneDetails.length ? BUI.html`
                              <div class="hud-stepper-subtle">${sceneDetails.join(" | ")}</div>
                            ` : null}
                          </div>
                        `;
                      })()}
                      <div class="hud-stepper">
                        <button
                          type="button"
                          class="hud-stepper-arrow"
                          ?disabled=${inspectionSceneStepIndex <= 0}
                          @click=${() => void restoreSceneState(inspectionTrace!, inspectionSceneStepIndex - 1)}
                          aria-label="Previous inspection step"
                        >
                          &lsaquo;
                        </button>
                        <div class="hud-stepper-count">
                          ${inspectionSceneStepIndex + 1}
                        </div>
                        <button
                          type="button"
                          class="hud-stepper-arrow"
                          ?disabled=${inspectionSceneStepIndex >= getSceneStates(inspectionTrace).length - 1}
                          @click=${() => void restoreSceneState(inspectionTrace!, inspectionSceneStepIndex + 1)}
                          aria-label="Next inspection step"
                        >
                          &rsaquo;
                        </button>
                      </div>
                    ` : null}
                  </div>
                </div>
              `;
            }

            return BUI.html`
              <div class="hud-bottom-dock">
                <div class="hud-bottom-card hud-bottom-card-wide hud-bottom-card-current-task">
                  ${(() => {
                    const stepCurrent = inspectionPhase === "generating_report" ? inspectionMaxSteps : Math.max(inspectionStep, 1);
                    const stepTotal = Math.max(inspectionMaxSteps, 1);
                    const stepRatio = Math.max(0, Math.min(1, stepCurrent / stepTotal));
                    const activeTaskTitle = inspectionPhase === "generating_report"
                      ? "Generating report"
                      : inspectionTaskHud?.activeTask?.title ?? (hasQueuedTasks ? "Queued task" : "Inspection activity");
                    const entityCurrent = inspectionTaskHud?.progress?.totalEntities
                      ? Math.min(
                          inspectionTaskHud.progress.completedEntities + (inspectionTaskHud.activeEntity?.id ? 1 : 0),
                          inspectionTaskHud.progress.totalEntities
                        )
                      : 0;
                    const thinkingText = toMaxTwoSentences(inspectionThinking) ||
                      (inspectionPhase === "generating_report"
                        ? "The VLM run is complete. Final outputs are being assembled."
                        : "Waiting for the next model decision.");
                    const followUpText = inspectionFollowUpDone ||
                      (inspectionPhase === "generating_report"
                        ? "No further follow-up is needed for this step."
                        : "No follow-up completed yet for this step.");
                    return BUI.html`
                      <div class="hud-bottom-progress" aria-hidden="true">
                        <div class="hud-bottom-progress-fill" style=${`width:${(stepRatio * 100).toFixed(1)}%;`}></div>
                      </div>
                      <div class="hud-bottom-title-row">
                        <div class="hud-bottom-title">Current task</div>
                        <div class="hud-bottom-title">${activeTaskTitle}</div>
                      </div>
                      <div class="hud-bottom-subtle">What the VLM is thinking: ${thinkingText}</div>
                      <div class="hud-bottom-meta-row">
                        <div class="hud-bottom-subtle">Step ${stepCurrent} of ${stepTotal}</div>
                        <div class="hud-bottom-subtle">Entity ${entityCurrent} of ${inspectionTaskHud?.progress?.totalEntities ?? 0}</div>
                      </div>
                      <div class="hud-bottom-subtle">Follow-up done: ${followUpText}</div>
                    `;
                  })()}
                </div>
              </div>
            `;
          })()}
        `);
        bottomDockRoot.append(dock);
      }
    }
  }

  render();
  return {
    rerender: render,
    refreshRules: async () => {
      await loadRules();
      await loadTraces();
      render();
    },
  };
}



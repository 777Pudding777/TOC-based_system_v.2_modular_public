// src/ui/panel.ts
import * as BUI from "@thatopen/ui";
import type { CameraPose } from "../viewer/api";
import type { VlmDecision, VlmVerdict } from "../modules/vlmChecker";
import type { ComplianceRule } from "../types/rule.types";
import type { ConversationTrace, SceneState, WebEvidenceRecord } from "../types/trace.types";
import type { RuleDb } from "../storage/ruleDb";
import type { TraceDb } from "../storage/traceDb";
import { downloadHtmlReport } from "../reporting/reportGenerator";
import { OPENROUTER_VISION_MODELS, getDefaultModel, findModelById } from "../config/openRouterModels";
import { DEFAULT_MAX_COMPLIANCE_STEPS } from "../config/prototypeSettings";
import { deleteDatabase } from "../storage/dbConfig";
import { buildPromptFromRule } from "../modules/vlmAdapters/prompts/promptWrappers";
import type { CompactTaskGraphState } from "../modules/taskGraph";

type ToastFn = (msg: string, ms?: number) => void;



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
    setPlanCut?: (p: { height?: number; absoluteHeight?: number; thickness?: number; mode?: "WORLD_UP" | "CAMERA" }) => Promise<void>;
    getRendererDomElement?: () => HTMLCanvasElement;
    pickObjectAt?: (x: number, y: number) => Promise<string | null>;
    highlightIds?: (ids: string[], style?: "primary" | "warn") => Promise<void>;
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
      onStep?: (step: number, decision: VlmDecision) => void;
      onProgress?: (update: {
        stage: "starting" | "seeded" | "captured" | "decision" | "followup" | "finished";
        step: number;
        summary: string;
        taskGraph?: CompactTaskGraphState;
        lastActionReason?: string | null;
        verdict?: VlmDecision["verdict"];
        confidence?: number;
      }) => void;
    }) => Promise<any>;
    parseCustomPose: (text: string) => CameraPose | null;
  };

  navigationAgent?: {
    goToCurrentIsolateSelection: (opts?: { smooth?: boolean; padding?: number }) => Promise<any>;
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
    complianceDb,
    complianceRunner,
    navigationAgent,
    ruleDb,
    traceDb,
  } = params;

  panelRoot.classList.add("hud-panel-root");

  // ───────────────── Local UI state ─────────────────
  let rulePrompt = "";
  let deterministicEnabled = false;
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
    | { state: "valid"; label: string; summary: string; checkedAtIso: string }
    | { state: "invalid"; error: string; checkedAtIso: string } = { state: "idle" };

  let openRouterAutoRefresh = true;
  let openRouterLastKeyForStatus = "";

  // ───────────────── Inspection state ─────────────────
  type InspectionStatus = "idle" | "running" | "completed" | "failed";
  let inspectionStatus: InspectionStatus = "idle";
  let inspectionStep = 0;
  const inspectionMaxSteps = DEFAULT_MAX_COMPLIANCE_STEPS;
  let inspectionTrace: ConversationTrace | null = null;
  let inspectionSceneStepIndex = -1;
  let inspectionError: string | null = null;
  let inspectionStartTime: number | null = null;
  let inspectionDecisions: VlmDecision[] = [];
  let inspectionTaskHud: CompactTaskGraphState | null = null;
  let inspectionLiveFeed: string[] = [];
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

  function formatOpenRouterBudget(json: any): { label: string; summary: string } {
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
      summary: parts.length ? parts.join(" • ") : "Key is valid (budget fields unavailable).",
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
      const { label, summary } = formatOpenRouterBudget(json);
      openRouterStatus = { state: "valid", label, summary, checkedAtIso: new Date().toISOString() };
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
    return `${(ms / 1000).toFixed(1)}s`;
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
      if (state.isolatedIds?.length && viewerApi.isolate) {
        const isolateMap = buildModelIdMapFromObjectIds(state.isolatedIds);
        if (Object.keys(isolateMap).length) {
          await viewerApi.isolate(isolateMap);
        } else {
          await viewerApi.resetVisibility();
        }
      } else if (state.isolatedStorey && viewerApi.isolateStorey) {
        await viewerApi.isolateStorey(state.isolatedStorey);
      } else if (state.isolatedSpace && viewerApi.isolateSpace) {
        await viewerApi.isolateSpace(state.isolatedSpace);
      } else if (state.isolatedCategories?.length && viewerApi.isolateCategory) {
        await viewerApi.isolateCategory(state.isolatedCategories[0]);
      } else {
        await viewerApi.resetVisibility();
      }

      if (state.hiddenIds?.length && viewerApi.hideIds) {
        await viewerApi.hideIds(state.hiddenIds);
      }

      if (state.planCut?.absoluteHeight != null && viewerApi.setPlanCut) {
        await viewerApi.setPlanCut({
          absoluteHeight: state.planCut.absoluteHeight,
          height: state.planCut.height,
          thickness: state.planCut.thickness,
          mode: state.planCut.mode === "CAMERA" ? "CAMERA" : "WORLD_UP",
        });
      } else if (viewerApi.clearPlanCut) {
        await viewerApi.clearPlanCut();
      }

      await viewerApi.setCameraPose(state.cameraPose, true);

      if (state.highlightedIds?.length && viewerApi.highlightIds) {
        await viewerApi.highlightIds(state.highlightedIds, "primary");
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


  // ───────────────── Compliance check (enhanced) ─────────────────
  async function startComplianceCheck() {
    const hasModel = viewerApi.hasModelLoaded();
    if (!hasModel) return toast?.("Load a model first.");

    // Determine prompt
    let prompt = "";
    let promptSource: "rule_library" | "custom_user_prompt" = "custom_user_prompt";
    let promptSourceLabel = "Custom Prompt";
    let sourceText = "";
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
    if (!sourceText) return toast?.("Please select a rule or enter a compliance prompt.");

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

    // Set inspection state
    inspectionStatus = "running";
    inspectionStep = 0;
    inspectionDecisions = [];
    inspectionTrace = null;
    inspectionError = null;
    inspectionStartTime = Date.now();
    inspectionTaskHud = null;
    inspectionLiveFeed = ["Preparing inspection run..."];
    render();

    try {
      let openRouterUsageBefore: number | null = null;
      if (vlmProvider === "openrouter") {
        openRouterUsageBefore = await fetchOpenRouterUsageValue(openRouterApiKey);
      }

      vlmChecker.resetRunWebEvidence();
      const res = await complianceRunner.start({
        prompt,
        deterministic,
        maxSteps: inspectionMaxSteps,
        onStep: (step, _decision) => {
          inspectionStep = step;
          render();
        },
        onProgress: (update) => {
          inspectionStep = Math.max(inspectionStep, update.step);
          inspectionTaskHud = update.taskGraph ?? inspectionTaskHud;
          if (update.summary) {
            const last = inspectionLiveFeed[inspectionLiveFeed.length - 1];
            if (last !== update.summary) {
              inspectionLiveFeed = [...inspectionLiveFeed, update.summary].slice(-5);
            }
          }
          render();
        },
      });

      if (res?.ok === false && (!res.decisions || res.decisions.length === 0)) {
        inspectionStatus = "failed";
        inspectionError = res.reason ?? "Compliance check failed";
      } else {
        inspectionStatus = "completed";
        // Build a trace from results
        const endTime = Date.now();
        const startTime = inspectionStartTime ?? endTime;
        const decisions: VlmDecision[] = res?.decisions ?? inspectionDecisions;
        const webEvidenceRecords = [...(vlmChecker.getRunWebEvidence() ?? [])].sort(
          (a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime()
        );
        const ruleInfo = selectedRule
          ? { id: selectedRule.id, title: selectedRule.title, description: selectedRule.description, category: selectedRule.category, severity: selectedRule.severity }
          : { id: "custom", title: "Custom Rule", description: prompt.slice(0, 200), category: "custom", severity: "moderate" };

        console.log("[TRACE] getRunWebEvidence()", vlmChecker.getRunWebEvidence());  
        const run = snapshotCollector.getRun();
        const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : [];
        let complianceUsageDelta: number | null = null;
        if (vlmProvider === "openrouter") {
          const openRouterUsageAfter = await fetchOpenRouterUsageValue(openRouterApiKey);
          if (
            typeof openRouterUsageBefore === "number" &&
            isFinite(openRouterUsageBefore) &&
            typeof openRouterUsageAfter === "number" &&
            isFinite(openRouterUsageAfter)
          ) {
            complianceUsageDelta = Math.max(0, openRouterUsageAfter - openRouterUsageBefore);
          }
        }
        const modelId = vlmProvider === "openrouter" ? openRouterModel : vlmProvider === "openai" ? openAiModel : "mock";
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
          imageBase64: artifact.images?.[0]?.imageBase64Png,
        }));
        const sceneStates: SceneState[] = artifacts.map((artifact: any, index: number) => {
          const context = artifact.meta?.context ?? {};
          const planCut = context.planCut && typeof context.planCut === "object"
            ? {
                height: typeof context.planCut.height === "number" ? context.planCut.height : undefined,
                absoluteHeight:
                  typeof context.planCut.absoluteHeight === "number" ? context.planCut.absoluteHeight : undefined,
                thickness: typeof context.planCut.thickness === "number" ? context.planCut.thickness : undefined,
                mode: typeof context.planCut.mode === "string" ? context.planCut.mode : undefined,
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
          };
        });
        const trace: ConversationTrace = {
          traceId: crypto.randomUUID(),
          runId: res?.runId ?? crypto.randomUUID(),
          rule: ruleInfo,
          model: {
          id: modelId,
            provider: vlmProvider,
            name: vlmChecker.adapterName,
          },
          startedAt: new Date(startTime).toISOString(),
          completedAt: new Date(endTime).toISOString(),
          status: "completed",
          prompts: decisions.map((d: VlmDecision, i: number) => ({
            step: i + 1,
            promptText: getPromptTextForReport(d, prompt),
            promptSource,
            promptSourceLabel,
            sourceText,
            webSourcesUsed: getStepWebSources(i),
            ruleContext: {
              ruleId: selectedRule?.id ?? "custom",
              ruleTitle: selectedRule?.title ?? "Custom Rule",
              ruleDescription: selectedRule?.description ?? prompt.slice(0, 200),
              evaluationCriteria: selectedRule?.evaluationCriteria ?? { pass: [], fail: [], uncertain: [] },
              visualEvidence:
                selectedRule?.visualEvidence ??
                { lookFor: [], passIndicators: [], failIndicators: [], uncertainIndicators: [] },
            },
            snapshotIds: d.evidence?.snapshotIds ?? [],
            timestamp: d.timestampIso,
            modelId,
          })),
          responses: decisions.map((d: VlmDecision, i: number) => ({
            step: i + 1,
            decision: d,
            responseTimeMs: 0,
            timestamp: d.timestampIso,
          })),
          snapshots,
          navigationActions: [],
          sceneStates,
          stepMetrics: [],
          stressedFindings: [],
          finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : undefined,
          finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : undefined,
          finalRationale: decisions.length > 0 ? decisions[decisions.length - 1].rationale : undefined,
          metrics: {
            totalSnapshots: snapshots.length,
            totalVlmCalls: decisions.length,
            totalNavigationSteps: 0,
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
        console.log("[TRACE] trace.webEvidence", trace.webEvidence);
        
        inspectionTrace = trace;
        syncSceneStepIndex(trace);
        await traceDb.saveTrace(trace);
        await loadTraces();
        toast?.(`Inspection complete: ${trace.finalVerdict ?? "N/A"}`);
      }
    } catch (e: any) {
      console.error("[Panel] Compliance error:", e);
      inspectionStatus = "failed";
      inspectionError = e?.message ?? "Compliance error (see console).";
    }

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

    const loadLabel = loading ? "Loading…" : hasModel ? "Replace model (upload new)" : "Load local IFC";

    const panel = BUI.Component.create(() => BUI.html`
      <bim-panel class="hud-panel">

        <!-- ═══════════ MODEL SECTION ═══════════ -->
        <bim-panel-section label="Model">
          <bim-button label=${loadLabel} ?disabled=${loading}
            @click=${() => { if (!loading) upload.openFileDialog(); }}></bim-button>
          <bim-button label="ISO view" ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.setPresetView("iso", true)}></bim-button>
          <bim-button label="Top view" ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.setPresetView("top", true)}></bim-button>
          <bim-button label="Reset visibility" ?disabled=${loading || !hasModel}
            @click=${async () => viewerApi.resetVisibility()}></bim-button>
          <div class="panel-tip">
            Tip: <b>Ctrl+Click</b> Storey/Space in the tree to isolate.
          </div>
        </bim-panel-section>

        <!-- ═══════════ VLM PROVIDER SECTION ═══════════ -->
        <bim-panel-section label="VLM Provider">
          <div class="hud-stack">
            <div style="display:flex;gap:8px;align-items:center;">
              <span style="color:#fff;opacity:0.9;font-size:12px;">Provider:</span>
              <select style="flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                @change=${(e: any) => { vlmProvider = String(e.target.value) as any; render(); }}>
                <option value="mock" ?selected=${vlmProvider === "mock"}>Mock (deterministic)</option>
                <option value="openrouter" ?selected=${vlmProvider === "openrouter"}>OpenRouter (VLM)</option>
                <option value="openai" ?selected=${vlmProvider === "openai"}>OpenAI / ChatGPT</option>
              </select>
            </div>

            ${vlmProvider === "openai" ? BUI.html`
              <input style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="OpenAI API key (dev/test only — client-side)" type="password" .value=${openAiApiKey}
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
                placeholder="OpenRouter API key (dev/test only — client-side)" type="password" .value=${openRouterApiKey}
                @input=${(e: any) => { openRouterApiKey = e.target.value; openRouterStatus = { state: "idle" }; openRouterLastKeyForStatus = ""; }}
                @blur=${() => { const k = (openRouterApiKey ?? "").trim(); if (k) void validateOpenRouterKey(k); }}/>
              <select style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                @change=${(e: any) => { openRouterModel = e.target.value; render(); }}>
                ${OPENROUTER_VISION_MODELS.map((m) => BUI.html`
                  <option value=${m.id} ?selected=${openRouterModel === m.id}>
                    ${m.label} (${m.provider})
                  </option>
                `)}
              </select>
              ${(() => {
                const info = findModelById(openRouterModel);
                return info ? BUI.html`
                  <div style="color:rgba(255,255,255,0.6);font-size:10px;line-height:1.3;padding:0 2px;">
                    ${info.description}<br/>
                    <span style="opacity:0.7;">ID: ${info.id}</span>
                  </div>
                ` : null;
              })()}
              <div style="display:flex;gap:8px;align-items:center;">
                <bim-button label=${openRouterStatus.state === "checking" ? "Checking…" : "Validate key"}
                  ?disabled=${openRouterStatus.state === "checking"}
                  @click=${() => void validateOpenRouterKey((openRouterApiKey ?? "").trim())}></bim-button>
                <label style="display:flex;align-items:center;gap:6px;color:#fff;opacity:0.85;font-size:12px;">
                  <input type="checkbox" .checked=${openRouterAutoRefresh}
                    @change=${(e: any) => { openRouterAutoRefresh = !!e.target.checked; }}/>Auto-refresh
                </label>
              </div>
              <div style="color:#fff;opacity:0.85;font-size:12px;line-height:1.35;">
                ${openRouterStatus.state === "idle" ? "Status: not validated."
                  : openRouterStatus.state === "checking" ? "Status: validating key…"
                  : openRouterStatus.state === "invalid" ? `Status: invalid — ${openRouterStatus.error}`
                  : `Status: valid — ${openRouterStatus.label}\n${openRouterStatus.summary} Checked: ${openRouterStatus.checkedAtIso}`}
              </div>
            ` : null}

            <bim-button label="Apply provider" @click=${() => {
              try {
                if (vlmProvider === "openrouter") {
                  const k = (openRouterApiKey ?? "").trim();
                  if (!k) { toast?.("OpenRouter key missing."); return; }
                  if (openRouterStatus.state !== "valid" || openRouterLastKeyForStatus !== k) {
                    validateOpenRouterKey(k);
                    if (openRouterStatus.state !== "valid") { toast?.("OpenRouter key invalid. Fix and try again."); return; }
                  }
                  vlmChecker.setConfig({ provider: "openrouter", openrouter: { apiKey: k, model: (openRouterModel ?? "").trim() } });
                } else if (vlmProvider === "openai") {
                  vlmChecker.setConfig({ provider: "openai", openai: { apiKey: openAiApiKey, model: openAiModel, endpoint: openAiEndpoint || undefined, imageDetail: "high", requestTimeoutMs: 45_000 } });
                } else {
                  vlmChecker.setConfig({ provider: "mock" });
                }
                toast?.(`VLM provider set: ${vlmChecker.adapterName}`);
                render();
              } catch (e) { console.error(e); toast?.("Failed to apply provider (see console)."); }
            }}></bim-button>

            <div style="color:#fff;opacity:0.75;font-size:11px;">
              Determinism: requests use temperature=0 and strict JSON schema. Provider/model are stored locally for reproducibility.
            </div>
          </div>
        </bim-panel-section>

        <!-- ═══════════ COMPLIANCE CHECKING SECTION (enhanced) ═══════════ -->
        <bim-panel-section label="Compliance Checking">
          <div class="hud-stack">

            <!-- ── Status indicator (when running/completed) ── -->
            ${inspectionStatus !== "idle" ? BUI.html`
              <div style="padding:8px;background:rgba(0,0,0,0.25);border-radius:8px;text-align:center;border:1px solid ${
                inspectionStatus === "running" ? "rgba(59,130,246,0.5)"
                : inspectionStatus === "completed" ? "rgba(34,197,94,0.5)"
                : "rgba(239,68,68,0.5)"
              };">
                <div style="color:#fff;font-size:13px;">
                  Status: <strong>${inspectionStatus.toUpperCase()}</strong>
                  ${inspectionStatus === "running" ? ` — Step ${inspectionStep}/${inspectionMaxSteps}` : ""}
                </div>
                ${inspectionTrace?.finalVerdict ? BUI.html`
                  <div style="margin-top:4px;display:inline-block;" .innerHTML=${verdictBadgeHtml(inspectionTrace.finalVerdict)}></div>
                  <span style="color:#fff;font-size:12px;margin-left:6px;">
                    ${((inspectionTrace.finalConfidence ?? 0) * 100).toFixed(0)}% confidence
                  </span>
                ` : null}
              </div>
            ` : null}

            <!-- ── Rule input mode selector ── -->
            <div style="display:flex;gap:4px;">
              <button style="flex:1;padding:6px;border-radius:6px 0 0 6px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;
                color:#fff;font-size:12px;background:${ruleInputMode === "library" ? "rgba(59,130,246,0.4)" : "rgba(0,0,0,0.25)"};"
                @click=${() => { ruleInputMode = "library"; render(); }}>Rule Library</button>
              <button style="flex:1;padding:6px;border-radius:0 6px 6px 0;border:1px solid rgba(255,255,255,0.15);cursor:pointer;
                color:#fff;font-size:12px;background:${ruleInputMode === "custom" ? "rgba(59,130,246,0.4)" : "rgba(0,0,0,0.25)"};"
                @click=${() => { ruleInputMode = "custom"; render(); }}>Custom Prompt</button>
            </div>

            <!-- ── Rule Library dropdown ── -->
            ${ruleInputMode === "library" ? BUI.html`
              <select style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                @change=${(e: any) => {
                  const ruleId = e.target.value;
                  selectedRule = rules.find((r) => r.id === ruleId) ?? null;
                  render();
                }}>
                <option value="" ?selected=${!selectedRule}>-- Select a compliance rule --</option>
                ${rules.map((rule) => BUI.html`
                  <option value=${rule.id} ?selected=${selectedRule?.id === rule.id}>
                    ${rule.title} (${rule.category})
                  </option>
                `)}
              </select>

              ${selectedRule ? BUI.html`
                <div style="padding:10px;background:rgba(0,0,0,0.2);border-radius:8px;border:1px solid rgba(255,255,255,0.08);">
                  <div style="color:#fff;font-weight:600;font-size:13px;margin-bottom:4px;">${selectedRule.title}</div>
                  <div style="color:rgba(255,255,255,0.75);font-size:11px;margin-bottom:8px;line-height:1.4;">${selectedRule.description}</div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <span style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;">${selectedRule.category}</span>
                    <span style="background:${selectedRule.severity === "critical" ? "#ef4444" : selectedRule.severity === "moderate" ? "#f59e0b" : "#22c55e"};color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;">${selectedRule.severity}</span>
                    <span style="background:rgba(255,255,255,0.15);color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;">
                      VLM: ${((selectedRule.visualSuitability?.confidence ?? 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              ` : BUI.html`
                <div style="color:rgba(255,255,255,0.5);font-size:11px;text-align:center;padding:8px;">
                  ${rules.length === 0 ? "No rules loaded. Check rule library initialization." : "Select a rule above to begin."}
                </div>
              `}
            ` : BUI.html`
              <!-- ── Custom prompt textarea (existing behavior) ── -->
              <textarea
                style="width:100%;min-height:92px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                placeholder="Enter the compliance rule / prompt here…"
                @input=${(e: any) => { rulePrompt = e.target.value; }}
              >${rulePrompt}</textarea>
            `}

            <!-- ── Deterministic start ── -->
            <label style="display:flex;align-items:center;gap:8px;color:#fff;opacity:0.9;">
              <input type="checkbox" .checked=${deterministicEnabled}
                @change=${(e: any) => { deterministicEnabled = !!e.target.checked; render(); }}/>
              Deterministic start
            </label>

            <div style="display:flex;gap:8px;align-items:center;">
              <span style="color:#fff;opacity:0.9;font-size:12px;">Start view:</span>
              <select style="flex:1;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
                ?disabled=${!deterministicEnabled}
                @change=${(e: any) => { deterministicMode = String(e.target.value) as any; render(); }}>
                <option value="iso" ?selected=${deterministicMode === "iso"}>ISO</option>
                <option value="top" ?selected=${deterministicMode === "top"}>Top</option>
                <option value="custom" ?selected=${deterministicMode === "custom"}>Custom pose</option>
              </select>
            </div>

            ${deterministicEnabled && deterministicMode === "custom" ? BUI.html`
              <textarea
                style="width:100%;min-height:96px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"
                @input=${(e: any) => { customPoseText = e.target.value; }}
              >${customPoseText}</textarea>
              <div style="color:#fff;opacity:0.75;font-size:11px;">
                Expected: {"{"}"eye":{"{"}"x,y,z{"}"},"target":{"{"}"x,y,z{"}"}{"}"}
              </div>
            ` : null}

            <!-- ── Start checking button ── -->
            <bim-button
              label=${inspectionStatus === "running" ? "Running…" : `Start checking (${vlmChecker.adapterName})`}
              ?disabled=${loading || !hasModel || inspectionStatus === "running" || (ruleInputMode === "library" && !selectedRule)}
              @click=${async () => startComplianceCheck()}
            ></bim-button>

            <!-- ── Progress bar when running ── -->
            ${inspectionStatus === "running" ? BUI.html`
              <div style="padding:8px;background:rgba(0,0,0,0.2);border-radius:8px;">
                <div style="color:#fff;font-size:11px;margin-bottom:4px;">Running inspection…</div>
                <div style="height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
                  <div style="height:100%;width:${Math.max(10, (inspectionStep / inspectionMaxSteps) * 100)}%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);transition:width 0.3s;border-radius:3px;"></div>
                </div>
                ${inspectionTaskHud ? BUI.html`
                  <div style="margin-top:8px;padding:8px;background:rgba(255,255,255,0.04);border-radius:6px;border:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:4px;">
                    <div style="color:#fff;font-size:11px;font-weight:600;">Current task brief</div>
                    <div style="color:rgba(255,255,255,0.78);font-size:11px;">
                      ${inspectionTaskHud.activeTask?.title ?? "Preparing current task..."}
                    </div>
                    <div style="color:rgba(255,255,255,0.6);font-size:10px;">
                      ${inspectionTaskHud.activeEntity?.id ? `Entity: ${inspectionTaskHud.activeEntity.id}` : "Entity: none"}
                      ${inspectionTaskHud.activeStoreyId ? ` • Storey: ${inspectionTaskHud.activeStoreyId}` : ""}
                    </div>
                    <div style="color:rgba(255,255,255,0.6);font-size:10px;">
                      Progress: ${inspectionTaskHud.progress.completedRequired}/${inspectionTaskHud.progress.totalRequired}
                      ${inspectionTaskHud.progress.totalEntities ? ` • Entities: ${inspectionTaskHud.progress.completedEntities}/${inspectionTaskHud.progress.totalEntities}` : ""}
                    </div>
                    ${inspectionTaskHud.nextEntityIds.length ? BUI.html`
                      <div style="color:rgba(255,255,255,0.55);font-size:10px;">
                        Next: ${inspectionTaskHud.nextEntityIds.join(", ")}
                      </div>
                    ` : null}
                  </div>
                ` : null}
                ${inspectionLiveFeed.length ? BUI.html`
                  <div style="margin-top:8px;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px;border:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;gap:4px;">
                    <div style="color:#fff;font-size:11px;font-weight:600;">Inspection activity</div>
                    ${inspectionLiveFeed.slice().reverse().map((entry) => BUI.html`
                      <div style="color:rgba(255,255,255,0.72);font-size:10px;line-height:1.35;">${entry}</div>
                    `)}
                  </div>
                ` : null}
              </div>
            ` : null}

            <!-- ── Results when completed ── -->
            ${inspectionStatus === "completed" && inspectionTrace ? BUI.html`
              <div style="padding:10px;background:rgba(0,0,0,0.2);border-radius:8px;border:1px solid rgba(34,197,94,0.3);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                  <span .innerHTML=${verdictBadgeHtml(inspectionTrace.finalVerdict)}></span>
                  <span style="color:#fff;font-size:13px;">Confidence: ${((inspectionTrace.finalConfidence ?? 0) * 100).toFixed(0)}%</span>
                </div>
                ${inspectionTrace.finalRationale ? BUI.html`
                  <div style="color:rgba(255,255,255,0.75);font-size:11px;line-height:1.4;margin-bottom:8px;">${inspectionTrace.finalRationale}</div>
                ` : null}

                <!-- Metrics grid -->
                ${inspectionTrace.metrics ? BUI.html`
                  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px;">
                    <div style="text-align:center;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;">
                      <div style="color:#fff;font-size:16px;font-weight:700;">${inspectionTrace.metrics.totalSnapshots}</div>
                      <div style="color:rgba(255,255,255,0.5);font-size:9px;">Snapshots</div>
                    </div>
                    <div style="text-align:center;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;">
                      <div style="color:#fff;font-size:16px;font-weight:700;">${inspectionTrace.metrics.totalVlmCalls}</div>
                      <div style="color:rgba(255,255,255,0.5);font-size:9px;">VLM Calls</div>
                    </div>
                    <div style="text-align:center;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;">
                      <div style="color:#fff;font-size:16px;font-weight:700;">${formatDuration(inspectionTrace.metrics.totalDurationMs)}</div>
                      <div style="color:rgba(255,255,255,0.5);font-size:9px;">Duration</div>
                    </div>
                  </div>
                ` : null}

                <!-- Export buttons -->
                <div style="display:flex;gap:6px;">
                  <bim-button label="Generate Report" @click=${exportHtmlReport}></bim-button>
                  <bim-button label="Export Trace" @click=${exportTraceJson}></bim-button>
                </div>
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
                          <div class="hud-stepper-subtle">${sceneDetails.join(" • ")}</div>
                        ` : null}
                      </div>
                    `;
                  })()}
                  <div class="hud-stepper">
                    <button
                      type="button"
                      class="hud-stepper-arrow"
                      ?disabled=${inspectionSceneStepIndex <= 0}
                      @click=${() => void restoreSceneState(inspectionTrace, inspectionSceneStepIndex - 1)}
                      aria-label="Previous inspection step"
                    >
                      ‹
                    </button>
                    <div class="hud-stepper-count">
                      ${inspectionSceneStepIndex + 1}
                    </div>
                    <button
                      type="button"
                      class="hud-stepper-arrow"
                      ?disabled=${inspectionSceneStepIndex >= getSceneStates(inspectionTrace).length - 1}
                      @click=${() => void restoreSceneState(inspectionTrace, inspectionSceneStepIndex + 1)}
                      aria-label="Next inspection step"
                    >
                      ›
                    </button>
                  </div>
                ` : null}
              </div>
            ` : null}

            <!-- ── Error display ── -->
            ${inspectionStatus === "failed" && inspectionError ? BUI.html`
              <div style="padding:10px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:8px;">
                <div style="color:#ef4444;font-weight:600;font-size:12px;margin-bottom:2px;">Inspection Failed</div>
                <div style="color:rgba(255,255,255,0.75);font-size:11px;">${inspectionError}</div>
              </div>
            ` : null}

            <div style="color:#fff;opacity:0.75;font-size:11px;">
              One rule per project: Start will reset state, then capture the first snapshot and run the checker.
            </div>
          </div>
        </bim-panel-section>

        <!-- ═══════════ INSPECTION HISTORY (collapsed) ═══════════ -->
        <bim-panel-section label="Inspection History" ?collapsed=${recentTraces.length === 0}>
          <div class="hud-stack">
            ${recentTraces.length === 0 ? BUI.html`
              <div class="hud-empty-state">
                No inspection runs saved yet.
              </div>
            ` : BUI.html`
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
            `}
            <bim-button
              label="Clear History"
              ?disabled=${recentTraces.length === 0}
              @click=${async () => {
                await traceDb.clearAll();
                await loadTraces();
                inspectionTrace = null;
                inspectionSceneStepIndex = -1;
                inspectionStatus = "idle";
                render();
                toast?.("History cleared.");
              }}
            ></bim-button>
          </div>
        </bim-panel-section>

        <!-- ═══════════ DEBUG SECTION ═══════════ -->
        <bim-panel-section label="Debug">
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
                inspectionTrace = null;
                inspectionError = null;
                rules = [];
                recentTraces = [];
                render();
                toast?.("Project reset: all databases cleared. Reload to re-initialize rules.");
              } catch (err) { console.error(err); toast?.("Reset failed (see console)."); }
            }}></bim-button>
        </bim-panel-section>

      </bim-panel>
    `);

    panelRoot.append(panel);
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

// src/ui/panel.ts
import * as BUI from "@thatopen/ui";
import type { CameraPose } from "../viewer/api";
import type { VlmDecision, VlmVerdict } from "../modules/vlmChecker";
import type { ComplianceRule } from "../types/rule.types";
import type { ConversationTrace, WebEvidenceRecord } from "../types/trace.types";
import type { RuleDb } from "../storage/ruleDb";
import type { TraceDb } from "../storage/traceDb";
import { downloadHtmlReport } from "../reporting/reportGenerator";
import { OPENROUTER_VISION_MODELS, getDefaultModel, findModelById } from "../config/openRouterModels";
import { deleteDatabase } from "../storage/dbConfig";

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
  const inspectionMaxSteps = 6;
  let inspectionTrace: ConversationTrace | null = null;
  let inspectionError: string | null = null;
  let inspectionStartTime: number | null = null;
  let inspectionDecisions: VlmDecision[] = [];

  // Rule library state
  let rules: ComplianceRule[] = [];
  let selectedRule: ComplianceRule | null = null;
  let ruleInputMode: "library" | "custom" = "custom"; // default to custom so existing behavior preserved

  // Recent traces
  let recentTraces: ConversationTrace[] = [];

  // ───────────────── Load rules and traces ─────────────────
  async function loadRules() {
    try {
      rules = await ruleDb.listEnabledRules();
    } catch (e) {
      console.error("[Panel] Failed to load rules:", e);
      rules = [];
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

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function verdictBadgeHtml(verdict?: VlmVerdict): string {
    const colors: Record<string, string> = { PASS: "#22c55e", FAIL: "#ef4444", UNCERTAIN: "#f59e0b" };
    const color = verdict ? colors[verdict] : "#6b7280";
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${verdict ?? "PENDING"}</span>`;
  }

  // ───────────────── Build VLM prompt from rule ─────────────────
  function buildPromptFromRule(rule: ComplianceRule): string {
    const parts = [
      `COMPLIANCE RULE: ${rule.title}`,
      ``,
      `DESCRIPTION: ${rule.description}`,
      ``,
      `CATEGORY: ${rule.category}`,
      `SEVERITY: ${rule.severity}`,
      ``,
      `WHAT TO LOOK FOR:`,
      ...rule.visualEvidence.lookFor.map((item) => `- ${item}`),
      ``,
      `PASS INDICATORS:`,
      ...rule.visualEvidence.passIndicators.map((item) => `- ${item}`),
      ``,
      `FAIL INDICATORS:`,
      ...rule.visualEvidence.failIndicators.map((item) => `- ${item}`),
      ``,
      `EVALUATION CRITERIA:`,
      `PASS if: ${rule.evaluationCriteria.pass.join("; ")}`,
      `FAIL if: ${rule.evaluationCriteria.fail.join("; ")}`,
      `UNCERTAIN if: ${rule.evaluationCriteria.uncertain.join("; ")}`,
      ``,
      `NAVIGATION HINTS:`,
      `Recommended views: ${rule.navigationHints.recommendedViews.join(", ")}`,
      `Zoom level: ${rule.navigationHints.zoomLevel ?? "medium"}`,
      ...(rule.navigationHints.tips || []).map((tip) => `- ${tip}`),
    ];
    return parts.join("\n");
  }

  // ───────────────── Compliance check (enhanced) ─────────────────
  async function startComplianceCheck() {
    const hasModel = viewerApi.hasModelLoaded();
    if (!hasModel) return toast?.("Load a model first.");

    // Determine prompt
    let prompt = "";
    if (ruleInputMode === "library" && selectedRule) {
      prompt = buildPromptFromRule(selectedRule);
    } else {
      prompt = (rulePrompt ?? "").trim();
    }
    if (!prompt) return toast?.("Please select a rule or enter a compliance prompt.");

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
    render();

    try {
      vlmChecker.resetRunWebEvidence();
      const res = await complianceRunner.start({
        prompt,
        deterministic,
        maxSteps: inspectionMaxSteps,
        onStep: (step, _decision) => {
          inspectionStep = step;
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
        const ruleInfo = selectedRule
          ? { id: selectedRule.id, title: selectedRule.title, description: selectedRule.description, category: selectedRule.category, severity: selectedRule.severity }
          : { id: "custom", title: "Custom Rule", description: prompt.slice(0, 200), category: "custom", severity: "moderate" };

        console.log("[TRACE] getRunWebEvidence()", vlmChecker.getRunWebEvidence());  
        const trace: ConversationTrace = {
          traceId: crypto.randomUUID(),
          runId: res?.runId ?? crypto.randomUUID(),
          rule: ruleInfo,
          model: {
            id: vlmProvider === "openrouter" ? openRouterModel : vlmProvider === "openai" ? openAiModel : "mock",
            provider: vlmProvider,
            name: vlmChecker.adapterName,
          },
          startedAt: new Date(startTime).toISOString(),
          completedAt: new Date(endTime).toISOString(),
          status: "completed",
          prompts: [],
          responses: decisions.map((d: VlmDecision, i: number) => ({
            step: i + 1,
            decision: d,
            responseTimeMs: 0,
            timestamp: d.timestampIso,
          })),
          snapshots: [],
          navigationActions: [],
          sceneStates: [],
          stepMetrics: [],
          stressedFindings: [],
          finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : undefined,
          finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : undefined,
          finalRationale: decisions.length > 0 ? decisions[decisions.length - 1].rationale : undefined,
          metrics: {
            totalSnapshots: res?.snapshots ?? decisions.length,
            totalVlmCalls: decisions.length,
            totalNavigationSteps: 0,
            totalDurationMs: endTime - startTime,
            avgVlmResponseTimeMs: 0,
            avgConfidence: decisions.length > 0 ? decisions.reduce((s: number, d: VlmDecision) => s + d.confidence, 0) / decisions.length : 0,
            finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : "UNCERTAIN",
            finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : 0,
            uncertainSteps: decisions.filter((d: VlmDecision) => d.verdict === "UNCERTAIN").length,
            failureNotes: [],
          },
          webEvidence: vlmChecker.getRunWebEvidence(),
        };
        console.log("[TRACE] trace.webEvidence", trace.webEvidence);
        
        inspectionTrace = trace;
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
      <bim-panel>

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
          <div style="font-size:12px;margin-top:8px;color:#fff;opacity:0.9;text-shadow:0 1px 2px rgba(0,0,0,0.6);">
            Tip: <b>Ctrl+Click</b> Storey/Space in the tree to isolate.
          </div>
        </bim-panel-section>

        <!-- ═══════════ VLM PROVIDER SECTION ═══════════ -->
        <bim-panel-section label="VLM Provider">
          <div style="display:flex;flex-direction:column;gap:8px;">
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
          <div style="display:flex;flex-direction:column;gap:8px;">

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
                @click=${() => { ruleInputMode = "library"; render(); }}>📋 Rule Library</button>
              <button style="flex:1;padding:6px;border-radius:0 6px 6px 0;border:1px solid rgba(255,255,255,0.15);cursor:pointer;
                color:#fff;font-size:12px;background:${ruleInputMode === "custom" ? "rgba(59,130,246,0.4)" : "rgba(0,0,0,0.25)"};"
                @click=${() => { ruleInputMode = "custom"; render(); }}>✏️ Custom Prompt</button>
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
        ${recentTraces.length > 0 ? BUI.html`
          <bim-panel-section label="Inspection History" collapsed>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${recentTraces.map((trace) => BUI.html`
                <div style="padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;cursor:pointer;"
                  @click=${async () => {
                    const fullTrace = await traceDb.getTrace(trace.traceId);
                    if (fullTrace) {
                      inspectionTrace = fullTrace;
                      inspectionStatus = fullTrace.status === "completed" ? "completed" : "failed";
                      inspectionError = fullTrace.errorMessage ?? null;
                      render();
                    }
                  }}>
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#fff;font-size:11px;font-weight:500;">${trace.rule.title}</span>
                    <span .innerHTML=${verdictBadgeHtml(trace.finalVerdict)}></span>
                  </div>
                  <div style="color:rgba(255,255,255,0.5);font-size:10px;margin-top:2px;">
                    ${new Date(trace.startedAt).toLocaleString()}
                  </div>
                </div>
              `)}
            </div>
            <bim-button label="Clear History" style="margin-top:8px;"
              @click=${async () => {
                await traceDb.clearAll();
                await loadTraces();
                inspectionTrace = null;
                inspectionStatus = "idle";
                render();
                toast?.("History cleared.");
              }}></bim-button>
          </bim-panel-section>
        ` : null}

        <!-- ═══════════ DEBUG SECTION ═══════════ -->
        <bim-panel-section label="Debug">
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

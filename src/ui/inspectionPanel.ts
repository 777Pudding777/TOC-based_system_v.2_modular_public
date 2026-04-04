/**
 * src/ui/inspectionPanel.ts
 * End-to-end inspection UI component with rule selection, model selection,
 * live progress tracking, and export capabilities.
 *
 * @module inspectionPanel
 */

import * as BUI from "@thatopen/ui";
import type { ComplianceRule } from "../types/rule.types";
import type { ConversationTrace, InspectionMetrics, StressedFinding } from "../types/trace.types";
import type { VlmDecision, VlmVerdict } from "../modules/vlmChecker";
import type { RuleDb } from "../storage/ruleDb";
import type { TraceDb } from "../storage/traceDb";
import { downloadHtmlReport } from "../reporting/reportGenerator";
import { buildPromptFromRule } from "../modules/vlmAdapters/prompts/promptWrappers";
import { DEFAULT_MAX_COMPLIANCE_STEPS } from "../config/prototypeSettings";

type ToastFn = (msg: string, ms?: number) => void;

/**
 * OpenRouter model options for visual compliance checking
 */
const OPENROUTER_MODELS = [
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", recommended: true },
  { id: "openai/gpt-4o", name: "GPT-4o" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "google/gemini-pro-vision", name: "Gemini Pro Vision" },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
  { id: "anthropic/claude-3-opus", name: "Claude 3 Opus" },
  { id: "anthropic/claude-3-haiku", name: "Claude 3 Haiku" },
  { id: "meta-llama/llama-3.2-90b-vision-instruct", name: "Llama 3.2 90B Vision" },
];

/**
 * Inspection state
 */
interface InspectionState {
  status: "idle" | "selecting" | "running" | "completed" | "failed";
  selectedRule: ComplianceRule | null;
  selectedModel: string;
  currentStep: number;
  totalSteps: number;
  decisions: VlmDecision[];
  metrics: InspectionMetrics | null;
  findings: StressedFinding[];
  trace: ConversationTrace | null;
  error: string | null;
  startTime: number | null;
}

/**
 * Mount the inspection panel UI
 */
export function mountInspectionPanel(params: {
  panelRoot: HTMLDivElement;
  ruleDb: RuleDb;
  traceDb: TraceDb;
  viewerApi: {
    hasModelLoaded: () => boolean;
    resetVisibility: () => Promise<void>;
    getCameraPose: () => Promise<any>;
  };
  vlmChecker: {
    adapterName: string;
    check: (input: {
      prompt: string;
      artifacts: any[];
      evidenceViews: any[];
    }) => Promise<VlmDecision>;
    setConfig: (cfg: any) => void;
    getConfig: () => any;
  };
  complianceRunner: {
    start: (params: any) => Promise<any>;
  };
  snapshotCollector: {
    reset: () => Promise<void>;
    getRun: () => any;
  };
  toast?: ToastFn;
  onInspectionComplete?: (trace: ConversationTrace) => void;
}) {
  const {
    panelRoot,
    ruleDb,
    traceDb,
    viewerApi,
    vlmChecker,
    complianceRunner,
    snapshotCollector: _snapshotCollector, // Reserved for future use (snapshot reset before inspection)
    toast,
    onInspectionComplete,
  } = params;

  // Local state
  const state: InspectionState = {
    status: "idle",
    selectedRule: null,
    selectedModel: OPENROUTER_MODELS[0].id,
    currentStep: 0,
    totalSteps: DEFAULT_MAX_COMPLIANCE_STEPS,
    decisions: [],
    metrics: null,
    findings: [],
    trace: null,
    error: null,
    startTime: null,
  };

  // Rule library cache
  let rules: ComplianceRule[] = [];
  let traces: ConversationTrace[] = [];

  /**
   * Load rules from database
   */
  async function loadRules() {
    try {
      rules = (await ruleDb.listEnabledRules()).slice().sort((a, b) => {
        const categoryCmp = a.category.localeCompare(b.category);
        if (categoryCmp !== 0) return categoryCmp;
        return a.title.localeCompare(b.title);
      });
      if (state.selectedRule) {
        state.selectedRule = rules.find((rule) => rule.id === state.selectedRule?.id) ?? null;
      }
    } catch (e) {
      console.error("[InspectionPanel] Failed to load rules:", e);
      rules = [];
      state.selectedRule = null;
    }
  }

  /**
   * Load recent traces
   */
  async function loadTraces() {
    try {
      traces = await traceDb.listRecentTraces(10);
    } catch (e) {
      console.error("[InspectionPanel] Failed to load traces:", e);
      traces = [];
    }
  }

  /**
   * Format duration for display
   */
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  /**
   * Get verdict badge HTML
   */
  function getVerdictBadge(verdict: VlmVerdict | undefined): string {
    const colors: Record<string, string> = {
      PASS: "#22c55e",
      FAIL: "#ef4444",
      UNCERTAIN: "#f59e0b",
    };
    const color = verdict ? colors[verdict] : "#6b7280";
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${verdict ?? "PENDING"}</span>`;
  }

  /**
   * Start inspection with selected rule
   */
  async function startInspection() {
    if (!state.selectedRule) {
      toast?.("Please select a rule first.");
      return;
    }

    if (!viewerApi.hasModelLoaded()) {
      toast?.("Please load a model first.");
      return;
    }

    // Update VLM config with selected model
    const currentConfig = vlmChecker.getConfig();
    if (currentConfig?.provider === "openrouter") {
      vlmChecker.setConfig({
        ...currentConfig,
        openrouter: {
          ...currentConfig.openrouter,
          model: state.selectedModel,
        },
      });
    }

    // Reset state
    state.status = "running";
    state.currentStep = 0;
    state.decisions = [];
    state.findings = [];
    state.error = null;
    state.startTime = Date.now();
    render();

    try {
      // Build prompt from rule
      const rule = state.selectedRule;
      const prompt = buildPromptFromRule(rule);

      // Start compliance run
      const result = await complianceRunner.start({
        prompt,
        deterministic: { enabled: true, mode: "iso" },
        maxSteps: DEFAULT_MAX_COMPLIANCE_STEPS,
      });

      if (result?.ok === false) {
        state.status = "failed";
        state.error = result.reason ?? "Inspection failed";
      } else {
        state.status = "completed";
        // Create trace from results
        state.trace = createTraceFromResults(rule, result, state.decisions);
        if (state.trace) {
          await traceDb.saveTrace(state.trace);
          await loadTraces();
          onInspectionComplete?.(state.trace);
        }
      }
    } catch (e: any) {
      console.error("[InspectionPanel] Inspection error:", e);
      state.status = "failed";
      state.error = e?.message ?? "Inspection failed";
    }

    render();
  }

  /**
   * Build a VLM prompt from a compliance rule
   */
  /**
   * Create conversation trace from inspection results
   */
  function createTraceFromResults(
    rule: ComplianceRule,
    result: any,
    decisions: VlmDecision[]
  ): ConversationTrace {
    const endTime = Date.now();
    const startTime = state.startTime ?? endTime;

    const trace: ConversationTrace = {
      traceId: crypto.randomUUID(),
      runId: result?.runId ?? crypto.randomUUID(),
      rule: {
        id: rule.id,
        title: rule.title,
        description: rule.description,
        category: rule.category,
        severity: rule.severity,
      },
      model: {
        id: state.selectedModel,
        provider: vlmChecker.getConfig()?.provider ?? "unknown",
        name: OPENROUTER_MODELS.find((m) => m.id === state.selectedModel)?.name ?? state.selectedModel,
      },
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date(endTime).toISOString(),
      status: state.status === "completed" ? "completed" : "failed",
      prompts: [],
      responses: decisions.map((d, i) => ({
        step: i + 1,
        decision: d,
        responseTimeMs: 0, // Would need to track this
        timestamp: d.timestampIso,
      })),
      snapshots: [],
      navigationActions: [],
      sceneStates: [],
      stepMetrics: [],
      stressedFindings: state.findings,
      finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : undefined,
      finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : undefined,
      finalRationale: decisions.length > 0 ? decisions[decisions.length - 1].rationale : undefined,
      metrics: {
        totalSnapshots: decisions.length,
        totalVlmCalls: decisions.length,
        totalNavigationSteps: 0,
        totalDurationMs: endTime - startTime,
        avgVlmResponseTimeMs: 0,
        avgConfidence:
          decisions.length > 0
            ? decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length
            : 0,
        finalVerdict: decisions.length > 0 ? decisions[decisions.length - 1].verdict : "UNCERTAIN",
        finalConfidence: decisions.length > 0 ? decisions[decisions.length - 1].confidence : 0,
        uncertainSteps: decisions.filter((d) => d.verdict === "UNCERTAIN").length,
        failureNotes: [],
      },
    };

    return trace;
  }

  /**
   * Export current trace as JSON
   */
  async function exportTraceJson() {
    if (!state.trace) {
      toast?.("No trace to export.");
      return;
    }

    const success = await traceDb.downloadTraceAsJson(state.trace.traceId);
    if (success) {
      toast?.("Trace exported as JSON.");
    } else {
      toast?.("Export failed.");
    }
  }

  /**
   * Generate and download HTML report
   */
  function exportHtmlReport() {
    if (!state.trace) {
      toast?.("No trace to export.");
      return;
    }

    try {
      downloadHtmlReport(state.trace, { embedImages: true });
      toast?.("HTML report downloaded.");
    } catch (e) {
      console.error("[InspectionPanel] Report generation failed:", e);
      toast?.("Report generation failed.");
    }
  }

  /**
   * View a historical trace
   */
  async function viewTrace(traceId: string) {
    const trace = await traceDb.getTrace(traceId);
    if (trace) {
      state.trace = trace;
      state.status = trace.status === "completed" ? "completed" : "failed";
      render();
    }
  }

  /**
   * Render the panel
   */
  function render() {
    panelRoot.innerHTML = "";

    const panel = BUI.Component.create(() => BUI.html`
      <bim-panel style="max-height: 90vh; overflow-y: auto;">
        <bim-panel-section label="📋 Inspection Runner">
          <!-- Status indicator -->
          <div style="padding:8px;margin-bottom:12px;background:rgba(0,0,0,0.2);border-radius:8px;text-align:center;">
            <span style="color:#fff;font-size:14px;">
              Status: <strong>${state.status.toUpperCase()}</strong>
              ${state.status === "running" ? ` (Step ${state.currentStep}/${state.totalSteps})` : ""}
            </span>
            ${state.trace?.finalVerdict ? BUI.html`<div style="margin-top:4px;">${getVerdictBadge(state.trace.finalVerdict)} ${((state.trace.finalConfidence ?? 0) * 100).toFixed(0)}%</div>` : null}
          </div>

          <!-- Rule Selection -->
          <div style="margin-bottom:16px;">
            <label style="color:#fff;font-size:12px;display:block;margin-bottom:4px;">Select Compliance Rule:</label>
            <select
              style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
              @change=${(e: any) => {
                const ruleId = e.target.value;
                state.selectedRule = rules.find((r) => r.id === ruleId) ?? null;
                render();
              }}
            >
              <option value="" ?selected=${!state.selectedRule}>-- Select a rule --</option>
              ${rules.map(
                (rule) => BUI.html`
                  <option value=${rule.id} ?selected=${state.selectedRule?.id === rule.id}>
                    ${rule.title} (${rule.category})
                  </option>
                `
              )}
            </select>
          </div>

          <!-- Rule Details -->
          ${state.selectedRule ? BUI.html`
            <div style="padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:16px;">
              <div style="color:#fff;font-weight:600;margin-bottom:4px;">${state.selectedRule.title}</div>
              <div style="color:rgba(255,255,255,0.8);font-size:12px;margin-bottom:8px;">${state.selectedRule.description}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <span style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">${state.selectedRule.category}</span>
                <span style="background:${state.selectedRule.severity === "critical" ? "#ef4444" : state.selectedRule.severity === "moderate" ? "#f59e0b" : "#22c55e"};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">${state.selectedRule.severity}</span>
                <span style="background:rgba(255,255,255,0.2);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">VLM Confidence: ${((state.selectedRule.visualSuitability.confidence ?? 0) * 100).toFixed(0)}%</span>
              </div>
            </div>
          ` : null}

          <!-- Model Selection -->
          <div style="margin-bottom:16px;">
            <label style="color:#fff;font-size:12px;display:block;margin-bottom:4px;">VLM Model (OpenRouter):</label>
            <select
              style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);color:#fff;background:rgba(0,0,0,0.25);"
              @change=${(e: any) => {
                state.selectedModel = e.target.value;
                render();
              }}
            >
              ${OPENROUTER_MODELS.map(
                (model) => BUI.html`
                  <option value=${model.id} ?selected=${state.selectedModel === model.id}>
                    ${model.name}${model.recommended ? " ⭐" : ""}
                  </option>
                `
              )}
            </select>
          </div>

          <!-- Start Button -->
          <bim-button
            label=${state.status === "running" ? "Running..." : "Start Inspection"}
            icon="mdi:play"
            ?disabled=${state.status === "running" || !state.selectedRule}
            @click=${startInspection}
          ></bim-button>

          <!-- Progress display when running -->
          ${state.status === "running" ? BUI.html`
            <div style="margin-top:16px;padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;">
              <div style="color:#fff;font-size:12px;margin-bottom:8px;">Running inspection...</div>
              <div style="height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;">
                <div style="height:100%;width:${(state.currentStep / state.totalSteps) * 100}%;background:#3b82f6;transition:width 0.3s;"></div>
              </div>
            </div>
          ` : null}

          <!-- Results when completed -->
          ${state.status === "completed" && state.trace ? BUI.html`
            <div style="margin-top:16px;">
              <h4 style="color:#fff;margin-bottom:8px;">Results</h4>
              <div style="padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:12px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                  ${getVerdictBadge(state.trace.finalVerdict)}
                  <span style="color:#fff;font-size:14px;">Confidence: ${((state.trace.finalConfidence ?? 0) * 100).toFixed(0)}%</span>
                </div>
                ${state.trace.finalRationale ? BUI.html`
                  <div style="color:rgba(255,255,255,0.8);font-size:12px;">${state.trace.finalRationale}</div>
                ` : null}
              </div>

              <!-- Metrics -->
              ${state.trace.metrics ? BUI.html`
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
                  <div style="text-align:center;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                    <div style="color:#fff;font-size:18px;font-weight:700;">${state.trace.metrics.totalSnapshots}</div>
                    <div style="color:rgba(255,255,255,0.6);font-size:10px;">Snapshots</div>
                  </div>
                  <div style="text-align:center;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                    <div style="color:#fff;font-size:18px;font-weight:700;">${state.trace.metrics.totalVlmCalls}</div>
                    <div style="color:rgba(255,255,255,0.6);font-size:10px;">VLM Calls</div>
                  </div>
                  <div style="text-align:center;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                    <div style="color:#fff;font-size:18px;font-weight:700;">${formatDuration(state.trace.metrics.totalDurationMs)}</div>
                    <div style="color:rgba(255,255,255,0.6);font-size:10px;">Duration</div>
                  </div>
                </div>
              ` : null}

              <!-- Export buttons -->
              <div style="display:flex;gap:8px;">
                <bim-button
                  label="Export JSON"
                  icon="mdi:code-json"
                  @click=${exportTraceJson}
                ></bim-button>
                <bim-button
                  label="Generate Report"
                  icon="mdi:file-document"
                  @click=${exportHtmlReport}
                ></bim-button>
              </div>
            </div>
          ` : null}

          <!-- Error display -->
          ${state.status === "failed" && state.error ? BUI.html`
            <div style="margin-top:16px;padding:12px;background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.5);border-radius:8px;">
              <div style="color:#ef4444;font-weight:600;margin-bottom:4px;">Inspection Failed</div>
              <div style="color:rgba(255,255,255,0.8);font-size:12px;">${state.error}</div>
            </div>
          ` : null}
        </bim-panel-section>

        <!-- Trace History -->
        <bim-panel-section label="📜 Inspection History" collapsed>
          ${traces.length === 0 ? BUI.html`
            <div style="color:rgba(255,255,255,0.6);font-size:12px;text-align:center;padding:16px;">
              No inspections yet.
            </div>
          ` : BUI.html`
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${traces.slice(0, 5).map(
                (trace) => BUI.html`
                  <div
                    style="padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;cursor:pointer;"
                    @click=${() => viewTrace(trace.traceId)}
                  >
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                      <span style="color:#fff;font-size:12px;font-weight:500;">${trace.rule.title}</span>
                      ${getVerdictBadge(trace.finalVerdict)}
                    </div>
                    <div style="color:rgba(255,255,255,0.6);font-size:10px;margin-top:4px;">
                      ${new Date(trace.startedAt).toLocaleString()}
                    </div>
                  </div>
                `
              )}
            </div>
          `}

          <bim-button
            label="Clear History"
            icon="mdi:delete"
            style="margin-top:12px;"
            @click=${async () => {
              await traceDb.clearAll();
              await loadTraces();
              render();
              toast?.("History cleared.");
            }}
          ></bim-button>
        </bim-panel-section>
      </bim-panel>
    `);

    panelRoot.append(panel);
  }

  // Initialize
  (async () => {
    await loadRules();
    await loadTraces();
    render();
  })();

  return {
    rerender: render,
    refresh: async () => {
      await loadRules();
      await loadTraces();
      render();
    },
  };
}

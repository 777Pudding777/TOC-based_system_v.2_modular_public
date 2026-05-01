// src/modules/vlmAdapters/openrouter.ts
//
// OpenRouter VLM adapter for compliance checking (browser-only).
// - Uses OpenRouter OpenAI-compatible Chat Completions endpoint.
// - Vision input via image_url data URLs derived from SnapshotArtifact.images[].imageBase64Png.
// - Does NOT rely on json_schema strict (not guaranteed across routed providers).
// - Enforces JSON-only output via deterministic wrapper + robust parsing.
// - Leaves promptHash to vlmChecker.finalizeDecision (or you can import hashPrompt and include it).

import type { SnapshotArtifact } from "../snapshotCollector";
import type { EvidenceView, VlmAdapter, VlmCheckInput, VlmFollowUp, VlmVerdict } from "../vlmChecker";
import {
  clampMaxSnapshotsPerRequest,
  DEFAULT_MAX_SNAPSHOTS_PER_REQUEST,
} from "../../config/prototypeSettings";
import type { EvidenceRequirementsStatus } from "../../types/evidenceRequirements.types";
import { wrapPromptBase, wrapPromptEnhanced } from "./prompts/promptWrappers";

export type OpenRouterAdapterConfig = {
  apiKey: string;
  model: string; // OpenRouter model id, must support images
  endpoint?: string; // default https://openrouter.ai/api/v1/chat/completions
  requestTimeoutMs?: number;

  // Optional OpenRouter attribution headers (recommended; not secrets)
  appTitle?: string; // X-Title
  appReferer?: string; // HTTP-Referer

  temperature?: number; // default 0
  top_p?: number; // default 1
  max_tokens?: number; // default 900
  maxImages?: number; // default 4 (cost control)

    // Optional: enable OpenRouter web-search plugin for text-only clause discovery calls.
    webSearch?: {
      enabled?: boolean; // default false
      maxResults?: number; // default 5
      // Restrict discovery to ICC; keep generalizable by allowing multiple domains.
      allowedDomains?: string[]; // default ["codes.iccsafe.org"]
    };
};



type DecisionCore = {
  verdict: VlmVerdict;
  confidence: number;
  rationale: string;
  missingEvidence?: string[];
  evidenceRequirementsStatus?: EvidenceRequirementsStatus;

  visibility: {
    isRuleTargetVisible: boolean;
    occlusionAssessment: "LOW" | "MEDIUM" | "HIGH";
    missingEvidence?: string[];
  };

  evidence: {
    snapshotIds: string[];
    mode: SnapshotArtifact["mode"];
    note?: string;
  };

  followUp?: VlmFollowUp;

  meta: {
    modelId: string | null;
    promptHash?: string;
    provider: string;
    followUpSource?: "model" | "provider_override" | "default_fallback";
    adapterPromptText?: string;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
};

function extractTokenUsage(payload: any): DecisionCore["meta"]["tokenUsage"] | undefined {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return undefined;

  const inputTokens = Number(usage.prompt_tokens);
  const outputTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);

  const normalized = {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(totalTokens) ? { totalTokens } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function clamp01(x: unknown): number {
  const n = typeof x === "number" && isFinite(x) ? x : 0;
  return Math.max(0, Math.min(1, n));
}

function isVerdict(v: unknown): v is VlmVerdict {
  return v === "PASS" || v === "FAIL" || v === "UNCERTAIN";
}


//-----------------------------------------------//
//-----------------Follow-up check---------------//
//-----------------------------------------------//
function isFollowUp(x: any): x is VlmFollowUp {
  if (!x || typeof x !== "object") return false;

  const req = x.request;

  switch (req) {
    case "NEW_VIEW":
      return !x.params || typeof x.params === "object";

    case "ISO_VIEW":
    case "TOP_VIEW":
    case "RESET_VISIBILITY":
    case "HIDE_SELECTED":
    case "PICK_CENTER":
      return true;

    case "SET_VIEW_PRESET":
      return (
        x.params &&
        (x.params.preset === "TOP" || x.params.preset === "ISO" || x.params.preset === "ORBIT")
      );

    case "ORBIT":
      return (
        x.params &&
        typeof x.params === "object" &&
        (x.params.degrees === undefined || (typeof x.params.degrees === "number" && isFinite(x.params.degrees))) &&
        (x.params.yawDegrees === undefined || (typeof x.params.yawDegrees === "number" && isFinite(x.params.yawDegrees))) &&
        (x.params.pitchDegrees === undefined || (typeof x.params.pitchDegrees === "number" && isFinite(x.params.pitchDegrees))) &&
        (x.params.reason === undefined || typeof x.params.reason === "string") &&
        (x.params.degrees !== undefined || x.params.yawDegrees !== undefined || x.params.pitchDegrees !== undefined)
      );

    case "ZOOM_IN":
      return !x.params || (typeof x.params === "object");

    case "ISOLATE_CATEGORY":
      return x.params && typeof x.params.category === "string" && x.params.category.length > 0;

    case "HIDE_CATEGORY":
      return x.params && typeof x.params.category === "string" && x.params.category.length > 0;

    case "SHOW_CATEGORY":
      return x.params && typeof x.params.category === "string" && x.params.category.length > 0;

    case "HIDE_IDS":
    case "SHOW_IDS":
    case "HIGHLIGHT_IDS":
      return x.params && Array.isArray(x.params.ids) && x.params.ids.every((id: any) => typeof id === "string");

    case "ISOLATE_STOREY":
      return x.params && typeof x.params.storeyId === "string" && x.params.storeyId.length > 0;

    case "ISOLATE_SPACE":
      return x.params && typeof x.params.spaceId === "string" && x.params.spaceId.length > 0;

    case "PICK_OBJECT":
      return (
        x.params &&
        typeof x.params.x === "number" &&
        typeof x.params.y === "number" &&
        isFinite(x.params.x) &&
        isFinite(x.params.y)
      );

    case "GET_PROPERTIES":
      return x.params && typeof x.params.objectId === "string" && x.params.objectId.length > 0;

    case "WEB_FETCH":
      return (
        x.params &&
        typeof x.params.url === "string" &&
        x.params.url.length > 0 &&
        (x.params.maxChars === undefined || (typeof x.params.maxChars === "number" && isFinite(x.params.maxChars))) &&
        (x.params.selector === undefined || typeof x.params.selector === "string") &&
        (x.params.focus === undefined || typeof x.params.focus === "object")
      );
      
    default:
      return false;
  }
}

function toPngDataUrl(base64Png: string): string {
  // SnapshotCollector stores raw base64 PNG (no prefix). Normalize deterministically.
  return base64Png.startsWith("data:image/") ? base64Png : `data:image/png;base64,${base64Png}`;
}

function stableEvidenceJson(evidenceViews: EvidenceView[]): string {
  // evidenceViews is already ordered; JSON.stringify preserves array order deterministically.
  return JSON.stringify(evidenceViews, null, 2);
}

function getLastPromptContext(input: VlmCheckInput): any | undefined {
  const last = input.evidenceViews?.[input.evidenceViews.length - 1];
  return last?.context;
}

function getLastFullTraceContext(input: VlmCheckInput): any | undefined {
  const lastArtifact = input.artifacts?.[input.artifacts.length - 1] as any;
  return lastArtifact?.meta?.context ?? getLastPromptContext(input);
}

function getLastNav(evidenceViews: any[]): any | undefined {
  const last = evidenceViews?.[evidenceViews.length - 1];
  return last?.nav;
}

function inferPromptSource(prompt: string): "rule_library" | "custom_user_prompt" | "unknown" {
  const text = String(prompt ?? "");
  if (/SOURCE:\s*RULE_LIBRARY/i.test(text)) return "rule_library";
  if (/SOURCE:\s*CUSTOM_USER_PROMPT/i.test(text)) return "custom_user_prompt";
  return "unknown";
}

function normalize(s: string) {
  return String(s ?? "").trim().toLowerCase();
}

function pickStoreyFromPrompt(prompt: string, available: string[] | undefined): string | null {
  if (!available?.length) return null;

  const p = normalize(prompt);

  // Very small deterministic matching for PoC
  const wantsFirst =
    p.includes("first floor") || p.includes("1st floor") || p.includes("floor 1") || p.includes("level 1");

  if (wantsFirst) {
    const exact = available.find((x) => normalize(x) === "first floor");
    if (exact) return exact;

    // fallback: contains "first"
    const contains = available.find((x) => normalize(x).includes("first"));
    if (contains) return contains;
  }

  // If prompt directly contains one of the storey names, pick it
  for (const s of available) {
    if (p.includes(normalize(s))) return s;
  }

  return null;
}


function extractFirstJsonObject(text: string): string | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  return text.slice(a, b + 1);
}

function coerceAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as any;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (typeof p.output_text === "string") return p.output_text;
          if (p.json && typeof p.json === "object") return JSON.stringify(p.json);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    const c = content as any;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
    if (typeof c.output_text === "string") return c.output_text;
    if (c.json && typeof c.json === "object") return JSON.stringify(c.json);
  }
  return "";
}


function pickAssistantContent(responseJson: any): unknown {
  const choice = responseJson?.choices?.[0];
  const message = choice?.message;
  const toolCallArgs = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .map((t: any) => t?.function?.arguments)
        .find((x: unknown) => x !== undefined && x !== null)
    : undefined;

  return (
    message?.parsed ??
    message?.json ??
    message?.content ??
    choice?.text ??
    toolCallArgs ??
    ""
  );
}


function describeModelOutput(content: unknown): string {
  if (content == null) return "empty";
  if (typeof content === "string") {
    const snippet = content.replace(/\s+/g, " ").trim().slice(0, 180);
    return `string:${snippet || "<blank>"}`;
  }
  if (Array.isArray(content)) {
    const preview = content.slice(0, 2).map((x) => {
      if (typeof x === "string") return x.replace(/\s+/g, " ").trim().slice(0, 80);
      if (x && typeof x === "object") return `obj(${Object.keys(x as any).slice(0, 6).join(",")})`;
      return typeof x;
    });
    return `array[len=${content.length}] ${preview.join(" | ")}`;
  }
  if (typeof content === "object") {
    return `object keys=${Object.keys(content as any).slice(0, 10).join(",")}`;
  }
  return typeof content;
}

function parseModelJson<T>(content: unknown): T | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const direct = content as any;
    if (direct.json && typeof direct.json === "object") return direct.json as T;
    if (
      typeof direct.verdict === "string" ||
      Array.isArray(direct.relevantClauses) ||
      Array.isArray(direct.candidates) ||
      typeof direct.ruleFocusedSummary === "string"
    ) {
      return direct as T;
    }
  }

  const raw = coerceAssistantText(content).trim();
  if (!raw) return null;

  const candidates = [raw];
  const unwrappedFence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (unwrappedFence) candidates.push(unwrappedFence);
  const jsonSlice = extractFirstJsonObject(raw);
  if (jsonSlice && jsonSlice !== raw) candidates.push(jsonSlice);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: any }> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(`Request timed out after ${timeoutMs}ms.`), timeoutMs);

  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, json };
  } catch (error: any) {
    if (error?.name === "AbortError" || ctrl.signal.aborted) {
      return {
        ok: false,
        status: 408,
        json: {
          error: {
            message:
              typeof ctrl.signal.reason === "string"
                ? ctrl.signal.reason
                : `OpenRouter request timed out after ${timeoutMs}ms.`,
          },
        },
      };
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}



export function createOpenRouterVlmAdapter(cfg: OpenRouterAdapterConfig): VlmAdapter {
  const endpoint = cfg.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = Math.max(5_000, Math.min(180_000, cfg.requestTimeoutMs ?? 90_000));

  return {
    name: "openrouter",

    async check(input: VlmCheckInput) {
      if (!cfg.apiKey) throw new Error("OpenRouter adapter missing apiKey.");
      if (!cfg.model) throw new Error("OpenRouter adapter missing model.");
      if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
        throw new Error("OpenRouter adapter requires at least one snapshot artifact.");
      }

      const artifacts = input.artifacts;
      const last = artifacts[artifacts.length - 1];

      // Flatten images deterministically: artifact order, then images[] order.
      // Also build a parallel list of snapshotIds (same ordering as images).
      const imageInputs: Array<{ snapshotId: string; dataUrl: string }> = [];
      for (const a of artifacts) {
        for (const img of a.images) {
          imageInputs.push({ snapshotId: a.id, dataUrl: toPngDataUrl(img.imageBase64Png) });
        }
      }

            const maxImages = clampMaxSnapshotsPerRequest(
              cfg.maxImages ?? DEFAULT_MAX_SNAPSHOTS_PER_REQUEST
            );
      const imageInputsCapped = imageInputs.slice(Math.max(0, imageInputs.length - maxImages));

            const imageIndex = imageInputsCapped.map((x, i) => ({
        i,
        snapshotId: x.snapshotId,
      }));
      const imageIndexJson = JSON.stringify(imageIndex, null, 2);


      const evidenceViewsJson = stableEvidenceJson(input.evidenceViews);
      const promptSource = inferPromptSource(input.prompt);
      const promptWrapper = promptSource === "custom_user_prompt" ? wrapPromptEnhanced : wrapPromptBase;
      const userText = promptWrapper({
        taskPrompt: input.prompt,
        evidenceViewsJson,
        imageIndexJson,
      });


      const body = {
        model: cfg.model,
        temperature: cfg.temperature ?? 0,
        top_p: cfg.top_p ?? 1,
        max_tokens: cfg.max_tokens ?? 900,
        messages: [
          {
            role: "system",
            content: "Return ONLY valid JSON. No markdown. No prose outside JSON. No code fences. No extra keys.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              ...imageInputsCapped.map(x => ({ type: "image_url", image_url: { url: x.dataUrl } })),
            ],
          },
        ],
        // Safe hint; not guaranteed across providers.
        response_format: { type: "json_object" },
      };

      const { ok, status, json } = await fetchJsonWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
            ...(cfg.appReferer ? { "HTTP-Referer": cfg.appReferer } : {}),
            ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
          },
          body: JSON.stringify(body),
        },
        timeoutMs
      );
      let tokenUsage = extractTokenUsage(json);

      if (!ok) {
        const msg = json?.error?.message || `OpenRouter request failed (${status}).`;
        const fallback: DecisionCore = {
          verdict: "UNCERTAIN",
          confidence: 0.05,
          rationale: msg,
          visibility: {
            isRuleTargetVisible: false,
            occlusionAssessment: "HIGH",
            missingEvidence: ["Provider error; cannot assess from this step."],
          },
          evidence: { snapshotIds: [last.id], mode: last.mode, note: last.meta.note },
          followUp: { request: "NEW_VIEW", params: { reason: "Provider error; try a new view." } },
          meta: { modelId: cfg.model ?? null, provider: "openrouter", adapterPromptText: userText },
        };
        if (tokenUsage) fallback.meta.tokenUsage = tokenUsage;
        return fallback;
      }

      const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
      let parsed = parseModelJson<any>(content);

      if (!parsed) {
        const retryBody = {
          ...body,
          temperature: 0,
          top_p: 1,
          messages: [
            {
              role: "system",
              content:
                "Return ONLY valid minified JSON object. No markdown. No prose. Required keys: verdict, confidence, rationale, visibility. visibility must include isRuleTargetVisible and occlusionAssessment.",
            },
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                ...imageInputsCapped.map(x => ({ type: "image_url", image_url: { url: x.dataUrl } })),
              ],
            },
          ],
        };

        const retry = await fetchJsonWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.apiKey}`,
              ...(cfg.appReferer ? { "HTTP-Referer": cfg.appReferer } : {}),
              ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
            },
            body: JSON.stringify(retryBody),
          },
          timeoutMs
        );

        if (retry.ok) {
          const retryContent = retry.json?.choices?.[0]?.message?.content ?? retry.json?.choices?.[0]?.text ?? "";
          parsed = parseModelJson<any>(retryContent);
          tokenUsage = extractTokenUsage(retry.json) ?? tokenUsage;
        }
      }

      if (!parsed) {
        const fallback: DecisionCore = {
          verdict: "UNCERTAIN",
          confidence: 0.15,
          rationale: `Model returned non-JSON output (${describeModelOutput(content)}); could not produce structured decision.`,
          visibility: {
            isRuleTargetVisible: false,
            occlusionAssessment: "HIGH",
            missingEvidence: ["Non-JSON output from model."],
          },
          evidence: { snapshotIds: [last.id], mode: last.mode, note: last.meta.note },
          followUp: undefined,
          meta: { modelId: cfg.model ?? null, provider: "openrouter", adapterPromptText: userText },
          };
        if (tokenUsage) fallback.meta.tokenUsage = tokenUsage;
        return fallback;
      }

      // ✅ INSERT HERE
      const hasCore =
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.verdict === "string" &&
        typeof parsed.confidence === "number" &&
        typeof parsed.rationale === "string" &&
        parsed.visibility &&
        typeof parsed.visibility === "object";

      if (!hasCore) {
        const fallback: DecisionCore = {
          verdict: "UNCERTAIN",
          confidence: 0.2,
          rationale: `Model returned incomplete JSON core (${describeModelOutput(parsed)}); cannot trust structured decision yet.`,
          visibility: {
            isRuleTargetVisible: false,
            occlusionAssessment: "HIGH",
            missingEvidence: ["Incomplete JSON core from model."],
          },
          evidence: { snapshotIds: [last.id], mode: last.mode, note: last.meta.note },
          followUp: undefined,
          meta: { modelId: cfg.model ?? null, provider: "openrouter", adapterPromptText: userText },
        };
        if (tokenUsage) fallback.meta.tokenUsage = tokenUsage;
        return fallback;
      }

      // ⬇️ everything below stays exactly as you already have it
      const verdict: VlmVerdict = isVerdict(parsed?.verdict) ? parsed.verdict : "UNCERTAIN";
      const confidence = clamp01(parsed?.confidence);


      const visibility = parsed?.visibility;
      const safeVisibility = {
        isRuleTargetVisible: Boolean(visibility?.isRuleTargetVisible),
        occlusionAssessment:
          visibility?.occlusionAssessment === "LOW" ||
          visibility?.occlusionAssessment === "MEDIUM" ||
          visibility?.occlusionAssessment === "HIGH"
            ? visibility.occlusionAssessment
            : "HIGH",
        missingEvidence: Array.isArray(visibility?.missingEvidence)
          ? visibility.missingEvidence.map((x: any) => String(x))
          : undefined,
      } as const;

let followUp = isFollowUp(parsed?.followUp) ? parsed.followUp : undefined;
let followUpSource: DecisionCore["meta"]["followUpSource"] = followUp ? "model" : undefined;
const rationaleText = typeof parsed?.rationale === "string" ? parsed.rationale.toLowerCase() : "";
const rationaleWantsPlanCut =
  rationaleText.includes("plan cut") ||
  rationaleText.includes("top-down plan cut") ||
  rationaleText.includes("top down plan cut") ||
  rationaleText.includes("true top-down") ||
  rationaleText.includes("true top down");
if (followUp?.request === "ZOOM_IN" && getLastNav(input.evidenceViews as any[])?.zoomPotentialExhausted) {
  followUp = undefined;
  followUpSource = undefined;
}
if (followUp?.request === "TOP_VIEW" && getLastFullTraceContext(input)?.lastActionReason === "top") {
  followUp = undefined;
  followUpSource = undefined;
}

// --- Deterministic guardrail: prevent infinite NEW_VIEW loops for PoC ---
if (verdict === "UNCERTAIN") {
  const ctxAny = getLastFullTraceContext(input);
  const navAny = getLastNav(input.evidenceViews as any[]);
  const availableStoreys: string[] | undefined = ctxAny?.availableStoreys;
  const currentScopeStorey: string | undefined = ctxAny?.scope?.storeyId;
  const currentViewPreset: string | undefined = ctxAny?.viewPreset; // "iso" | "top"
  const isolatedCats: string[] | undefined = ctxAny?.isolatedCategories;
  const highlightedIds: string[] | undefined = ctxAny?.highlightedIds;
  const lastActionReason: string | undefined = ctxAny?.lastActionReason;
  const planCutEnabled: boolean = Boolean(ctxAny?.planCut?.enabled);
  const zoomPotentialExhausted: boolean = Boolean(navAny?.zoomPotentialExhausted);
  const floorContextMissing: boolean = Boolean(ctxAny?.floorContext?.missingLikely);
  const orbitRemaining: number = Number(ctxAny?.followUpBudget?.orbitRemainingForActiveEntity ?? 0);
  const orbitCallsForActiveEntity: number = Number(ctxAny?.followUpBudget?.orbitCallsForActiveEntity ?? 0);
  const canOrbit = orbitRemaining > 0;
  const lastActionWasOrbit = lastActionReason === "orbit" || lastActionReason === "orbit-from-top";
  const canRequestTopAfterOrbit = !lastActionWasOrbit || orbitCallsForActiveEntity >= 2;
  const taskProfile: string | undefined = ctxAny?.taskGraph?.profile;
  const primaryClass: string | undefined = ctxAny?.taskGraph?.primaryClass;
  const activeEntityId: string | undefined = ctxAny?.taskGraph?.activeEntity?.id;
  const activeEntityClass: string | undefined = ctxAny?.taskGraph?.activeEntity?.class;
  const activeStoreyId: string | undefined = ctxAny?.taskGraph?.activeStoreyId;
  const concernList: string[] = Array.isArray(ctxAny?.taskGraph?.concerns) ? ctxAny.taskGraph.concerns : [];
  const targetClass = activeEntityClass ?? primaryClass;
  const isDoorTask = taskProfile === "door" || Boolean(targetClass && normalize(targetClass).includes("ifcdoor"));
  const isStairTask =
    taskProfile === "stair" ||
    Boolean(targetClass && (normalize(targetClass).includes("ifcstair") || normalize(targetClass).includes("ifcstairflight")));
  const isRampTask = taskProfile === "ramp" || Boolean(targetClass && normalize(targetClass).includes("ifcramp"));
  const accessibilityFocused =
    concernList.some((c) => normalize(c) === "accessibility") ||
    normalize(input.prompt).includes("accessible") ||
    normalize(input.prompt).includes("accessibility") ||
    normalize(input.prompt).includes("wheelchair") ||
    normalize(input.prompt).includes("ada");
  const doorPrepReady =
    isDoorTask &&
    Boolean(highlightedIds?.length) &&
    Boolean(isolatedCats?.some((c) => normalize(c).includes("ifcdoor"))) &&
    currentViewPreset === "top";

  const wantedStorey = activeStoreyId ?? pickStoreyFromPrompt(input.prompt, availableStoreys);

  const followUpIsNewView = followUp?.request === "NEW_VIEW";

  // Strong door-task ordering guard: top view first, then storey plan cut, then entity work.
  if (
    isDoorTask &&
    currentViewPreset !== "top" &&
    lastActionReason !== "top" &&
    followUp?.request !== "TOP_VIEW"
  ) {
    followUp = { request: "TOP_VIEW" } as any;
    followUpSource = "provider_override";
  } else if (
    isDoorTask &&
    wantedStorey &&
    currentViewPreset === "top" &&
    !planCutEnabled &&
    followUp?.request !== "SET_STOREY_PLAN_CUT"
  ) {
    followUp = {
      request: "SET_STOREY_PLAN_CUT",
      params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
    } as any;
    followUpSource = "provider_override";
  }

  // If model says NEW_VIEW but we have an obvious next action, override it.
  if (!followUp || followUpIsNewView) {
    if (isRampTask && wantedStorey && currentScopeStorey !== wantedStorey) {
      followUp = { request: "ISOLATE_STOREY", params: { storeyId: wantedStorey } } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && currentViewPreset !== "iso") {
      followUp = { request: "ISO_VIEW" } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && activeEntityId && !highlightedIds?.includes(activeEntityId)) {
      followUp = { request: "HIGHLIGHT_IDS", params: { ids: [activeEntityId], style: "primary" } } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && safeVisibility.occlusionAssessment === "HIGH" && canOrbit && !lastActionWasOrbit) {
      followUp = { request: "ORBIT", params: { yawDegrees: 25, pitchDegrees: 0, reason: "Need a side or less occluded view of the ramp run." } } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && accessibilityFocused && currentViewPreset !== "top" && canRequestTopAfterOrbit) {
      followUp = { request: "TOP_VIEW" } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && wantedStorey && !planCutEnabled && (accessibilityFocused || floorContextMissing || rationaleWantsPlanCut)) {
      followUp = {
        request: "SET_STOREY_PLAN_CUT",
        params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
      } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && !planCutEnabled && (floorContextMissing || rationaleWantsPlanCut) && lastActionReason !== "plan-cut") {
      followUp = { request: "SET_PLAN_CUT", params: { height: 1.2, mode: "CAMERA" } } as any;
      followUpSource = "provider_override";
    }
    else if (isRampTask && !zoomPotentialExhausted && lastActionReason !== "zoom-to-highlighted-entity") {
      followUp = { request: "ZOOM_IN", params: { factor: 1.15 } } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && wantedStorey && currentScopeStorey !== wantedStorey) {
      followUp = { request: "ISOLATE_STOREY", params: { storeyId: wantedStorey } } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && currentViewPreset !== "iso") {
      followUp = { request: "ISO_VIEW" } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && activeEntityId && !highlightedIds?.includes(activeEntityId)) {
      followUp = { request: "HIGHLIGHT_IDS", params: { ids: [activeEntityId], style: "primary" } } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && safeVisibility.occlusionAssessment === "HIGH" && canOrbit && !lastActionWasOrbit) {
      followUp = { request: "ORBIT", params: { yawDegrees: 25, pitchDegrees: 0, reason: "Need a clearer side or landing view of the stair run." } } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && accessibilityFocused && currentViewPreset !== "top" && canRequestTopAfterOrbit) {
      followUp = { request: "TOP_VIEW" } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && wantedStorey && !planCutEnabled && (accessibilityFocused || floorContextMissing || rationaleWantsPlanCut)) {
      followUp = {
        request: "SET_STOREY_PLAN_CUT",
        params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
      } as any;
      followUpSource = "provider_override";
    }
    else if (isStairTask && !zoomPotentialExhausted && lastActionReason !== "zoom-to-highlighted-entity") {
      followUp = { request: "ZOOM_IN", params: { factor: 1.15 } } as any;
      followUpSource = "provider_override";
    }
    // 1) Go to TOP view for accessibility checks.
    else if (isDoorTask && currentViewPreset !== "top" && canRequestTopAfterOrbit) {
      followUp = { request: "TOP_VIEW" } as any;
      followUpSource = "provider_override";
    }
    // 2) Then prepare a storey-aware plan cut for the active storey.
    else if (isDoorTask && wantedStorey && !planCutEnabled) {
      followUp = {
        request: "SET_STOREY_PLAN_CUT",
        params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
      } as any;
      followUpSource = "provider_override";
    }
    // 3) Then isolate the relevant category before tighter framing.
    else if (targetClass && (!isolatedCats || !isolatedCats.some((c) => normalize(c).includes(normalize(targetClass))))) {
      followUp = { request: "ISOLATE_CATEGORY", params: { category: targetClass } } as any;
      followUpSource = "provider_override";
    }
    // 4) Then force the active door highlight inside the current storey cluster.
    else if (activeEntityId && !highlightedIds?.includes(activeEntityId)) {
      followUp = { request: "HIGHLIGHT_IDS", params: { ids: [activeEntityId], style: "primary" } } as any;
      followUpSource = "provider_override";
    }
    // 5) If floor context is missing or the rationale explicitly wants plan cut, prefer storey plan cut.
    else if (isDoorTask && wantedStorey && (floorContextMissing || rationaleWantsPlanCut) && !planCutEnabled) {
      followUp = {
        request: "SET_STOREY_PLAN_CUT",
        params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
      } as any;
      followUpSource = "provider_override";
    }
    else if (isDoorTask && doorPrepReady && !planCutEnabled && lastActionReason === "zoom-to-highlighted-entity") {
      followUp = wantedStorey
        ? ({
            request: "SET_STOREY_PLAN_CUT",
            params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
          } as any)
        : ({
            request: "SET_PLAN_CUT",
            params: { height: 1.2, mode: "WORLD_UP" },
          } as any);
      followUpSource = "provider_override";
    }
    // 6) Only after top view + storey plan cut prep, allow a tighter entity-focused zoom.
    else if ((!highlightedIds?.length || lastActionReason !== "zoom-to-highlighted-entity") && !zoomPotentialExhausted) {
      followUp = { request: "ZOOM_IN", params: { factor: 2 } } as any;
      followUpSource = "provider_override";
    }
    else if (zoomPotentialExhausted && highlightedIds?.length && canOrbit) {
      followUp = {
        request: "ORBIT",
        params: {
          yawDegrees: currentViewPreset === "top" ? 45 : 25,
          pitchDegrees: currentViewPreset === "top" ? -30 : 0,
          reason: "Focused target is already zoomed/highlighted; gather one bounded confirmation angle.",
        },
      } as any;
      followUpSource = "provider_override";
    }
    else if (zoomPotentialExhausted) {
      followUp = undefined;
      followUpSource = undefined;
    }
    // 7) Keep the storey plan cut as the preferred prepared state for later doors on the same storey.
    else {
      followUp = isDoorTask && wantedStorey && !planCutEnabled
        ? ({
            request: "SET_STOREY_PLAN_CUT",
            params: { storeyId: wantedStorey, offsetFromFloor: 1.2, mode: "WORLD_UP" },
          } as any)
        : ({
            request: "SET_PLAN_CUT",
            params: { height: 1.2, mode: "WORLD_UP" },
          } as any);
      followUpSource = "provider_override";
    }
  }
}


      const decision: DecisionCore = {
        verdict,
        confidence,
        rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "",
        missingEvidence: Array.isArray(parsed?.missingEvidence)
          ? parsed.missingEvidence.map((x: any) => String(x))
          : safeVisibility.missingEvidence,
        evidenceRequirementsStatus:
          parsed?.evidenceRequirementsStatus && typeof parsed.evidenceRequirementsStatus === "object"
            ? Object.fromEntries(
                Object.entries(parsed.evidenceRequirementsStatus).filter(([, value]) => typeof value === "boolean")
              ) as EvidenceRequirementsStatus
            : undefined,
        visibility: safeVisibility,
        evidence: {
          // Let checker filter/normalize; we provide a deterministic default:
          snapshotIds: Array.isArray(parsed?.evidence?.snapshotIds) ? parsed.evidence.snapshotIds : [last.id],
          mode: (parsed?.evidence?.mode as any) ?? last.mode,
          note: parsed?.evidence?.note ?? last.meta.note,
        },
        followUp: verdict === "UNCERTAIN"
          ? (
              followUp ??
              (getLastNav(input.evidenceViews as any[])?.zoomPotentialExhausted
                ? undefined
                : { request: "NEW_VIEW", params: { reason: "Need more evidence." } })
            )
          : followUp,
        meta: {
          modelId: cfg.model ?? null,
          provider: "openrouter",
          followUpSource:
            followUpSource ??
            (verdict === "UNCERTAIN" && !followUp ? "default_fallback" : undefined),
          adapterPromptText: userText,
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      };

      return decision;
    },
  };
}


// --------------------------------------------------------------//
//-----------------Optional clause discovery check---------------//
//---------------------------------------------------------------//
export type ClauseCandidate = {
  standard?: string;        // e.g. "IBC", "ICC A117.1"
  edition?: string;         // e.g. "2021"
  section?: string;         // e.g. "404.2.3"
  title?: string;
  whyRelevant: string[];
  url: string;              // MUST be codes.iccsafe.org
  confidence: number;       // 0..1
};

export type ClauseDiscoveryResult = {
  assumptions: {
    jurisdiction?: string;
    codeFamily?: string;    // "IBC", "IRC", "IFC", "ICC A117.1", etc.
    edition?: string;
  };
  candidates: ClauseCandidate[];
  missingInfo?: string[];   // questions for user
};

function buildSiteRestrictedQuery(userIntent: string, domains: string[]) {
  const siteFilters = domains.map((d) => `site:${d}`).join(" OR ");
  // Keep it deterministic and short
  return `(${siteFilters}) ${userIntent}`.trim();
}

function clamp01Local(x: any) {
  const n = typeof x === "number" && isFinite(x) ? x : 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Text-only: use OpenRouter web-search plugin to find ICC clause URLs.
 * Returns strict JSON (no markdown).
 *
 * IMPORTANT: This is discovery only. You should still run your proxy WEB_FETCH
 * to extract the authoritative clause text before compliance decisions.
 */
export async function discoverIccClausesOnline(cfg: OpenRouterAdapterConfig, args: {
  userIntent: string;                 // e.g. "accessibility of doors second floor"
  hint?: { codeFamily?: string; edition?: string; jurisdiction?: string };
  maxCandidates?: number;             // default 5
}): Promise<ClauseDiscoveryResult> {
  if (!cfg.apiKey) throw new Error("OpenRouter missing apiKey.");
  const endpoint = cfg.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = Math.max(5_000, Math.min(180_000, cfg.requestTimeoutMs ?? 90_000));

  const allowedDomains = cfg.webSearch?.allowedDomains?.length
    ? cfg.webSearch.allowedDomains
    : ["codes.iccsafe.org"];

  const maxResults = Math.max(1, Math.min(10, cfg.webSearch?.maxResults ?? 5));
  const maxCandidates = Math.max(1, Math.min(10, args.maxCandidates ?? 5));

  // IMPORTANT: Use a text model (or your same model) – this call is text-only.
  // If you want, you can add a separate cfg.webSearchModel later.
  const model = cfg.model;

  const query = buildSiteRestrictedQuery(
    [
      args.hint?.codeFamily ? `${args.hint.codeFamily}` : "",
      args.hint?.edition ? `${args.hint.edition}` : "",
      args.userIntent,
      // helpful fixed terms for accessibility door checks
      "accessibility door clear width maneuvering clearance threshold hardware",
      "section",
    ].filter(Boolean).join(" "),
    allowedDomains
  );

  // Force JSON output; also tell the web plugin not to require markdown citations.
  const discoveryPrompt =
    "You are a code clause discovery assistant.\n" +
    "Task: find the most relevant code clauses for the user's intent using ONLY web results from allowed domains.\n" +
    "Return ONLY valid JSON with the shape:\n" +
    "{\n" +
    '  "assumptions": { "jurisdiction"?: string, "codeFamily"?: string, "edition"?: string },\n' +
    '  "candidates": [{ "standard"?: string, "edition"?: string, "section"?: string, "title"?: string, "whyRelevant": string[], "url": string, "confidence": number }],\n' +
    '  "missingInfo"?: string[]\n' +
    "}\n" +
    "Rules:\n" +
    "- Use ONLY URLs from the allowed domains.\n" +
    "- Provide at most " + maxCandidates + " candidates.\n" +
    "- confidence must be within [0,1].\n" +
    "- Do NOT include markdown links. Put raw URLs in the 'url' field.\n" +
    "- If code edition/jurisdiction is unclear, include that in missingInfo.\n" +
    "\n" +
    "User intent:\n" +
    args.userIntent + "\n" +
    (args.hint?.jurisdiction ? `Jurisdiction hint: ${args.hint.jurisdiction}\n` : "") +
    (args.hint?.codeFamily ? `Code hint: ${args.hint.codeFamily}\n` : "") +
    (args.hint?.edition ? `Edition hint: ${args.hint.edition}\n` : "") +
    "\n" +
    "Search query to use:\n" +
    query;

  const body: any = {
    model,
    temperature: 0,
    top_p: 1,
    max_tokens: 700,
    messages: [{ role: "user", content: [{ type: "text", text: discoveryPrompt }] }],
    response_format: { type: "json_object" },

    // ✅ OpenRouter web-search plugin
    plugins: [
      {
        id: "web",
        max_results: maxResults,
        // This controls how the plugin frames results; keep it JSON-safe.
        search_prompt:
          "Search the web and provide results. Do not write markdown. Do not cite with brackets. Provide plain URLs only.",
      },
    ],
  };

  const { ok, status, json } = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.appReferer ? { "HTTP-Referer": cfg.appReferer } : {}),
        ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!ok) {
    const msg = json?.error?.message || `OpenRouter discovery failed (${status}).`;
    return { assumptions: {}, candidates: [], missingInfo: [msg] };
  }

  const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
  let parsed = parseModelJson<any>(content);

  if (!parsed) {
    const retryBody = {
      ...body,
      temperature: 0,
      top_p: 1,
      messages: [
        {
          role: "system",
          content:
            "Return ONLY valid minified JSON object with keys assumptions, candidates, missingInfo. No markdown or prose.",
        },
        { role: "user", content: [{ type: "text", text: discoveryPrompt }] },
      ],
    };

    const retry = await fetchJsonWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.appReferer ? { "HTTP-Referer": cfg.appReferer } : {}),
          ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
        },
        body: JSON.stringify(retryBody),
      },
      timeoutMs
    );

    if (retry.ok) {
      const retryContent = retry.json?.choices?.[0]?.message?.content ?? retry.json?.choices?.[0]?.text ?? "";
      parsed = parseModelJson<any>(retryContent);
    }
  }

  if (!parsed) {
    return { assumptions: {}, candidates: [], missingInfo: ["Discovery model returned non-JSON output."] };
  }

  const assumptions = (parsed?.assumptions && typeof parsed.assumptions === "object") ? parsed.assumptions : {};
  const candidatesRaw = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

  // sanitize + enforce domain restriction
  const candidates: ClauseCandidate[] = candidatesRaw
    .map((c: any) => ({
      standard: typeof c?.standard === "string" ? c.standard : undefined,
      edition: typeof c?.edition === "string" ? c.edition : undefined,
      section: typeof c?.section === "string" ? c.section : undefined,
      title: typeof c?.title === "string" ? c.title : undefined,
      whyRelevant: Array.isArray(c?.whyRelevant) ? c.whyRelevant.map((x: any) => String(x)).slice(0, 6) : [],
      url: typeof c?.url === "string" ? c.url : "",
      confidence: clamp01Local(c?.confidence),
    }))
    .filter((c: ClauseCandidate) => {
      try {
        const u = new URL(c.url);
        return allowedDomains.some((d) => u.hostname === d || u.hostname.endsWith("." + d));
      } catch {
        return false;
      }
    })
    .slice(0, maxCandidates);

  const missingInfo = Array.isArray(parsed?.missingInfo) ? parsed.missingInfo.map((x: any) => String(x)) : undefined;

  return { assumptions, candidates, missingInfo };
}

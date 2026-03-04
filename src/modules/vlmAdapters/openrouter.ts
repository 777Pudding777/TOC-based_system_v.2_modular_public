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
import { wrapPromptBase } from "./prompts/basePrompt";

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
};



type DecisionCore = {
  verdict: VlmVerdict;
  confidence: number;
  rationale: string;

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
  };
};

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
      return x.params && typeof x.params.degrees === "number" && isFinite(x.params.degrees);

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

function getLastContext(evidenceViews: any[]): any | undefined {
  const last = evidenceViews?.[evidenceViews.length - 1];
  return last?.context;
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

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: any }> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, json };
  } finally {
    clearTimeout(id);
  }
}



export function createOpenRouterVlmAdapter(cfg: OpenRouterAdapterConfig): VlmAdapter {
  const endpoint = cfg.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = Math.max(5_000, Math.min(120_000, cfg.requestTimeoutMs ?? 45_000));

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

            const maxImages = Math.max(1, Math.min(16, cfg.maxImages ?? 4));
      const imageInputsCapped = imageInputs.slice(Math.max(0, imageInputs.length - maxImages));

            const imageIndex = imageInputsCapped.map((x, i) => ({
        i,
        snapshotId: x.snapshotId,
      }));
      const imageIndexJson = JSON.stringify(imageIndex, null, 2);


      const evidenceViewsJson = stableEvidenceJson(input.evidenceViews);
      const userText = wrapPromptBase({
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
          meta: { modelId: cfg.model ?? null, provider: "openrouter" },
        };
        return fallback;
      }

      const content: string =
        json?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.text ??
        "";

      const candidate = extractFirstJsonObject(String(content)) ?? String(content);

      let parsed: any = null;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        const fallback: DecisionCore = {
          verdict: "UNCERTAIN",
          confidence: 0.15,
          rationale: "Model returned non-JSON output; requesting another view.",
          visibility: {
            isRuleTargetVisible: false,
            occlusionAssessment: "HIGH",
            missingEvidence: ["Non-JSON output from model."],
          },
          evidence: { snapshotIds: [last.id], mode: last.mode, note: last.meta.note },
          followUp: { request: "NEW_VIEW", params: { reason: "Non-JSON output; need clearer evidence." } },
          meta: { modelId: cfg.model ?? null, provider: "openrouter" },
        };
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
          rationale: "Model returned incomplete JSON core; requesting another view.",
          visibility: {
            isRuleTargetVisible: false,
            occlusionAssessment: "HIGH",
            missingEvidence: ["Incomplete JSON core from model."],
          },
          evidence: { snapshotIds: [last.id], mode: last.mode, note: last.meta.note },
          followUp: { request: "NEW_VIEW", params: { reason: "Incomplete JSON; need clearer evidence." } },
          meta: { modelId: cfg.model ?? null, provider: "openrouter" },
        };
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

// --- Deterministic guardrail: prevent infinite NEW_VIEW loops for PoC ---
if (verdict === "UNCERTAIN") {
  const ctxAny = getLastContext(input.evidenceViews as any[]);
  const availableStoreys: string[] | undefined = ctxAny?.availableStoreys;
  const currentScopeStorey: string | undefined = ctxAny?.scope?.storeyId;
  const currentViewPreset: string | undefined = ctxAny?.viewPreset; // "iso" | "top"
  const isolatedCats: string[] | undefined = ctxAny?.isolatedCategories;

  const wantedStorey = pickStoreyFromPrompt(input.prompt, availableStoreys);

  const followUpIsNewView = followUp?.request === "NEW_VIEW";

  // If model says NEW_VIEW but we have an obvious next action, override it.
  if (!followUp || followUpIsNewView) {
    // 1) If prompt references a storey, isolate it first.
    if (wantedStorey && currentScopeStorey !== wantedStorey) {
      followUp = { request: "ISOLATE_STOREY", params: { storeyId: wantedStorey } } as any;
    }
    // 2) Then go to TOP view for accessibility checks.
    else if (currentViewPreset !== "top") {
      followUp = { request: "TOP_VIEW" } as any;
    }
    // 3) Then apply plan cut to remove walls above doors.
    else {
      followUp = {
        request: "SET_PLAN_CUT",
        params: { height: 1.2, mode: "WORLD_UP" },
      } as any;
    }

    // 4) Once we already are in top+plan cut, isolate doors.
    // (We can’t detect planCut state yet, so use isolatedCats heuristic.)
    if (
      followUp?.request === "SET_PLAN_CUT" &&
      isolatedCats &&
      isolatedCats.some((c) => normalize(c).includes("ifcdoor"))
    ) {
      // Already doors isolated, don't replace.
    } else if (
      currentViewPreset === "top" &&
      isolatedCats &&
      isolatedCats.length > 0 &&
      !isolatedCats.some((c) => normalize(c).includes("ifcdoor"))
    ) {
      followUp = { request: "ISOLATE_CATEGORY", params: { category: "IfcDoor" } } as any;
    }
  }
}


      const decision: DecisionCore = {
        verdict,
        confidence,
        rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "",
        visibility: safeVisibility,
        evidence: {
          // Let checker filter/normalize; we provide a deterministic default:
          snapshotIds: Array.isArray(parsed?.evidence?.snapshotIds) ? parsed.evidence.snapshotIds : [last.id],
          mode: (parsed?.evidence?.mode as any) ?? last.mode,
          note: parsed?.evidence?.note ?? last.meta.note,
        },
        followUp: verdict === "UNCERTAIN"
          ? (followUp ?? { request: "NEW_VIEW", params: { reason: "Need more evidence." } })
          : followUp,
        meta: {
          modelId: cfg.model ?? null,
          provider: "openrouter",
        },
      };

      return decision;
    },
  };
}

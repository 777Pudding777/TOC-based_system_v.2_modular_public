// src/modules/vlmChecker.ts
// VLM Checker: takes snapshots (multi-view evidence window) + rule prompt and returns a structured decision.
//
// Critical design decisions:
// - Strict structured output (verdict/confidence/followUp) for reproducibility.
// - Adapter interface so you can swap ChatGPT/Claude/open-weights later without touching UI/navigation.
// - Separation of concerns:
//   - Navigation computes geometry/visibility metrics (projectedAreaRatio/occlusionRatio/etc).
//   - VLM reasons semantically over what is visible and uses nav metrics as authoritative.

import type { SnapshotArtifact } from "./snapshotCollector";

const DEFAULT_ALLOWED_DOMAINS = ["codes.iccsafe.org"];
const WEB_FETCH_PROXY_BASE_URL =
  import.meta.env.VITE_WEB_FETCH_PROXY_URL ?? ""; // put your worker URL here via env

import { webFetchViaProxy } from "./vlmAdapters/tools/webFetch";
import {
  isTavilyAvailable,
  searchRuleContext,
  formatResultsForPrompt,
  webFetchViaTavily,
} from "./vlmAdapters/tools/tavilySearch";
import type { WebEvidenceRecord } from "../types/trace.types";
import { reduceRegulatoryTextWithOpenRouter } from "./regulatoryReducer";

// -------------------- Web fetching tools --------------------
type ReducerProviderConfig =
  | { provider: "mock" }
  | {
      provider: "openrouter";
      openrouter: {
        apiKey?: string;
        model?: string;
        endpoint?: string;
        requestTimeoutMs?: number;
        appTitle?: string;
        appReferer?: string;
      };
    }
  | {
      provider: "openai";
      openai: {
        apiKey?: string;
        model?: string;
        endpoint?: string;
        requestTimeoutMs?: number;
      };
    };

export type VlmVerdict = "PASS" | "FAIL" | "UNCERTAIN";

export type ViewPreset = "TOP" | "ISO" | "ORBIT";

export type VlmFollowUp =
  // Generic "get me another look" (orchestrator decides how)
  | { request: "NEW_VIEW"; params?: { reason?: string } }

  // View controls
  | { request: "SET_VIEW_PRESET"; params: { preset: ViewPreset } }
  | { request: "TOP_VIEW" } // keep backwards-compat
  | { request: "ISO_VIEW" } // keep backwards-compat
  | { request: "ORBIT"; params: { degrees: number } }
  | { request: "ZOOM_IN"; params?: { factor?: number } }

  // Scope tools (context)
  | { request: "ISOLATE_STOREY"; params: { storeyId: string } }
  | { request: "ISOLATE_SPACE"; params: { spaceId: string } }

  // Relevance filtering / visibility edits
  | { request: "ISOLATE_CATEGORY"; params: { category: string } }
  | { request: "HIDE_IDS"; params: { ids: string[]; reason?: string } }
  | { request: "SHOW_IDS"; params: { ids: string[] } }
  | { request: "RESET_VISIBILITY" }

  // Category visibility toggles
| { request: "HIDE_CATEGORY"; params: { category: string; reason?: string } }
| { request: "SHOW_CATEGORY"; params: { category: string } }
| { request: "PICK_CENTER"; params?: { reason?: string } }

// Object interaction
  | { request: "PICK_OBJECT"; params: { x: number; y: number } } // screen coords
  | { request: "GET_PROPERTIES"; params: { objectId: string } }
  | { request: "HIGHLIGHT_IDS"; params: { ids: string[]; style?: "primary" | "warn" } }
  | { request: "HIDE_SELECTED" }

  | { request: "SET_PLAN_CUT"; params: { height: number; thickness?: number; mode?: "WORLD_UP" | "CAMERA" } }
  | { request: "SET_STOREY_PLAN_CUT"; params: { storeyId: string; offsetFromFloor?: number; mode?: "WORLD_UP" | "CAMERA" } }
  | { request: "CLEAR_PLAN_CUT" }

// Internal tool-like step (no viewer action): fetch authoritative code text via allowlisted proxy
  | { request: "WEB_FETCH"; params: { url: string; maxChars?: number; selector?: string; focus?: { contains?: string[]; windowChars?: number } } };

export type VlmDecision = {
  decisionId: string;
  timestampIso: string;

  verdict: VlmVerdict;
  confidence: number; // 0..1

  rationale: string;

  // VLM must not guess geometry; it must rely on nav metrics (if present)
  visibility: {
    isRuleTargetVisible: boolean;
    occlusionAssessment: "LOW" | "MEDIUM" | "HIGH";
    missingEvidence?: string[];
  };

  evidence: {
    snapshotIds: string[]; // IDs from SnapshotArtifact.id (subset of input artifacts, stable order)
    mode: SnapshotArtifact["mode"];
    note?: string;
  };

  followUp?: VlmFollowUp;

  // Helpful for experiments / reproducibility
  meta: {
    modelId: string | null;
    promptHash: string;
    provider: string; // "mock", "openai", "anthropic", ...
  };
};

export type NavigationMetrics = {
  projectedAreaRatio?: number; // 0..1 visible content fraction (nav computes)
  occlusionRatio?: number; // 0..1 (nav computes)
  convergenceScore?: number; // optional (nav computes)
};

export type EvidenceView = {
  snapshotId: string;
  mode: SnapshotArtifact["mode"];
  note?: string;
  nav?: NavigationMetrics; // authoritative visibility metrics (nav computes)
  context?: any;           // runner-attached evidence context (pose, scope, hiddenIds, etc.)
};

export type VlmCheckInput = {
  prompt: string; // deterministic system+user payload (or equivalent)
  artifacts: SnapshotArtifact[]; // multi-view evidence window (ordered)
  evidenceViews: EvidenceView[]; // parallel structured evidence (same ordering)
};

export type VlmAdapter = {
  name: string;
  check: (input: VlmCheckInput) => Promise<Omit<VlmDecision, "decisionId" | "timestampIso">>;
};

export function hashPrompt(s: string) {
  // Tiny deterministic hash for logging (NOT crypto, but stable)
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a_${(h >>> 0).toString(16)}`;
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function isFollowUp(x: any): x is VlmFollowUp {
  if (!x || typeof x !== "object") return false;

  const req = x.request;

  switch (req) {
    case "NEW_VIEW":
      return !x.params || typeof x.params === "object";

    case "ISO_VIEW":
    case "TOP_VIEW":
      return true;

    case "SET_VIEW_PRESET":
      return (
        x.params &&
        (x.params.preset === "TOP" || x.params.preset === "ISO" || x.params.preset === "ORBIT")
      );

    case "ORBIT":
      return x.params && typeof x.params.degrees === "number" && isFinite(x.params.degrees);

    case "ZOOM_IN":
      return (
        !x.params ||
        (typeof x.params === "object" &&
          (x.params.factor === undefined ||
            (typeof x.params.factor === "number" && isFinite(x.params.factor))))
      );

    case "ISOLATE_CATEGORY":
      return x.params && typeof x.params.category === "string" && x.params.category.length > 0;

    case "ISOLATE_STOREY":
      return x.params && typeof x.params.storeyId === "string" && x.params.storeyId.length > 0;

    case "ISOLATE_SPACE":
      return x.params && typeof x.params.spaceId === "string" && x.params.spaceId.length > 0;

    case "HIDE_IDS":
      return (
        x.params &&
        Array.isArray(x.params.ids) &&
        x.params.ids.every((id: any) => typeof id === "string") &&
        (x.params.reason === undefined || typeof x.params.reason === "string")
      );

    case "SHOW_IDS":
      return x.params && Array.isArray(x.params.ids) && x.params.ids.every((id: any) => typeof id === "string");

    case "RESET_VISIBILITY":
      return true;

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

    case "HIGHLIGHT_IDS":
      return (
        x.params &&
        Array.isArray(x.params.ids) &&
        x.params.ids.every((id: any) => typeof id === "string") &&
        (x.params.style === undefined || x.params.style === "primary" || x.params.style === "warn")
      );
    case "WEB_FETCH":
      return (
        x.params &&
        typeof x.params.url === "string" &&
        x.params.url.length > 0 &&
        (x.params.maxChars === undefined || (typeof x.params.maxChars === "number" && isFinite(x.params.maxChars))) &&
        (x.params.selector === undefined || typeof x.params.selector === "string")
      );

    case "HIDE_SELECTED":
    case "HIDE_CATEGORY":
    case "SHOW_CATEGORY":
    case "PICK_CENTER":
    case "SET_PLAN_CUT":
    case "CLEAR_PLAN_CUT":
      return true;

    default:
      return false;
  }
}

function extractAllowedDomainsFromPrompt(p: string): string[] | null {
  const m = p.match(/AllowedSources:\s*([\s\S]*?)(\n\n|$)/i);
  if (!m) return null;

  const block = m[1];
  const lines = block
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);

  const domains: string[] = [];
  for (const raw of lines) {
    // Accept both full URLs and plain hostnames
    const candidate = raw.includes("://") ? raw : `https://${raw}`;
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (host) domains.push(host);
    } catch {
      // ignore invalid entries
    }
  }

  const uniq = Array.from(new Set(domains));
  return uniq.length ? uniq : null;
}

function composePromptWithRegulatoryContext(args: {
  userIntent: string;
  regulatoryContext: string;
  allowedDomains: string[];
  }): string {
  const allowedLines = args.allowedDomains.map((d) => `- https://${d}`).join("\n");
  const ctx = args.regulatoryContext.trim();

  return (
    "USER_INTENT:\n" +
    args.userIntent +
    "\n\n" +
    "AllowedSources:\n" +
    allowedLines +
    "\n\n" +
    "REGULATORY_CONTEXT:\n" +
    (ctx.length ? ctx : "(none yet; fetch if needed)") +
    "\n"
  );
}

function isVagueCompliancePrompt(p: string): boolean {
  const s = (p ?? "").toLowerCase();
  const hasNumber = /\b\d+(\.\d+)?\b/.test(s);            // any numeric threshold or clause
  const hasClauseWord = /\b(section|sec\.|clause|chapter)\b/.test(s);
  const hasEdition = /\b(20\d{2})\b/.test(s);
  return !(hasNumber || hasClauseWord) || !hasEdition;
}

function guessIccEntrypointUrl(userIntent: string, allowedDomains: string[]): string | null {
  // Deterministic fallback: if ICC is allowlisted and prompt mentions IBC 2018 -> use IBC2018P6 root.
  // Otherwise: just use ICC home (still on allowlist).
  const s = (userIntent ?? "").toLowerCase();
  const iccAllowed = allowedDomains.some(d => d === "codes.iccsafe.org" || d.endsWith(".iccsafe.org"));
  if (!iccAllowed) return null;

  if (s.includes("ibc") && s.includes("2018")) return "https://codes.iccsafe.org/content/IBC2018P6";
  if (s.includes("ibc") && s.includes("2021")) return "https://codes.iccsafe.org/content/IBC2021P2";
  // keep minimal; extend later with more editions if you want

  return "https://codes.iccsafe.org";
}

function normalizeInput(input: VlmCheckInput): VlmCheckInput {
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  // deterministically refuse empty windows early (single rule = one run still true)
  if (artifacts.length === 0) {
    throw new Error("VlmCheckInput.artifacts must include at least one SnapshotArtifact.");
  }

  const views = Array.isArray(input.evidenceViews) ? input.evidenceViews : [];

  // EvidenceViews should be parallel. If missing/short, synthesize deterministically from artifacts.
  if (views.length !== artifacts.length) {
  const synthesized: EvidenceView[] = artifacts.map(a => ({
  snapshotId: a.id,
  mode: a.mode,
  note: a.meta?.note,
  nav: undefined,
  context: (a.meta as any)?.context, // best-effort carry if snapshot meta includes it
  }));

    // If some views exist, keep them in order for the overlapping prefix; fill the rest.
    const min = Math.min(views.length, synthesized.length);
    for (let i = 0; i < min; i++) {
      const v = views[i];
      synthesized[i] = {
        snapshotId: typeof v?.snapshotId === "string" ? v.snapshotId : artifacts[i].id,
        mode: (v?.mode as any) ?? artifacts[i].mode,
        note: v?.note ?? artifacts[i].meta?.note,
        nav: v?.nav,
        context: (v as any)?.context ?? (artifacts[i].meta as any)?.context,
      };
    }

    return { ...input, artifacts, evidenceViews: synthesized };
  }

  return { ...input, artifacts, evidenceViews: views };
}


function finalizeDecision(
  core: Omit<VlmDecision, "decisionId" | "timestampIso">,
  input: VlmCheckInput,
  provider: string
  ): VlmDecision {
  const allowedIds = input.artifacts.map(a => a.id);
  const allowed = new Set(allowedIds);

  // Evidence IDs must be a subset of provided artifacts.
  // If adapter omits or provides invalid list, default to all window artifacts deterministically.
  const rawIds = core.evidence?.snapshotIds;
  const filtered =
    Array.isArray(rawIds) && rawIds.length > 0
      ? rawIds.filter(id => typeof id === "string" && allowed.has(id))
      : allowedIds;

  // Preserve stable ordering as provided by adapter (after filtering),
  // but if adapter returns duplicates, dedupe while preserving order.
  const seen = new Set<string>();
  const snapshotIds = filtered.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const verdict: VlmVerdict =
    core.verdict === "PASS" || core.verdict === "FAIL" || core.verdict === "UNCERTAIN"
      ? core.verdict
      : "UNCERTAIN";

  const confidence =
    typeof core.confidence === "number" && isFinite(core.confidence) ? clamp01(core.confidence) : 0.0;

  const visibility = core.visibility ?? {
    isRuleTargetVisible: false,
    occlusionAssessment: "HIGH" as const,
    missingEvidence: ["Adapter did not provide visibility; defaulted to conservative."],
  };

  return {
    decisionId: crypto.randomUUID(),
    timestampIso: new Date().toISOString(),
    verdict,
    confidence,
    rationale: String(core.rationale ?? ""),
    visibility: {
      isRuleTargetVisible: Boolean(visibility.isRuleTargetVisible),
      occlusionAssessment:
        visibility.occlusionAssessment === "LOW" ||
        visibility.occlusionAssessment === "MEDIUM" ||
        visibility.occlusionAssessment === "HIGH"
          ? visibility.occlusionAssessment
          : "HIGH",
      missingEvidence: Array.isArray(visibility.missingEvidence)
        ? visibility.missingEvidence.map(x => String(x))
        : undefined,
    },
    evidence: {
      snapshotIds,
      mode: (core.evidence?.mode as any) ?? input.artifacts[input.artifacts.length - 1].mode,
      note: core.evidence?.note,
    },
followUp: isFollowUp(core.followUp) ? core.followUp : undefined,

    meta: {
      modelId: core.meta?.modelId ?? input.artifacts[input.artifacts.length - 1]?.meta.modelId ?? null,
      promptHash: core.meta?.promptHash ?? hashPrompt(input.prompt),
      provider: core.meta?.provider ?? provider,
    },
  };
}

/**
 * Mock adapter:
 * - Deterministic behavior based on snapshot count + keywords.
 * - Purpose: prove the loop works end-to-end before real APIs.
 */
export function createMockVlmAdapter(): VlmAdapter {
  return {
    name: "mock",
    async check({ prompt, artifacts }) {
      const p = prompt.toLowerCase();
      const last = artifacts[artifacts.length - 1];
      const allIds = artifacts.map(a => a.id);
      const isFirstStep = allIds.length === 1;

      // Extremely simple heuristics:
      // - If prompt contains "door" → suggest isolate doors
      // - Otherwise request another view first time, then decide "PASS" on second.
      const wantsDoor = p.includes("door");
      const wantsStairs = p.includes("stair");

      if (isFirstStep) {
        return {
          verdict: "UNCERTAIN",
          confidence: 0.35,
          rationale: "Mock: first view often insufficient. Requesting a better viewpoint.",
          visibility: {
            isRuleTargetVisible: false,
            occlusionAssessment: "HIGH",
            missingEvidence: ["Need clearer viewpoint / less occlusion."],
          },
          evidence: {
            snapshotIds: [last.id],
            mode: last.mode,
            note: last.meta.note,
          },
          followUp: wantsDoor
            ? { request: "ISOLATE_CATEGORY", params: { category: "IfcDoor" } }
            : wantsStairs
              ? { request: "ISO_VIEW" }
              : { request: "NEW_VIEW", params: { reason: "Need a clearer viewpoint / less occlusion." } },
          meta: {
            modelId: last.meta.modelId,
            promptHash: hashPrompt(prompt),
            provider: "mock",
          },
        };
      }

      // Second+ snapshot: decide PASS with moderate confidence
      return {
        verdict: "PASS",
        confidence: 0.72,
        rationale: "Mock: sufficient evidence in later snapshot. Marking PASS for PoC.",
        visibility: {
          isRuleTargetVisible: true,
          occlusionAssessment: "MEDIUM",
        },
        evidence: {
          snapshotIds: allIds, // link all window snapshots to this decision
          mode: last.mode,
          note: last.meta.note,
        },
        meta: {
          modelId: last.meta.modelId,
          promptHash: hashPrompt(prompt),
          provider: "mock",
        },
      };
    },
  };
}

export function createVlmChecker(
  adapter: VlmAdapter,
  options?: {
    onWebEvidence?: (entry: WebEvidenceRecord) => void;
    hasWebEvidenceForUrl?: (url: string) => boolean;
    getProviderConfig?: () => ReducerProviderConfig;
  }
) {
        async function fetchRegulatoryContextDirect(args: {
        step: number;
        url: string;
        userIntent: string;
        allowedDomains: string[];
        maxChars?: number;
      }): Promise<string | null> {
        const { step, url, userIntent, allowedDomains } = args;
        const maxChars = args.maxChars ?? 20000;

        // Prefer Tavily
        if (isTavilyAvailable()) {
          console.log("[VLM] Direct prefetch via Tavily start:", { url });

          const result = await webFetchViaTavily({
            targetUrl: url,
            userIntent,
            allowedDomains,
            maxChars,
            cache: { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, persist: true },
          });

          let reducedText = "";
          let reductionHeadings: string[] | undefined;
          let reductionRationale: string | undefined;
          let reductionError: string | undefined;

          if (result.ok) {
            const reduced = await reduceFetchedRegulatoryText({
              ruleText: userIntent,
              sourceUrl: result.url,
              rawText: result.text ?? "",
            });
            reducedText = reduced.reducedText;
            reductionHeadings = reduced.headings;
            reductionRationale = reduced.rationale;
            reductionError = reduced.error;
          }

          options?.onWebEvidence?.({
            step,
            sourceType: "WEB_FETCH",
            url: result.url,
            fetchedAt: new Date().toISOString(),
            ok: result.ok,
            chars: result.text?.length ?? 0,
            fromCache: result.fromCache,
            via: `tavily/${result.source}` as "tavily/extract" | "tavily/search",
            text: result.text ?? "",
            reducedText: reducedText || undefined,
            reductionHeadings,
            reductionRationale,
            reductionError,
            error: result.error,
          });

          console.log("[VLM] Direct prefetch via Tavily done:", {
            ok: result.ok,
            chars: result.text?.length ?? 0,
            reducedChars: reducedText.length,
            error: result.error,
            reductionError,
            fromCache: result.fromCache,
            source: result.source,
          });

          if (result.ok) {
            return (
              `WEB_EVIDENCE:\n[source: ${result.url}]\n` +
              `[via: tavily/${result.source}]\n` +
              `${result.fromCache ? `[cache: ${result.fromCache}]\n` : ""}` +
              `${reducedText}\n`
            );
          }
        }

        // Proxy fallback
        if (WEB_FETCH_PROXY_BASE_URL) {
          console.log("[VLM] Direct prefetch via proxy start:", { url, proxy: WEB_FETCH_PROXY_BASE_URL });

          const result = await webFetchViaProxy({
            targetUrl: url,
            allowedDomains,
            proxyBaseUrl: WEB_FETCH_PROXY_BASE_URL,
            maxChars,
            cache: { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, persist: true },
          });

          let reducedText = "";
          let reductionHeadings: string[] | undefined;
          let reductionRationale: string | undefined;
          let reductionError: string | undefined;

          if (result.ok) {
            const reduced = await reduceFetchedRegulatoryText({
              ruleText: userIntent,
              sourceUrl: result.url,
              rawText: result.text ?? "",
            });
            reducedText = reduced.reducedText;
            reductionHeadings = reduced.headings;
            reductionRationale = reduced.rationale;
            reductionError = reduced.error;
          }

          options?.onWebEvidence?.({
            step,
            sourceType: "WEB_FETCH",
            url: result.url,
            fetchedAt: new Date().toISOString(),
            ok: result.ok,
            chars: result.text?.length ?? 0,
            fromCache: result.fromCache,
            via: "proxy",
            text: result.text ?? "",
            reducedText: reducedText || undefined,
            reductionHeadings,
            reductionRationale,
            reductionError,
            error: result.error,
          });

          console.log("[VLM] Direct prefetch via proxy done:", {
            ok: result.ok,
            chars: result.text?.length ?? 0,
            reducedChars: reducedText.length,
            error: result.error,
            reductionError,
            fromCache: result.fromCache,
          });

          if (result.ok) {
            return (
              `WEB_EVIDENCE:\n[source: ${result.url}]\n` +
              `${result.fromCache ? `[cache: ${result.fromCache}]\n` : ""}` +
              `${reducedText}\n`
            );
          }
        }

        return null;
      }

        async function reduceFetchedRegulatoryText(args: {
          ruleText: string;
          sourceUrl: string;
          rawText: string;
        }): Promise<{
          reducedText: string;
          headings?: string[];
          rationale?: string;
          error?: string;
        }> {
          const cfg = options?.getProviderConfig?.();

          if (cfg?.provider === "openrouter" && cfg.openrouter?.apiKey && cfg.openrouter?.model) {
            const reduced = await reduceRegulatoryTextWithOpenRouter({
              apiKey: String(cfg.openrouter.apiKey),
              model: String(cfg.openrouter.model),
              endpoint: cfg.openrouter.endpoint,
              requestTimeoutMs: cfg.openrouter.requestTimeoutMs,
              appTitle: cfg.openrouter.appTitle,
              appReferer: cfg.openrouter.appReferer,
              input: {
                ruleText: args.ruleText,
                sourceUrl: args.sourceUrl,
                rawText: args.rawText,
                maxChars: 3500,
              },
            });

            if (reduced.ok) {
              return {
                reducedText: reduced.reducedText,
                headings: reduced.headings,
                rationale: reduced.rationale,
              };
            }

            return {
              reducedText: args.rawText.slice(0, 3500),
              error: reduced.error,
            };
          }

          return {
            reducedText: args.rawText.slice(0, 3500),
            error: "No reducer provider configured; used truncated raw text.",
          };
        }

  return {
    adapterName: adapter.name,

    async check(input: VlmCheckInput): Promise<VlmDecision> {
      const norm0 = normalizeInput(input);

      // Keep original user prompt stable; accumulate regulatory context deterministically.
      const userIntent = norm0.prompt;
      let regulatoryContext = "";
      const fetchedUrls = new Set<string>();

      const allowedDomains = extractAllowedDomainsFromPrompt(userIntent) ?? DEFAULT_ALLOWED_DOMAINS;

      // Run at most 2 iterations: initial decision + (optional) one WEB_FETCH grounding pass.
      for (let step = 0; step < 3; step++) {
        let composedPrompt = composePromptWithRegulatoryContext({
          userIntent,
          regulatoryContext,
          allowedDomains,
        });

        // Deterministic prefetch: do not rely on the model to request WEB_FETCH first.
        if (step === 0 && !regulatoryContext.trim() && isVagueCompliancePrompt(userIntent)) {
          const prefetchUrl = guessIccEntrypointUrl(userIntent, allowedDomains);

          if (
            prefetchUrl &&
            !fetchedUrls.has(prefetchUrl) &&
            !options?.hasWebEvidenceForUrl?.(prefetchUrl)
          ) {
            fetchedUrls.add(prefetchUrl);

            const injected = await fetchRegulatoryContextDirect({
              step,
              url: prefetchUrl,
              userIntent,
              allowedDomains,
              maxChars: 20000,
            });

            if (injected) {
              regulatoryContext = (regulatoryContext ? regulatoryContext + "\n\n" : "") + injected;
            } else {
              composedPrompt +=
                "\n\nSYSTEM_NOTE:\n" +
                "The requirement is vague / missing thresholds. Prioritize WEB_FETCH first to retrieve the authoritative clause text from AllowedSources.\n" +
                "If you don’t know the section URL yet, fetch a relevant code TOC/chapter page first.\n";
            }
          } else {
            composedPrompt +=
              "\n\nSYSTEM_NOTE:\n" +
              "The requirement is vague / missing thresholds. Prioritize WEB_FETCH first to retrieve the authoritative clause text from AllowedSources.\n" +
              "If you don’t know the section URL yet, fetch a relevant code TOC/chapter page first.\n";
          }

          composedPrompt = composePromptWithRegulatoryContext({
            userIntent,
            regulatoryContext,
            allowedDomains,
          });
        }
        const norm: VlmCheckInput = { ...norm0, prompt: composedPrompt };
        const core = await adapter.check(norm);

        //--------------------------------------------------
        //--------------WEB_FETCH FOLLOW-UP LOGIC----------------
        //---------------------------------------------------
        // If model requests WEB_FETCH, execute it internally and re-run once.
                const fu = isFollowUp(core.followUp) ? core.followUp : undefined;
        if (core.verdict === "UNCERTAIN" && fu?.request === "WEB_FETCH") {
          console.log("[VLM] WEB_FETCH requested. raw params:", fu.params);

          let url = (fu.params as any)?.url as string | undefined;

          // Fallback if model forgot url
          if (!url) {
            url = guessIccEntrypointUrl(userIntent, allowedDomains) ?? undefined;
            console.log("[VLM] WEB_FETCH missing url; fallback entrypoint:", url);
          }

          if (!url) {
            const patched = {
              ...core,
              followUp: {
                request: "NEW_VIEW",
                params: { reason: "WEB_FETCH requested but no url provided and no fallback entrypoint available." },
              } as VlmFollowUp,
            };
            return finalizeDecision(patched as any, norm, adapter.name);
          }

          if (fetchedUrls.has(url)) {
            const patched = {
              ...core,
              followUp: { request: "NEW_VIEW", params: { reason: "Regulatory source already fetched; need better model evidence now." } } as VlmFollowUp,
              rationale:
                (core.rationale ? core.rationale + " " : "") +
                "Regulatory source already fetched in this run; further progress requires better visual evidence, not another web fetch.",
            };
            return finalizeDecision(patched as any, norm, adapter.name);
          }
          fetchedUrls.add(url);

          const maxChars = (fu.params as any)?.maxChars ?? 20000;

          // 1) Prefer Tavily for URL-grounded fetch/extract
          if (isTavilyAvailable()) {
            console.log("[VLM] WEB_FETCH via Tavily start:", { url });

            const t0 = performance.now();
            const result = await webFetchViaTavily({
              targetUrl: url,
              userIntent,
              allowedDomains,
              maxChars,
              cache: { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, persist: true },
            });

            let reducedText = "";
            let reductionHeadings: string[] | undefined;
            let reductionRationale: string | undefined;
            let reductionError: string | undefined;

            if (result.ok) {
              const reduced = await reduceFetchedRegulatoryText({
                ruleText: userIntent,
                sourceUrl: result.url,
                rawText: result.text ?? "",
              });
              reducedText = reduced.reducedText;
              reductionHeadings = reduced.headings;
              reductionRationale = reduced.rationale;
              reductionError = reduced.error;
            }

            options?.onWebEvidence?.({
              step,
              sourceType: "WEB_FETCH",
              url: result.url,
              fetchedAt: new Date().toISOString(),
              ok: result.ok,
              chars: result.text?.length ?? 0,
              fromCache: result.fromCache,
              via: `tavily/${result.source}` as "tavily/extract" | "tavily/search",
              text: result.text ?? "",
              reducedText: reducedText || undefined,
              reductionHeadings,
              reductionRationale,
              reductionError,
              error: result.error,
            });

            console.log("[VLM] WEB_FETCH via Tavily done:", {
              ok: result.ok,
              ms: Math.round(performance.now() - t0),
              chars: result.text?.length ?? 0,
              reducedChars: reducedText.length,
              error: result.error,
              reductionError,
              fromCache: result.fromCache,
              source: result.source,
            });

            if (result.ok) {
              const injected =
                `WEB_EVIDENCE:\n[source: ${result.url}]\n` +
                `[via: tavily/${result.source}]\n` +
                `${result.fromCache ? `[cache: ${result.fromCache}]\n` : ""}` +
                `${reducedText}\n`;

              regulatoryContext = (regulatoryContext ? regulatoryContext + "\n\n" : "") + injected;
              continue;
            }

            console.warn("[VLM] Tavily fetch failed; falling back to proxy.", result.error);
          }

          // 2) Optional proxy fallback
          if (!WEB_FETCH_PROXY_BASE_URL) {
            // Final soft fallback: broad Tavily search context if available
            if (isTavilyAvailable()) {
              console.log("[VLM] No proxy configured; using Tavily search fallback.");
              const searchQuery = `site:${new URL(url).hostname} ${userIntent}`;
              const tavilyResult = await searchRuleContext(searchQuery).catch(() => null);
              if (tavilyResult && tavilyResult.results.length > 0) {
                for (const r of tavilyResult.results) {
                  options?.onWebEvidence?.({
                    step,
                    sourceType: "TAVILY_SEARCH",
                    url: r.url,
                    fetchedAt: new Date().toISOString(),
                    ok: true,
                    chars: (r.rawContent ?? r.content ?? "").length,
                    via: "tavily/search",
                    query: tavilyResult.query,
                    title: r.title,
                    text: r.rawContent ?? r.content ?? "",
                  });
                }
              }
            }

            
            const patched = {
              ...core,
              followUp: undefined,
              rationale:
                (core.rationale ? core.rationale + " " : "") +
                "WEB_FETCH failed and no proxy is configured (VITE_WEB_FETCH_PROXY_URL).",
            };
            
            return finalizeDecision(patched as any, norm, adapter.name);
          }

          console.log("[VLM] WEB_FETCH via proxy start:", { url, proxy: WEB_FETCH_PROXY_BASE_URL });
          const t0 = performance.now();

          const result = await webFetchViaProxy({
            targetUrl: url,
            allowedDomains,
            proxyBaseUrl: WEB_FETCH_PROXY_BASE_URL,
            maxChars,
            cache: { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, persist: true },
          });

                    options?.onWebEvidence?.({
            step,
            sourceType: "WEB_FETCH",
            url: result.url,
            fetchedAt: new Date().toISOString(),
            ok: result.ok,
            chars: result.text?.length ?? 0,
            fromCache: result.fromCache,
            via: "proxy",
            text: result.text ?? "",
            error: result.error,
          });

          console.log("[VLM] WEB_FETCH via proxy done:", {
            ok: result.ok,
            ms: Math.round(performance.now() - t0),
            chars: result.text?.length ?? 0,
            error: result.error,
            fromCache: (result as any).fromCache,
          });

          const injected = result.ok
            ? `WEB_EVIDENCE:\n[source: ${result.url}]\n${(result as any).fromCache ? `[cache: ${(result as any).fromCache}]\n` : ""}${result.text}\n`
            : `WEB_EVIDENCE_ERROR:\n[source: ${result.url}]\n${result.error}\n`;

          regulatoryContext = (regulatoryContext ? regulatoryContext + "\n\n" : "") + injected;
          continue;
        }

        // Normal path: finalize now.
        return finalizeDecision(core, norm, adapter.name);
      }


// Should not reach here; fallback conservative.
    const composedPrompt = composePromptWithRegulatoryContext({
      userIntent,
      regulatoryContext,
      allowedDomains,
    });
    const norm: VlmCheckInput = { ...norm0, prompt: composedPrompt };
    const fallbackCore = await adapter.check(norm);
    return finalizeDecision(fallbackCore, norm, adapter.name);
    },

  };
}

// src/modules/vlmAdapters/openai.ts
//
// OpenAI MLLM adapter for compliance checking.
// - Does NOT modify vlmChecker.ts or complianceRunner.ts.
// - Uses OpenAI Responses API with vision input and Structured Outputs (json_schema strict).
// - Client-side API key is inherently insecure; treat as dev/testing unless you add a proxy later.

import type { SnapshotArtifact } from "../snapshotCollector";
import type { VlmAdapter, VlmCheckInput, VlmFollowUp, VlmVerdict } from "../vlmChecker";

export type OpenAiAdapterConfig = {
  apiKey: string;
  model: string; // must support vision + structured outputs
  endpoint?: string; // default: https://api.openai.com/v1/responses
  imageDetail?: "low" | "high" | "auto";
  requestTimeoutMs?: number; // optional safeguard
};

type DecisionCore = {
  verdict: VlmVerdict;
  confidence: number; // 0..1
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
    promptHash?: string; // allow omit; vlmChecker.finalizeDecision will fill
    provider: string;
  };
};

// JSON Schema must match your vlmChecker.ts core shape (minus decisionId/timestampIso).
// Keep this tight; strict schema helps cross-provider comparability later.
const DECISION_SCHEMA = {
  name: "vlm_decision",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "confidence", "rationale", "visibility", "evidence", "meta"],
    properties: {
      verdict: { type: "string", enum: ["PASS", "FAIL", "UNCERTAIN"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string" },

      visibility: {
        type: "object",
        additionalProperties: false,
        required: ["isRuleTargetVisible", "occlusionAssessment"],
        properties: {
          isRuleTargetVisible: { type: "boolean" },
          occlusionAssessment: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
          missingEvidence: { type: "array", items: { type: "string" } },
        },
      },

      evidence: {
        type: "object",
        additionalProperties: false,
        required: ["snapshotIds", "mode"],
        properties: {
          snapshotIds: { type: "array", items: { type: "string" }, minItems: 1 },
          mode: { type: "string" },
          note: { type: "string" },
        },
      },

      followUp: {
        type: "object",
        additionalProperties: false,
        required: ["request"],
        properties: {
          request: {
            type: "string",
            enum: ["NEW_VIEW", "ISO_VIEW", "TOP_VIEW", "ZOOM_IN", "ORBIT", "ISOLATE_CATEGORY"],
          },
          // params differs by followUp kind; keep permissive here and rely on your runner to act safely.
          params: { type: "object" },
        },
      },

      meta: {
        type: "object",
        additionalProperties: false,
        required: ["modelId", "provider"],
        properties: {
          modelId: { anyOf: [{ type: "string" }, { type: "null" }] },
          promptHash: { type: "string" },
          provider: { type: "string" },
        },
      },
    },
  },
  strict: true,
} as const;

function pickOutputText(json: any): string | null {
  // Responses API returns output items; we extract the first output_text chunk deterministically.
  const out = json?.output;
  if (!Array.isArray(out)) return null;

  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part?.text === "string") return part.text;
      }
    }
  }
  return null;
}

function ensureDataUrl(s: string): string {
  // If SnapshotArtifact already provides a data URL, keep it.
  if (s.startsWith("data:image/")) return s;
  // Else assume it's raw base64 PNG (common) and normalize.
  return `data:image/png;base64,${s}`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Failed reading blob as data URL"));
    r.onload = () => resolve(String(r.result || ""));
    r.readAsDataURL(blob);
  });
}

async function artifactToImageDataUrl(a: SnapshotArtifact): Promise<string> {
  // We don’t know your SnapshotArtifact fields yet, so we try common ones safely.
  // This preserves your “no changes for now” constraint.
  const anyA: any = a as any;

  const direct =
    (typeof anyA.dataUrl === "string" && anyA.dataUrl) ||
    (typeof anyA.imageDataUrl === "string" && anyA.imageDataUrl);

  if (direct) return ensureDataUrl(direct);

  const url =
    (typeof anyA.url === "string" && anyA.url) ||
    (typeof anyA.blobUrl === "string" && anyA.blobUrl) ||
    (typeof anyA.href === "string" && anyA.href);

  if (!url) {
    throw new Error(
      "SnapshotArtifact has no dataUrl/imageDataUrl and no fetchable url/blobUrl/href for image content."
    );
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch snapshot image: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  return await blobToDataUrl(blob);
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

export function createOpenAiVlmAdapter(cfg: OpenAiAdapterConfig): VlmAdapter {
  const endpoint = cfg.endpoint ?? "https://api.openai.com/v1/responses";
  const detail = cfg.imageDetail ?? "high";
  const timeoutMs = Math.max(5_000, Math.min(120_000, cfg.requestTimeoutMs ?? 45_000));

  return {
    name: "openai",

    async check(input: VlmCheckInput) {
      if (!cfg.apiKey) throw new Error("OpenAI adapter missing apiKey.");
      if (!cfg.model) throw new Error("OpenAI adapter missing model.");

      const artifacts = input.artifacts;
      if (!Array.isArray(artifacts) || artifacts.length === 0) {
        throw new Error("OpenAI adapter requires at least one snapshot artifact.");
      }
      const last = artifacts[artifacts.length - 1];

      // IMPORTANT: keep a deterministic wrapper, but don’t rely on promptHash here.
      // Your vlmChecker.finalizeDecision will compute promptHash from input.prompt if missing.
      const instructions =
        "You are a BIM compliance checker.\n" +
        "- Use evidenceViews.nav metrics as authoritative for visibility/occlusion.\n" +
        "- Do NOT guess geometry beyond those metrics.\n" +
        "- Return ONLY JSON matching the provided schema (no markdown, no extra keys).\n";

      // Ensure evidenceViews are visible to the model in a deterministic, stable form.
      // (Sorted keys via JSON.stringify; stable order because input.evidenceViews is ordered already.)
      const evidenceViewsJson = JSON.stringify(input.evidenceViews, null, 2);

      // Convert all window images to data URLs (ordered).
      const images = await Promise.all(artifacts.map(a => artifactToImageDataUrl(a)));

      // Responses API request using:
      // - input_image items
      // - Structured Outputs via text.format json_schema strict
      const body = {
        model: cfg.model,
        store: false,
        temperature: 0,
        top_p: 1,
        instructions,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: input.prompt },
              {
                type: "input_text",
                text:
                  "evidenceViews (authoritative nav metrics; same ordering as images):\n" +
                  evidenceViewsJson,
              },
              ...images.map(img => ({ type: "input_image", image_url: img, detail })),
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            ...DECISION_SCHEMA,
          },
        },
      };

      const { ok, status, json } = await fetchJsonWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs
      );

      if (!ok) {
        const msg = json?.error?.message || `OpenAI request failed (${status}).`;
        throw new Error(msg);
      }

      const txt = pickOutputText(json);
      if (!txt) throw new Error("OpenAI response contained no output_text.");

      let parsed: DecisionCore;
      try {
        parsed = JSON.parse(txt);
      } catch {
        throw new Error("OpenAI returned non-JSON despite json_schema format.");
      }

      // Pin provider/modelId for reproducibility, but leave promptHash to vlmChecker finalizer.
      parsed.meta = {
        modelId: cfg.model ?? null,
        provider: "openai",
      };

      // Ensure evidence.mode/note have deterministic defaults if the model omits them.
      parsed.evidence = {
        snapshotIds:
          Array.isArray(parsed.evidence?.snapshotIds) && parsed.evidence.snapshotIds.length > 0
            ? parsed.evidence.snapshotIds
            : [last.id],
        mode: (parsed.evidence?.mode as any) ?? last.mode,
        note: parsed.evidence?.note ?? last.meta.note,
      };

      return parsed;
    },
  };
}

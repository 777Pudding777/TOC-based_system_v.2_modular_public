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

export type VlmVerdict = "PASS" | "FAIL" | "UNCERTAIN";

export type VlmFollowUp =
  | { request: "NEW_VIEW"; params?: { reason?: string } }
  | { request: "ISO_VIEW" }
  | { request: "TOP_VIEW" }
  | { request: "ZOOM_IN"; params?: { factor?: number } }
  | { request: "ORBIT"; params: { degrees: number } }
  | { request: "ISOLATE_CATEGORY"; params: { category: string } };

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

  if (x.request === "NEW_VIEW") return !x.params || typeof x.params === "object";
  if (x.request === "ISO_VIEW") return true;
  if (x.request === "TOP_VIEW") return true;
  if (x.request === "ZOOM_IN") return !x.params || typeof x.params === "object";
  if (x.request === "ORBIT") return x.params && typeof x.params.degrees === "number";
  if (x.request === "ISOLATE_CATEGORY") return x.params && typeof x.params.category === "string";

  return false;
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

export function createVlmChecker(adapter: VlmAdapter) {
  return {
    adapterName: adapter.name,

async check(input: VlmCheckInput): Promise<VlmDecision> {
  const norm = normalizeInput(input);
  const core = await adapter.check(norm);
  return finalizeDecision(core, norm, adapter.name);
},

  };
}

export type RegulatoryReductionInput = {
  ruleText: string;
  sourceUrl: string;
  rawText: string;
  maxChars?: number;
};

export type RegulatoryReductionResult = {
  ok: boolean;
  reducedText: string;
  headings?: string[];
  rationale?: string;
  error?: string;
};

type JsonShape = {
  relevantClauses: Array<{
    heading: string;
    excerpt: string;
  }>;
  ruleFocusedSummary: string;
  droppedContentKinds?: string[];
};

function extractFirstJsonObject(text: string): string | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  return text.slice(a, b + 1);
}

function buildReducerPrompt(input: RegulatoryReductionInput) {
  const system = [
    "You extract only rule-relevant regulatory text from authoritative fetched code content.",
    "Return ONLY valid JSON. No markdown. No extra keys.",
    "Use ONLY the provided rule text and fetched text.",
    "Keep exact dimensions, thresholds, exceptions, applicability conditions, and directional qualifiers when relevant.",
    "Remove promotional/site chrome, navigation text, figure labels, image references, duplicated fragments, and unrelated sections.",
    "Do not invent missing clauses.",
    "Prefer the smallest set of excerpts sufficient for the rule.",
    "Output JSON shape:",
    "{",
    '  "relevantClauses": [{ "heading": "string", "excerpt": "string" }],',
    '  "ruleFocusedSummary": "string",',
    '  "droppedContentKinds": "string[] optional"',
    "}",
  ].join("\n");

  const user = JSON.stringify({
    ruleText: input.ruleText,
    sourceUrl: input.sourceUrl,
    maxChars: input.maxChars ?? 3500,
    fetchedText: input.rawText,
  });

  return { system, user };
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

function compactReducedOutput(parsed: JsonShape, maxChars: number): string {
  const parts: string[] = [];

  for (const c of parsed.relevantClauses ?? []) {
    const heading = String(c?.heading ?? "").trim();
    const excerpt = String(c?.excerpt ?? "").trim();
    if (!heading || !excerpt) continue;
    parts.push(`${heading}\n${excerpt}`);
  }

  const summary = String(parsed.ruleFocusedSummary ?? "").trim();
  if (summary) {
    parts.push(`Rule-focused summary\n${summary}`);
  }

  return parts.join("\n\n").slice(0, Math.max(256, maxChars));
}

export async function reduceRegulatoryTextWithOpenRouter(args: {
  apiKey: string;
  model: "openai/gpt-4",
  endpoint?: string;
  requestTimeoutMs?: number;
  appTitle?: string;
  appReferer?: string;
  input: RegulatoryReductionInput;
}): Promise<RegulatoryReductionResult> {
  const endpoint = args.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = Math.max(5_000, Math.min(120_000, args.requestTimeoutMs ?? 45_000));
  const { system, user } = buildReducerPrompt(args.input);

  const body = {
    model: args.model,
    temperature: 0,
    top_p: 1,
    max_tokens: 1200,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  };

  const { ok, status, json } = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
        ...(args.appReferer ? { "HTTP-Referer": args.appReferer } : {}),
        ...(args.appTitle ? { "X-Title": args.appTitle } : {}),
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!ok) {
    return {
      ok: false,
      reducedText: "",
      error: json?.error?.message || `Reducer request failed (${status}).`,
    };
  }

  const content: string =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    "";

  const candidate = extractFirstJsonObject(String(content)) ?? String(content);

  let parsed: JsonShape | null = null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      ok: false,
      reducedText: "",
      error: "Reducer returned non-JSON output.",
    };
  }

  const reducedText = compactReducedOutput(parsed, args.input.maxChars ?? 3500);
  const headings = (parsed.relevantClauses ?? [])
    .map((x) => String(x?.heading ?? "").trim())
    .filter(Boolean);

  return {
    ok: reducedText.length > 0,
    reducedText,
    headings,
    rationale: String(parsed.ruleFocusedSummary ?? "").trim() || undefined,
    error: reducedText.length > 0 ? undefined : "Reducer returned empty reduced text.",
  };
}
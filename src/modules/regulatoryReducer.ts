import { DEFAULT_REDUCED_TAVILY_MAX_CHARS } from "../config/prototypeSettings";

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
    maxChars: input.maxChars ?? DEFAULT_REDUCED_TAVILY_MAX_CHARS,
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
                : `Regulatory reducer request timed out after ${timeoutMs}ms.`,
          },
        },
      };
    }
    throw error;
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
  model: string;
  endpoint?: string;
  requestTimeoutMs?: number;
  appTitle?: string;
  appReferer?: string;
  input: RegulatoryReductionInput;
}): Promise<RegulatoryReductionResult> {
  const endpoint = args.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = Math.max(5_000, Math.min(180_000, args.requestTimeoutMs ?? 90_000));
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

  const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
  let parsed = parseModelJson<JsonShape>(content);

  if (!parsed) {
    const retryBody = {
      ...body,
      temperature: 0,
      top_p: 1,
      messages: [
        {
          role: "system",
          content:
            "Return ONLY valid minified JSON object with keys relevantClauses, ruleFocusedSummary, droppedContentKinds. No markdown, no prose, no code fences.",
        },
        { role: "user", content: user },
      ],
    };

    const retry = await fetchJsonWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
          ...(args.appReferer ? { "HTTP-Referer": args.appReferer } : {}),
          ...(args.appTitle ? { "X-Title": args.appTitle } : {}),
        },
        body: JSON.stringify(retryBody),
      },
      timeoutMs
    );

    if (retry.ok) {
      const retryContent = retry.json?.choices?.[0]?.message?.content ?? retry.json?.choices?.[0]?.text ?? "";
      parsed = parseModelJson<JsonShape>(retryContent);
    }
  }

  if (!parsed) {
    return {
      ok: false,
      reducedText: "",
      error: `Reducer returned non-JSON output (${describeModelOutput(content)}).`,
    };
  }

    const reducedText = compactReducedOutput(parsed, args.input.maxChars ?? DEFAULT_REDUCED_TAVILY_MAX_CHARS);
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

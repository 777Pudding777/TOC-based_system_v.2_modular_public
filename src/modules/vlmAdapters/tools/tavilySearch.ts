// src/modules/vlmAdapters/tools/tavilySearch.ts
// Optional Tavily web-search integration for regulatory code lookups.
// Also provides a WebFetch-style Tavily extraction path for authoritative URL grounding.

import { getEnvironmentConfig } from "../../../config/environment";

/* ───────── Types ───────── */

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;       // snippet / extracted text
  score: number;         // relevance score 0-1
  rawContent?: string;   // full extracted page text (when include_raw_content=true)
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  answer?: string;       // Tavily's AI-generated answer (if requested)
  responseTimeMs: number;
}

export type TavilyWebFetchResult = {
  ok: boolean;
  url: string;
  text: string;
  error?: string;
  fromCache?: "memory" | "localStorage";
  source: "extract" | "search";
};

type CacheEntry = {
  url: string;
  text: string;
  fetchedAt: number;
  source: "extract" | "search";
};

type TavilyExtractItem = {
  url: string;
  rawContent: string;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const memCache = new Map<string, CacheEntry>();

/* ───────── Helpers ───────── */

function compactQueryForTavily(input: string, maxLen = 350): string {
  const s = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trim();
}

function getApiKey(): string | null {
  return getEnvironmentConfig().tavilyApiKey;
}

export function isTavilyAvailable(): boolean {
  return !!getApiKey();
}

function cacheKey(url: string) {
  return `tavily:webfetch:v1:${url}`;
}

function isAllowlisted(url: string, allowedDomains: string[]): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return allowedDomains.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

function loadFromLocalStorage(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.text !== "string" ||
      typeof parsed.fetchedAt !== "number" ||
      (parsed.source !== "extract" && parsed.source !== "search")
    ) {
      return null;
    }
    return parsed as CacheEntry;
  } catch {
    return null;
  }
}

function saveToLocalStorage(key: string, entry: CacheEntry) {
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // ignore quota/security errors
  }
}

async function tavilyPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("[TavilySearch] No API key configured (VITE_TAVILY_API_KEY).");
  }

  const res = await fetch(`https://api.tavily.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[TavilySearch] HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return (await res.json()) as T;
}

/* ───────── Core search ───────── */

async function tavilySearch(params: {
  query: string;
  searchDepth?: "basic" | "advanced";
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  topic?: "general" | "news";
}): Promise<TavilySearchResponse> {
  const start = performance.now();

  const body: Record<string, unknown> = {
    query: params.query,
    search_depth: params.searchDepth ?? "basic",
    max_results: params.maxResults ?? 5,
    include_answer: params.includeAnswer ?? false,
    include_raw_content: params.includeRawContent ?? false,
    topic: params.topic ?? "general",
  };

  if (params.includeDomains?.length) {
    body.include_domains = params.includeDomains;
  }
  if (params.excludeDomains?.length) {
    body.exclude_domains = params.excludeDomains;
  }

  const data: any = await tavilyPost("/search", body);
  const elapsed = Math.round(performance.now() - start);

  const results: TavilySearchResult[] = (data.results ?? []).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
    score: typeof r.score === "number" ? r.score : 0,
    rawContent: r.raw_content ?? undefined,
  }));

  return {
    query: params.query,
    results,
    answer: data.answer ?? undefined,
    responseTimeMs: elapsed,
  };
}

/* ───────── Extract ───────── */

async function tavilyExtract(params: {
  urls: string[];
  query?: string;
  extractDepth?: "basic" | "advanced";
  format?: "text" | "markdown";
  timeout?: number;
}): Promise<{ results: TavilyExtractItem[] }> {
  const body: Record<string, unknown> = {
    urls: params.urls,
    extract_depth: params.extractDepth ?? "advanced",
    format: params.format ?? "text",
  };

  if (params.query) body.query = params.query;
  if (typeof params.timeout === "number") body.timeout = params.timeout;

  const data: any = await tavilyPost("/extract", body);

  return {
    results: Array.isArray(data?.results)
      ? data.results.map((r: any) => ({
          url: typeof r?.url === "string" ? r.url : "",
          rawContent: typeof r?.raw_content === "string" ? r.raw_content : "",
        }))
      : [],
  };
}

/* ───────── Domain-specific search helpers ───────── */

const BUILDING_CODE_DOMAINS = [
  "codes.iccsafe.org",
  "up.codes",
  "law.cornell.edu",
  "ecfr.gov",
  "ada.gov",
  "access-board.gov",
];

export async function searchRuleContext(
  ruleText: string,
  options?: {
    extraDomains?: string[];
    maxResults?: number;
    includeAnswer?: boolean;
  },
): Promise<TavilySearchResponse | null> {
  if (!isTavilyAvailable()) {
    console.info("[TavilySearch] Tavily not configured; skipping rule-context search.");
    return null;
  }

  const domains = [
    ...BUILDING_CODE_DOMAINS,
    ...(options?.extraDomains ?? []),
  ];

  try {
    return await tavilySearch({
      query: `building code regulation: ${ruleText}`,
      searchDepth: "advanced",
      maxResults: options?.maxResults ?? 5,
      includeDomains: domains,
      includeAnswer: options?.includeAnswer ?? true,
    });
  } catch (err) {
    console.warn("[TavilySearch] searchRuleContext failed:", err);
    return null;
  }
}

export async function searchBuildingCode(
  codeName: string,
  sectionRef: string,
): Promise<TavilySearchResponse | null> {
  if (!isTavilyAvailable()) return null;

  try {
    return await tavilySearch({
      query: `${codeName} ${sectionRef} full text regulation`,
      searchDepth: "advanced",
      maxResults: 3,
      includeDomains: BUILDING_CODE_DOMAINS,
      includeAnswer: false,
      includeRawContent: true,
    });
  } catch (err) {
    console.warn("[TavilySearch] searchBuildingCode failed:", err);
    return null;
  }
}

export async function searchVisualCheckGuidance(
  topic: string,
): Promise<TavilySearchResponse | null> {
  if (!isTavilyAvailable()) return null;

  try {
    return await tavilySearch({
      query: `BIM IFC visual compliance check: ${topic}`,
      searchDepth: "basic",
      maxResults: 3,
      includeAnswer: true,
    });
  } catch (err) {
    console.warn("[TavilySearch] searchVisualCheckGuidance failed:", err);
    return null;
  }
}

/* ───────── WebFetch-style Tavily grounding ───────── */

export async function webFetchViaTavily(params: {
  targetUrl: string;
  userIntent?: string;
  allowedDomains: string[];
  maxChars?: number;
  cache?: {
    enabled?: boolean;
    ttlMs?: number;
    persist?: boolean;
  };
}): Promise<TavilyWebFetchResult> {
  const { targetUrl, allowedDomains, userIntent } = params;
  const maxChars = params.maxChars ?? 20000;
  const cacheOpts = params.cache ?? { enabled: true, ttlMs: DEFAULT_TTL_MS, persist: true };
  const cacheEnabled = cacheOpts.enabled !== false;
  const ttlMs =
    typeof cacheOpts.ttlMs === "number" && isFinite(cacheOpts.ttlMs)
      ? cacheOpts.ttlMs
      : DEFAULT_TTL_MS;
  const persist = cacheOpts.persist !== false;

  if (!isAllowlisted(targetUrl, allowedDomains)) {
    return { ok: false, url: targetUrl, text: "", error: "URL not in AllowedSources allowlist.", source: "extract" };
  }

  const key = cacheKey(targetUrl);

  if (cacheEnabled) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.fetchedAt <= ttlMs) {
      return {
        ok: true,
        url: targetUrl,
        text: hit.text.slice(0, maxChars),
        fromCache: "memory",
        source: hit.source,
      };
    }
  }

  if (cacheEnabled && persist) {
    const hit = loadFromLocalStorage(key);
    if (hit && Date.now() - hit.fetchedAt <= ttlMs) {
      memCache.set(key, hit);
      return {
        ok: true,
        url: targetUrl,
        text: hit.text.slice(0, maxChars),
        fromCache: "localStorage",
        source: hit.source,
      };
    }
  }

  if (!isTavilyAvailable()) {
    return { ok: false, url: targetUrl, text: "", error: "Tavily API key not configured.", source: "extract" };
  }

  try {
    // 1) Prefer exact URL extraction.
    const safeQuery = userIntent ? compactQueryForTavily(userIntent) : undefined;
    const extracted = await tavilyExtract({
      urls: [targetUrl],
      query: safeQuery,
      extractDepth: "advanced",
      format: "text",
      timeout: 20,
    });

    const exact = extracted.results.find((r) => r.url === targetUrl) ?? extracted.results[0];
    const exactText = exact?.rawContent?.trim() ?? "";

    if (exactText.length > 0) {
      const fullText = exactText;
      const clipped = fullText.slice(0, maxChars);
      const entry: CacheEntry = {
        url: targetUrl,
        text: fullText,
        fetchedAt: Date.now(),
        source: "extract",
      };
      if (cacheEnabled) {
        memCache.set(key, entry);
        if (persist) saveToLocalStorage(key, entry);
      }
      return { ok: true, url: targetUrl, text: clipped, source: "extract" };
    }

    // 2) Fallback to Tavily search scoped to the same domain.
    const hostname = new URL(targetUrl).hostname;
    const q = safeQuery?.trim()
      ? compactQueryForTavily(`site:${hostname} ${safeQuery}`)
      : `site:${hostname} ${targetUrl}`;

    const search = await tavilySearch({
      query: q,
      searchDepth: "advanced",
      maxResults: 5,
      includeDomains: [hostname],
      includeAnswer: false,
      includeRawContent: true,
    });

    const best =
      search.results.find((r) => r.url === targetUrl && (r.rawContent || r.content)) ??
      search.results.find((r) => r.url.includes(hostname) && (r.rawContent || r.content)) ??
      search.results[0];

    const searchText = (best?.rawContent ?? best?.content ?? "").trim();
    if (!searchText) {
      return { ok: false, url: targetUrl, text: "", error: "Tavily returned no extractable text.", source: "search" };
    }

    const fullText =
      `TAVILY_SEARCH_MATCH:\n${best?.title ?? ""}\n[source: ${best?.url ?? targetUrl}]\n\n${searchText}`.trim();
    const clipped = fullText.slice(0, maxChars);

    const entry: CacheEntry = {
      url: targetUrl,
      text: fullText,
      fetchedAt: Date.now(),
      source: "search",
    };
    if (cacheEnabled) {
      memCache.set(key, entry);
      if (persist) saveToLocalStorage(key, entry);
    }

    return {
      ok: true,
      url: best?.url ?? targetUrl,
      text: clipped,
      source: "search",
    };
  } catch (e: any) {
    return {
      ok: false,
      url: targetUrl,
      text: "",
      error: e?.message ?? String(e),
      source: "extract",
    };
  }
}

/* ───────── Prompt formatting ───────── */

export function formatResultsForPrompt(response: TavilySearchResponse): string {
  if (!response.results.length) return "";

  const lines: string[] = [
    `TAVILY_SEARCH_RESULTS (query: "${response.query}"):` ,
  ];

  if (response.answer) {
    lines.push(`AI Summary: ${response.answer}`);
    lines.push("");
  }

  for (const r of response.results.slice(0, 5)) {
    lines.push(`[${r.title}] (${r.url})`);
    const snippet = r.content.length > 500 ? r.content.slice(0, 497) + "..." : r.content;
    lines.push(snippet);
    lines.push("");
  }

  return lines.join("\n");
}
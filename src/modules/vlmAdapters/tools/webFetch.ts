// src/modules/vlmAdapters/tools/webFetch.ts

export type WebFetchParams = {
  url: string;
  maxChars?: number;
  // Optional caching controls
  cache?: {
    enabled?: boolean;   // default true
    ttlMs?: number;      // default 7 days
    persist?: boolean;   // default true (localStorage)
  };
 };
 
 export type WebFetchResult = {
   ok: boolean;
   url: string;
   text: string;
   error?: string;
  fromCache?: "memory" | "localStorage";
 };
 
type CacheEntry = {
  url: string;
  text: string;
  fetchedAt: number; // epoch ms
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const memCache = new Map<string, CacheEntry>();

function cacheKey(url: string) {
  return `webfetch:v1:${url}`;
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "GET", signal: ctrl.signal });
  } finally {
    window.clearTimeout(t);
  }
}

function loadFromLocalStorage(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.url !== "string" || typeof parsed.text !== "string" || typeof parsed.fetchedAt !== "number") {
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


/**
 * Very small HTML->text sanitizer.
 * Keep it generic; you can add provider-specific extractors later.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowlisted(url: string, allowedDomains: string[]): boolean {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  return allowedDomains.some(d => host === d || host.endsWith("." + d));
}

export async function webFetchViaProxy(params: {
  targetUrl: string;
  allowedDomains: string[];
  proxyBaseUrl: string; // e.g. https://your-worker.workers.dev
  maxChars?: number;
  cache?: WebFetchParams["cache"];
}): Promise<WebFetchResult> {
  const { targetUrl, allowedDomains, proxyBaseUrl } = params;
  const maxChars = params.maxChars ?? 20000;
  const cacheOpts = params.cache ?? { enabled: true, ttlMs: DEFAULT_TTL_MS, persist: true };
  const cacheEnabled = cacheOpts.enabled !== false;
  const ttlMs = typeof cacheOpts.ttlMs === "number" && isFinite(cacheOpts.ttlMs) ? cacheOpts.ttlMs : DEFAULT_TTL_MS;
  const persist = cacheOpts.persist !== false;

  const key = cacheKey(targetUrl);

  // 1) Memory cache
  if (cacheEnabled) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.fetchedAt <= ttlMs) {
      return { ok: true, url: targetUrl, text: hit.text.slice(0, maxChars), fromCache: "memory" };
    }
  }

  // 2) localStorage cache
  if (cacheEnabled && persist) {
    const hit = loadFromLocalStorage(key);
    if (hit && Date.now() - hit.fetchedAt <= ttlMs) {
      // warm memory cache
      memCache.set(key, hit);
      return { ok: true, url: targetUrl, text: hit.text.slice(0, maxChars), fromCache: "localStorage" };
    }
  }

  try {
    if (!isAllowlisted(targetUrl, allowedDomains)) {
      return { ok: false, url: targetUrl, text: "", error: "URL not in AllowedSources allowlist." };
    }

    const proxyUrl = new URL(proxyBaseUrl);
    proxyUrl.searchParams.set("url", targetUrl);

    const res = await fetchTextWithTimeout(proxyUrl.toString(), 15000);
    if (!res.ok) {
      return { ok: false, url: targetUrl, text: "", error: `Proxy HTTP ${res.status}` };
    }

    // Proxy can return HTML or already-extracted text.
    const contentType = res.headers.get("content-type") || "";
    const body = await res.text();

    const text = contentType.includes("text/plain")
      ? body.trim()
      : htmlToText(body);

    const clipped = text.slice(0, maxChars);

    // Save cache only if we got usable text.
    if (cacheEnabled && clipped.length > 0) {
      const entry: CacheEntry = { url: targetUrl, text: text, fetchedAt: Date.now() };
      memCache.set(key, entry);
      if (persist) saveToLocalStorage(key, entry);
    }

    return {
      ok: true,
      url: targetUrl,
      text: clipped,
    };
  } catch (e: any) {
    return { ok: false, url: targetUrl, text: "", error: e?.message ?? String(e) };
  }
}
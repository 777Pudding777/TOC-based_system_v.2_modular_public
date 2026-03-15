// worker.js (Cloudflare Worker)

const ALLOWED_HOSTS = [
  "codes.iccsafe.org",
  // later: "eur-lex.europa.eu", ...
];

export default {
  async fetch(request, env, ctx) {
    // --- CORS (always) ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return withCors(request, new Response("Missing url parameter", { status: 400 }));

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return withCors(request, new Response("Invalid url", { status: 400 }));
    }

    // --- allowlist ---
    const host = targetUrl.hostname.toLowerCase();
    const ok = ALLOWED_HOSTS.some((d) => host === d || host.endsWith("." + d));
    if (!ok) return withCors(request, new Response("Blocked by allowlist", { status: 403 }));

    // --- edge cache by full worker URL (includes encoded target URL) ---
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    // Only cache GET
    if (request.method === "GET") {
      const cached = await cache.match(cacheKey);
      if (cached) return withCors(request, cached);
    }

    // --- upstream fetch ---
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        redirect: "follow",
        headers: {
          // ICC tends to behave better with browser-ish headers
          "User-Agent":
            "Mozilla/5.0 (compatible; BIM-ACC WebFetch/1.0; +https://example.com)",
          Accept: "text/html,application/xhtml+xml,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cf: {
          cacheEverything: true,
          cacheTtl: 3600, // 1 hour edge cache
        },
      });
    } catch (e) {
      return withCors(
        request,
        new Response(`Upstream fetch failed: ${String(e?.message ?? e)}`, { status: 502 })
      );
    }

    // Read as text (front-end strips HTML)
    const body = await upstream.text();

    // Preserve content-type if provided; default to html
    const ct = upstream.headers.get("content-type") || "text/html; charset=utf-8";

    // Build response
    const resp = new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": ct,
        // Avoid caching forever if upstream errors
        "Cache-Control": upstream.ok ? "public, max-age=3600" : "no-store",
      },
    });

    // Cache successful responses only
    if (request.method === "GET" && upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }

    return withCors(request, resp);
  },
};

function corsHeaders(request) {
  // If you want stricter: set to your app origin instead of "*"
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(request, response) {
  const h = corsHeaders(request);
  const out = new Response(response.body, response);

  // Apply CORS headers to every response (incl. errors)
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);

  // Sometimes upstream sends headers that can be annoying in embedded contexts
  out.headers.delete("content-security-policy");
  out.headers.delete("x-frame-options");

  return out;
}
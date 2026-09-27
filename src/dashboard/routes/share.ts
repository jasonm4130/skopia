/**
 * Skopia — public read-only share surface: /share/:token and its views
 * (ADR-0012).
 */

import type { Context, Hono } from "hono";
import { getSiteByPublicToken } from "../../db/queries";
import type { LiveSnapshot, SiteRow } from "../../shared/types";
import type { DashEnv } from "../env";
import { parseRange, todayUtc } from "../range";
import { htmlDoc, publicLayout, rangePicker } from "../render/layout";
import { BREAKDOWN_VIEWS, overviewContent, type ViewCtx } from "../views";

// ---------------------------------------------------------------------------
// Public share-link surface: /share/:token — read-only, single-site, no auth
// (launch-readiness Task 1, ADR-0012). Excluded from the root securityHeaders
// middleware (src/index.ts) — this surface mints its own nonce and sets its
// own complete hardening header set via publicSecurityHeaders below, so the
// header and the nonce baked into the body always come from the same request.
// ---------------------------------------------------------------------------

// Token shape pre-filter (Global Constraint 5): reject anything that isn't a
// well-formed share token before it ever reaches D1. "shr_" + 43 URL-safe
// chars matches the 32-byte CSPRNG token operators mint per docs/install.md.
const SHARE_TOKEN_SHAPE = /^shr_[A-Za-z0-9_-]{43}$/;

// Fully static — no nonce or token interpolation — so unknown, malformed, and
// revoked tokens all produce byte-identical bodies (Global Constraint 5).
const SHARE_NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found — Skopia</title></head>
<body style="margin:0;height:100%;background:#0a0c11;font-family:sans-serif;">
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:#8b92a4;">Dashboard not found.</div>
</body>
</html>`;

/**
 * Complete hardening header set for /share/* responses: the same strict CSP
 * (nonce + strict-dynamic, no unsafe-inline) and header set the root
 * securityHeaders middleware applies to authed pages, plus X-Robots-Tag —
 * duplicated locally rather than imported because /share/* mints its own
 * nonce independent of the root middleware it is excluded from.
 */
function publicSecurityHeaders(nonce: string): Record<string, string> {
  const csp = [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `default-src 'self'`,
    `font-src 'self'`,
    `img-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

// Read-through cache TTL for the public share surface (Global Constraint 6):
// KV key lifetime, Cache-API freshness, and the response's s-maxage all use it.
const SHARE_CACHE_TTL_SECONDS = 60;

// A fully-rendered public page: the HTML plus the nonce baked into both its CSP
// header and its inline scripts. Stored together so a cache replay keeps them in
// lockstep (a page's header nonce always matches its body nonce).
interface CachedPublicPage {
  html: string;
  nonce: string;
}

/** Rebuild the exact public Response from a rendered page: same headers a fresh
 *  render would emit, so a KV-tier replay is indistinguishable from the origin. */
function buildPublicResponse(page: CachedPublicPage): Response {
  return new Response(page.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, s-maxage=${SHARE_CACHE_TTL_SECONDS}`,
      ...publicSecurityHeaders(page.nonce),
    },
  });
}

/**
 * Read-through cache for the public /share/* surface (ADR-0012 §4). Two tiers:
 * the per-isolate Cache API (`caches.default`, keyed by a synthetic in-zone URL)
 * fronts the cross-isolate `CACHE` KV namespace. A hit at either tier replays a
 * previously rendered page verbatim — HTML and the nonce in both the CSP header
 * and the inline scripts — so cached pages never desync header/body nonces and
 * never re-run D1.
 *
 * On a full miss it reads the live-visitor count once (a single `SITE_LIVE`
 * `snapshot()` RPC, best-effort: a DO failure degrades to no badge, never a
 * 500), renders, then writes both tiers via `waitUntil` so the response is not
 * held on the cache write.
 *
 * `cacheKey` is keyed by site id, never by token (Global Constraint 6): a
 * rotated/revoked token can't bust another token's cache, and two tokens for one
 * site share a single entry. `siteId` is read back from the key (segment 2 of
 * `share:v1:{site_id}:{view}:{range}:{day}`) to address the DO.
 */
async function cachedPublicResponse(
  c: Context<DashEnv>,
  cacheKey: string,
  ttl: number,
  render: (onlineCount: number | null) => Promise<CachedPublicPage>,
): Promise<Response> {
  const cache = caches.default;
  const cacheReq = new Request(`https://cache.local/${cacheKey}`);

  const edgeHit = await cache.match(cacheReq);
  if (edgeHit) return edgeHit;

  const kvHit = await c.env.CACHE.get<CachedPublicPage>(cacheKey, {
    type: "json",
    cacheTtl: ttl,
  });
  if (kvHit) {
    const res = buildPublicResponse(kvHit);
    // Warm the near tier so the next request skips the KV round-trip.
    c.executionCtx.waitUntil(cache.put(cacheReq, res.clone()));
    return res;
  }

  // Full miss: read the live count once, best-effort. A DO failure must degrade
  // to no badge, never a 500 — the count is a nicety, the page is the product.
  let onlineCount: number | null = null;
  // Segment 2 of share:v1:{site_id}:{view}:{range}:{day}.
  // ponytail: assumes site ids carry no ':' (the WAE-index slug convention);
  // pass the site id as its own arg if that ever stops holding.
  const siteId = cacheKey.split(":")[2];
  if (siteId) {
    try {
      const ns = c.env.SITE_LIVE;
      const stub = ns.get(ns.idFromName(siteId)) as unknown as {
        snapshot(): Promise<LiveSnapshot>;
      };
      onlineCount = (await stub.snapshot()).visitors;
    } catch {
      onlineCount = null;
    }
  }

  const page = await render(onlineCount);
  const res = buildPublicResponse(page);

  c.executionCtx.waitUntil(c.env.CACHE.put(cacheKey, JSON.stringify(page), { expirationTtl: ttl }));
  c.executionCtx.waitUntil(cache.put(cacheReq, res.clone()));

  return res;
}

/**
 * Resolve a share token to its site for a /share/:token/* route: the shape
 * pre-filter (Global Constraint 5) runs before any D1 read, then an unknown
 * or revoked token gets the same byte-identical 404 as a malformed one.
 * Every /share/* route shares this exact resolution + 404 body — extracted
 * here once Task 3 adds five more callers of it.
 */
async function resolveShareSite(c: Context<DashEnv>, token: string): Promise<SiteRow | Response> {
  if (!SHARE_TOKEN_SHAPE.test(token)) {
    return c.html(
      SHARE_NOT_FOUND_HTML,
      404,
      publicSecurityHeaders(crypto.randomUUID().replace(/-/g, "")),
    );
  }

  const site = await getSiteByPublicToken(c.env.DB, token);
  if (!site) {
    return c.html(
      SHARE_NOT_FOUND_HTML,
      404,
      publicSecurityHeaders(crypto.randomUUID().replace(/-/g, "")),
    );
  }

  return site;
}

export function registerShareRoutes(dashboard: Hono<DashEnv>): void {
  // `/share/` with no token (trailing slash, empty segment) never matches
  // `/share/:token` and would otherwise fall through to Hono's default 404
  // with none of the /share/* hardening headers (src/index.ts excludes this
  // whole prefix from the root securityHeaders middleware). Serve the same
  // not-found response the malformed/unknown-token paths use so every
  // /share/* response sets the complete header set.
  dashboard.get("/share/", (c) =>
    c.html(SHARE_NOT_FOUND_HTML, 404, publicSecurityHeaders(crypto.randomUUID().replace(/-/g, ""))),
  );

  /**
   * One cached public page: resolve the token, build the cache key (keyed by
   * site id, never token — Global Constraint 6), and on a miss render `view`
   * with a freshly minted nonce baked into both header and body.
   */
  const servePublic = async (
    c: Context<DashEnv>,
    view: string,
    title: (site: SiteRow) => string,
    content: (ctx: ViewCtx) => Promise<string>,
  ): Promise<Response> => {
    const token = c.req.param("token") ?? "";
    const site = await resolveShareSite(c, token);
    if (site instanceof Response) return site;

    const range = parseRange(c.req.query("range"));
    const cacheKey = `share:v1:${site.id}:${view}:${range.key}:${todayUtc()}`;

    return cachedPublicResponse(c, cacheKey, SHARE_CACHE_TTL_SECONDS, async (onlineCount) => {
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const body = await content({ db: c.env.DB, site, range, nonce });
      const headerRight = rangePicker(range.key, "");
      const html = htmlDoc(
        title(site),
        "",
        publicLayout(view, token, site, headerRight, body, nonce, range.key, onlineCount),
        nonce,
      );
      return { html, nonce };
    });
  };

  // Overview
  dashboard.get("/share/:token", (c) =>
    servePublic(
      c,
      "overview",
      (site) => site.name,
      (ctx) => overviewContent(ctx, { share: true }),
    ),
  );

  // Breakdown views — the same table the /app routes register from, minus
  // the views ADR-0012 keeps off the public surface.
  for (const view of BREAKDOWN_VIEWS.filter((v) => v.shared)) {
    dashboard.get(`/share/:token/${view.id}`, (c) =>
      servePublic(c, view.id, (site) => `${view.title} — ${site.name}`, view.content),
    );
  }
}

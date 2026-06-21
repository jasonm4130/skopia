/**
 * Stratus — collector (the ingestion hot path).
 *
 * Routed at `OPTIONS /e` (CORS preflight) and `POST /e` (beacon). Pipeline per
 * the spec §3: CORS allowlist -> validate -> bot drop -> enrich -> cookieless
 * identity -> `WAE.writeDataPoint` -> bump SiteLive DO via waitUntil -> 204.
 */

import type { Beacon, Env, WaeEvent } from "../shared/types";
import { WAE_BLOB_SLOTS, WAE_DOUBLE_SLOTS } from "../shared/types";
import { enrichFromCf, isBot, parseReferrerHost, parseUserAgent, parseUtm, bucketScreenWidth } from "../shared/cf";
import { deriveVid, getDailySalt, utcDay } from "../shared/identity";

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS_BASE = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

/**
 * Fetch the per-site origin allowlist from D1 in one query.
 *
 * Fix #6a (MED): merged the two former D1 lookups (origin_allowlist fetch +
 * existence check) into a single SELECT. Returns null when the site does not
 * exist, [] when it exists but has no/empty allowlist, or the list of origins.
 */
async function getSiteAllowlist(
  env: Env,
  siteId: string,
): Promise<string[] | null> {
  const row = await env.DB.prepare(
    "SELECT origin_allowlist FROM sites WHERE id = ?",
  )
    .bind(siteId)
    .first<{ origin_allowlist: string | null }>();

  // null row → site does not exist
  if (row === null) return null;

  // Row exists but allowlist is empty or null → open site
  if (!row.origin_allowlist) return [];

  return row.origin_allowlist
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    ...CORS_HEADERS_BASE,
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

/** Answer the CORS preflight for `OPTIONS /e`. */
export function handlePreflight(request: Request, env: Env): Response {
  void env;
  const origin = request.headers.get("Origin") ?? "";
  if (!origin) return new Response(null, { status: 400 });
  // For preflight we cannot yet look up the site_id (it's in the body, not the
  // URL), so we echo the origin back. The actual origin check happens on POST.
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

// ---------------------------------------------------------------------------
// Beacon serializer: WaeEvent -> WaeDataPoint (indexes + blobs + doubles)
// ---------------------------------------------------------------------------

function toDataPoint(event: WaeEvent): { indexes: [string]; blobs: string[]; doubles: number[] } {
  const blobs = WAE_BLOB_SLOTS.map((key) => String(event[key]));
  const doubles = WAE_DOUBLE_SLOTS.map((key) => Number(event[key]));
  return { indexes: [event.siteId], blobs, doubles };
}

// ---------------------------------------------------------------------------
// Main collect handler
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 2048; // 2 KB payload cap (spec §3.2)
const MAX_PROPS_JSON_BYTES = 512; // cap on serialized custom-event props

/** Handle a `POST /e` beacon: validate, enrich, identity, WAE write, live bump. */
export async function handleCollect(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ---------- 0. Validate method + content type ----------
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const origin = request.headers.get("Origin") ?? "";
  const ua = request.headers.get("User-Agent") ?? "";

  // ---------- 1. Validate payload size ----------
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413, headers: origin ? corsHeaders(origin) : {} });
  }

  // ---------- 2. Parse body ----------
  let beacon: Beacon;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return new Response(null, { status: 413, headers: origin ? corsHeaders(origin) : {} });
    }
    beacon = JSON.parse(text) as Beacon;
  } catch {
    return new Response(null, { status: 400, headers: origin ? corsHeaders(origin) : {} });
  }

  // ---------- 3. Validate beacon shape ----------
  const siteId = beacon.s;
  if (
    !siteId ||
    typeof siteId !== "string" ||
    !beacon.t ||
    (beacon.t !== "pv" && beacon.t !== "event") ||
    !beacon.p ||
    typeof beacon.p !== "string"
  ) {
    return new Response(null, { status: 400, headers: origin ? corsHeaders(origin) : {} });
  }

  // Custom events must have a name
  if (beacon.t === "event" && (!beacon.n || typeof beacon.n !== "string")) {
    return new Response(null, { status: 400, headers: origin ? corsHeaders(origin) : {} });
  }

  // ---------- 4. Enrich from CF + UA (fix #6b: before D1 queries so bots cost no D1 reads) ----------
  const cf = enrichFromCf(request);
  const uaInfo = parseUserAgent(ua);

  // ---------- 5. Heuristic bot drop (fix #6b: moved BEFORE D1 lookups, spec §3 ordering) ----------
  if (isBot(request, ua, cf)) {
    // Silently accept (don't tell scrapers they're being dropped)
    return new Response(null, {
      status: 204,
      headers: origin ? corsHeaders(origin) : {},
    });
  }

  // ---------- 6. D1: single lookup for site existence + allowlist (fix #6a: merged queries) ----------
  const allowlist = await getSiteAllowlist(env, siteId);

  // null = site does not exist
  if (allowlist === null) {
    return new Response(null, { status: 404, headers: origin ? corsHeaders(origin) : {} });
  }

  // ---------- 7. CORS: validate origin against per-site allowlist ----------
  // Fix #2 (HIGH): if the site has a non-empty allowlist, requests with NO Origin
  // header are also rejected — a headerless POST would bypass the allowlist entirely.
  // Only open sites (empty allowlist) accept headerless requests.
  if (allowlist.length > 0) {
    if (!origin || !allowlist.includes(origin)) {
      return new Response(null, { status: 403, headers: origin ? corsHeaders(origin) : {} });
    }
  }

  // ---------- 8. Cookieless identity ----------
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For") ??
    "0.0.0.0";
  const today = utcDay(new Date());
  const salt = await getDailySalt(env.SALT, today);
  const vid = await deriveVid(env.IDENTITY_HMAC_SECRET, salt, ip, ua, siteId);

  // ---------- 9. Parse client-supplied fields ----------
  const referrerHost = parseReferrerHost(beacon.r);
  const utm = parseUtm(beacon.p);

  // Prefer UA-derived device class; fall back to screen-width bucket when UA says desktop
  // (some mobile browsers identify as desktop — the screen width is the tiebreaker)
  const deviceClass =
    uaInfo.deviceClass !== "desktop" ? uaInfo.deviceClass : bucketScreenWidth(beacon.w);

  // Serialize custom-event props (cap at MAX_PROPS_JSON_BYTES)
  let propsJson = "";
  if (beacon.d && Object.keys(beacon.d).length > 0) {
    const raw = JSON.stringify(beacon.d);
    propsJson = raw.length <= MAX_PROPS_JSON_BYTES ? raw : "";
  }

  // ---------- 10. Build WAE event ----------
  const isPageview = beacon.t === "pv" ? 1 : 0;
  const waeEvent: WaeEvent = {
    siteId,
    vid,
    pathname: beacon.p,
    referrerHost,
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    country: cf.country,
    deviceClass,
    browser: uaInfo.browser,
    os: uaInfo.os,
    eventName: beacon.n ?? "",
    entryPath: beacon.p, // MVP: entry path = current path (no session tracking)
    propsJson,
    count: 1,
    isPageview: isPageview as 0 | 1,
    screenWidth: beacon.w ?? 0,
  };

  // ---------- 11. Write to WAE (synchronous) ----------
  env.WAE.writeDataPoint(toDataPoint(waeEvent));

  // ---------- 12. Bump SiteLive DO (async, non-blocking) ----------
  const doId = env.SITE_LIVE.idFromName(siteId);
  const doStub = env.SITE_LIVE.get(doId);
  ctx.waitUntil(
    doStub.fetch(
      new Request("https://do-internal/hit", {
        method: "POST",
        body: JSON.stringify({ vid, path: beacon.p }),
      }),
    ).catch(() => {
      // DO is best-effort; don't let failures kill the beacon response
    }),
  );

  // ---------- 13. Respond 204 ----------
  return new Response(null, {
    status: 204,
    headers: origin ? corsHeaders(origin) : {},
  });
}

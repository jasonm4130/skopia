/**
 * Skopia — collector (the ingestion hot path).
 *
 * Routed at `OPTIONS /e` (CORS preflight) and `POST /e` (beacon). Pipeline per
 * the spec §3: CORS allowlist -> validate -> bot drop -> enrich -> cookieless
 * identity -> `WAE.writeDataPoint` -> bump SiteLive DO via waitUntil -> 204.
 */

import {
  bucketScreenWidth,
  enrichFromCf,
  isBot,
  parseReferrerHost,
  parseUserAgent,
  parseUtm,
} from "../shared/cf";
import { requireSecrets, SecretsMissingError } from "../shared/config";
import { deriveVid, getDailySalt, utcDay } from "../shared/identity";
import type { Beacon, Env, WaeEvent } from "../shared/types";
import { WAE_BLOB_SLOTS, WAE_DOUBLE_SLOTS } from "../shared/types";

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS_BASE = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

// ---------------------------------------------------------------------------
// Task 7: per-isolate hot-path caches
//
// Every beacon paid an uncached D1 site lookup and a KV salt read, both
// constant per isolate (site config) or per day (salt). A module-level cache
// bounds each to one read per TTL window, per isolate. Consequence: an
// allowlist/domain edit takes effect within <=60s on any given isolate —
// acceptable for the collector hot path. Negative lookups (unknown site) are
// cached too, so a flood of bogus site ids can't hammer D1.
// ---------------------------------------------------------------------------

type SiteInfo = { allowlist: string[]; domain: string };

const SITE_CACHE_TTL_MS = 60_000;
const siteCache = new Map<string, { site: SiteInfo | null; at: number }>();

let saltMemo: { day: string; salt: string } | null = null;

/**
 * Fetch the per-site origin allowlist + domain from D1 in one query.
 *
 * Fix #6a (MED): merged the two former D1 lookups (origin_allowlist fetch +
 * existence check) into a single SELECT. Also carries `domain` (Task 4) so the
 * referrer self-referral filter needs no second read. Returns null when the
 * site does not exist.
 */
async function getSiteAllowlist(env: Env, siteId: string): Promise<SiteInfo | null> {
  const cached = siteCache.get(siteId);
  const now = Date.now();
  if (cached && now - cached.at < SITE_CACHE_TTL_MS) {
    return cached.site;
  }

  const row = await env.DB.prepare("SELECT origin_allowlist, domain FROM sites WHERE id = ?")
    .bind(siteId)
    .first<{ origin_allowlist: string | null; domain: string | null }>();

  // null row → site does not exist
  const site =
    row === null
      ? null
      : {
          allowlist: row.origin_allowlist
            ? row.origin_allowlist
                .split(",")
                .map((o) => o.trim())
                .filter(Boolean)
            : [],
          domain: row.domain ?? "",
        };

  siteCache.set(siteId, { site, at: now });
  return site;
}

/** Day-keyed memo over {@link getDailySalt}: one KV `get` per day, per isolate. */
async function getCachedDailySalt(env: Env, day: string): Promise<string> {
  if (saltMemo && saltMemo.day === day) return saltMemo.salt;
  const salt = await getDailySalt(env.SALT, day);
  saltMemo = { day, salt };
  return salt;
}

/** Lowercase and strip one leading "www." for host-vs-host comparison. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
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

const MAX_CONTENT_LENGTH_BYTES = 4096; // fast pre-parse rejection on the raw header
const MAX_BODY_BYTES = 2048; // 2 KB payload cap (spec §3.2), measured in UTF-8 bytes
const MAX_PROPS_JSON_BYTES = 512; // cap on serialized custom-event props
const MAX_PATH_CHARS = 512; // bound `p` before it becomes a rollup dim_value
const MAX_REFERRER_CHARS = 1024; // bound `r` before host parsing
const MAX_EVENT_NAME_CHARS = 128; // bound `n` before it becomes a rollup dim_value
const MAX_SCREEN_WIDTH = 32767; // `w` outside (0, 32767] or non-finite is dropped, not stored

// ---------------------------------------------------------------------------
// Task 8: bound what a stranger can put in a beacon
//
// Every client-supplied string is truncated (never dropped — an oversized
// field is still a real event) and `w` is type/range-checked so a malformed
// value can never reach `Number()` as NaN in the WAE data point.
// ---------------------------------------------------------------------------

/** Truncate a client-supplied string to bound the storage/rollup row it becomes. */
function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/** `w` must be a finite, in-range number, or it's omitted entirely (no NaN reaches WAE). */
function validScreenWidth(w: unknown): number | undefined {
  return typeof w === "number" && Number.isFinite(w) && w > 0 && w <= MAX_SCREEN_WIDTH
    ? w
    : undefined;
}

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
  if (contentLength > MAX_CONTENT_LENGTH_BYTES) {
    return new Response(null, { status: 413, headers: origin ? corsHeaders(origin) : {} });
  }

  // ---------- 2. Parse body ----------
  let beacon: Beacon;
  try {
    const text = await request.text();
    // Byte length, not `.length` (UTF-16 code units) — a 2048-char CJK body is
    // ~6 KB on the wire and must not sail past a code-unit-based cap.
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
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

  // ---------- 3b. Bound client-supplied fields (truncate, don't drop; Task 8) ----------
  const isEvent = beacon.t === "event";
  const pathname = truncate(beacon.p, MAX_PATH_CHARS);
  const referrerRaw =
    typeof beacon.r === "string" ? truncate(beacon.r, MAX_REFERRER_CHARS) : undefined;
  const screenWidth = validScreenWidth(beacon.w);
  // `n`/`d` only apply to real events — a hand-crafted pv beacon must not be
  // able to inject a row into the events breakdown.
  const eventName = isEvent ? truncate(beacon.n ?? "", MAX_EVENT_NAME_CHARS) : "";

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

  // ---------- 6-14. Site lookup onward (fix #6c: never let infra failures 5xx) ----------
  // A transient D1/KV/crypto error here must not propagate to Hono's default
  // 500 — that response carries no CORS headers, so a customer's browser
  // console fills with CORS errors instead of a clean, silent drop. The
  // deliberate non-204 responses below (404 unknown site, 403 origin, 503
  // missing secret) are `return`s, not throws, so they keep working as-is.
  try {
    // ---------- 6. D1: single lookup for site existence + allowlist + domain (fix #6a: merged queries) ----------
    const site = await getSiteAllowlist(env, siteId);

    // null = site does not exist
    if (site === null) {
      return new Response(null, { status: 404, headers: origin ? corsHeaders(origin) : {} });
    }

    // ---------- 7. CORS: validate origin against per-site allowlist ----------
    // Fix #2 (HIGH): if the site has a non-empty allowlist, requests with NO Origin
    // header are also rejected — a headerless POST would bypass the allowlist entirely.
    // Only open sites (empty allowlist) accept headerless requests.
    if (site.allowlist.length > 0) {
      if (!origin || !site.allowlist.includes(origin)) {
        return new Response(null, { status: 403, headers: origin ? corsHeaders(origin) : {} });
      }
    }

    // ---------- 8. Secret guard (fail-closed before any crypto) ----------
    try {
      requireSecrets(env, ["IDENTITY_HMAC_SECRET"]);
    } catch (err) {
      if (err instanceof SecretsMissingError) {
        return new Response("collector not configured", {
          status: 503,
          headers: origin ? corsHeaders(origin) : {},
        });
      }
      throw err;
    }

    // ---------- 9. Cookieless identity ----------
    const ip =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For") ??
      "0.0.0.0";
    const today = utcDay(new Date());
    const salt = await getCachedDailySalt(env, today);
    const vid = await deriveVid(env.IDENTITY_HMAC_SECRET, salt, ip, ua, siteId);

    // ---------- 10. Parse client-supplied fields ----------
    // Task 4: internal navigations must not credit the site as its own referrer
    // — normalize both sides (lowercase, strip one leading "www.") and collapse
    // a same-domain match to "" (direct), same as no `r` at all. Sites with the
    // default empty `domain` skip this (no behavior change).
    const rawReferrerHost = parseReferrerHost(referrerRaw);
    const referrerHost =
      site.domain &&
      rawReferrerHost &&
      normalizeHost(rawReferrerHost) === normalizeHost(site.domain)
        ? ""
        : rawReferrerHost;
    const utm = parseUtm(pathname);

    // Prefer UA-derived device class; fall back to screen-width bucket when UA says desktop
    // (some mobile browsers identify as desktop — the screen width is the tiebreaker)
    const deviceClass =
      uaInfo.deviceClass !== "desktop" ? uaInfo.deviceClass : bucketScreenWidth(screenWidth);

    // Serialize custom-event props (cap at MAX_PROPS_JSON_BYTES); `d` only
    // applies to real events (Task 8) — same reasoning as `eventName` above.
    let propsJson = "";
    if (isEvent && beacon.d && Object.keys(beacon.d).length > 0) {
      const raw = JSON.stringify(beacon.d);
      propsJson = raw.length <= MAX_PROPS_JSON_BYTES ? raw : "";
    }

    // ---------- 11. Build WAE event ----------
    const isPageview = beacon.t === "pv" ? 1 : 0;
    const waeEvent: WaeEvent = {
      siteId,
      vid,
      pathname,
      referrerHost,
      utmSource: utm.source,
      utmMedium: utm.medium,
      utmCampaign: utm.campaign,
      country: cf.country,
      deviceClass,
      browser: uaInfo.browser,
      os: uaInfo.os,
      eventName,
      entryPath: pathname, // MVP: entry path = current path (no session tracking)
      propsJson,
      count: 1,
      isPageview: isPageview as 0 | 1,
      screenWidth: screenWidth ?? 0,
    };

    // ---------- 12. Write to WAE (synchronous) ----------
    env.WAE.writeDataPoint(toDataPoint(waeEvent));

    // ---------- 13. Bump SiteLive DO (async, non-blocking) ----------
    // One DO call per event drives BOTH the live count and the dimensional rollup
    // (spec §3). The DO reads a JSON body — query-string params are not used.
    const doId = env.SITE_LIVE.idFromName(siteId);
    const doStub = env.SITE_LIVE.get(doId);
    const eventBody = JSON.stringify({
      siteId,
      vid,
      isPageview,
      path: pathname,
      referrer: referrerHost,
      utmSource: utm.source,
      utmMedium: utm.medium,
      utmCampaign: utm.campaign,
      country: cf.country,
      device: deviceClass,
      browser: uaInfo.browser,
      os: uaInfo.os,
      eventName,
    });
    ctx.waitUntil(
      doStub
        .fetch(
          new Request("https://do-internal/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: eventBody,
          }),
        )
        .catch(() => {
          // DO is best-effort; WAE already holds the durable copy.
        }),
    );

    // ---------- 14. Respond 204 ----------
    return new Response(null, {
      status: 204,
      headers: origin ? corsHeaders(origin) : {},
    });
  } catch (err) {
    // Cold-schema consequence: on a fresh deploy that has never served a
    // dashboard request, `sites` doesn't exist yet and getSiteAllowlist throws
    // "no such table" — it lands here and is silently dropped as 204 (was a
    // 500). Acceptable until the dashboard's ensureSchema runs; do NOT add a
    // per-request ensureSchema call to this hot path to "fix" it.
    console.error("collector error", err);
    return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} });
  }
}

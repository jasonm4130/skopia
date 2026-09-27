/**
 * Skopia — collector (the ingestion hot path).
 *
 * Routed at `OPTIONS /e` (CORS preflight) and `POST /e` (beacon). Pipeline per
 * the spec §3: CORS allowlist -> validate -> bot drop -> enrich -> 204, then in
 * one waitUntil task (ADR-0013 §5): cookieless identity -> `WAE.writeDataPoint`
 * -> bump SiteLive DO.
 */

import type { SiteLive } from "../dashboard/site-live";
import {
  bucketScreenWidth,
  enrichFromCf,
  isBot,
  parseReferrerHost,
  parseUserAgent,
  parseUtm,
} from "../shared/cf";
import { requireSecrets, SecretsMissingError } from "../shared/config";
import { deriveVid, utcDay } from "../shared/identity";
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
// Every beacon paid an uncached D1 site lookup and a salt read, both constant
// per isolate (site config) or per (site, day) (salt). A module-level cache
// bounds each to one read per TTL window, per isolate. Consequence: an
// allowlist/domain edit takes effect within <=60s on any given isolate —
// acceptable for the collector hot path. Negative lookups (unknown site) are
// cached too, so a flood of bogus site ids can't hammer D1.
// ---------------------------------------------------------------------------

type SiteInfo = { allowlist: string[]; domain: string };

const SITE_CACHE_TTL_MS = 60_000;
const SITE_CACHE_MAX = 1024;
const siteCache = new Map<string, { site: SiteInfo | null; at: number }>();

/**
 * Per-site salt memo (ADR-0013 §2): siteId -> that site's salt for `day`.
 * Bounded like siteCache, and emptied of other days whenever the day changes so
 * yesterday's salt doesn't outlive its day in isolate RAM. Only sites that
 * passed the D1 existence + origin checks reach it.
 */
const saltMemo = new Map<string, { day: string; salt: Promise<string> }>();
let saltMemoDay: string | null = null;

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

  // Bound the cache: distinct bogus site ids on this open endpoint must not
  // grow the isolate heap without limit. A full reset beats LRU bookkeeping at
  // this size — worst case is one extra D1 read per real site after a flood.
  if (siteCache.size >= SITE_CACHE_MAX && !siteCache.has(siteId)) {
    siteCache.clear();
  }
  siteCache.set(siteId, { site, at: now });
  return site;
}

/** getSalt budget: past it the beacon takes the failure path (ADR-0013 §4). */
const SALT_TIMEOUT_MS = 5_000;

/** The site's `SiteLive` DO, typed for RPC. */
function siteLiveStub(env: Env, siteId: string): DurableObjectStub<SiteLive> {
  return env.SITE_LIVE.get(env.SITE_LIVE.idFromName(siteId)) as DurableObjectStub<SiteLive>;
}

/** One `getSalt` RPC to the site's DO per (site, day), per isolate (ADR-0013 §2). */
function getCachedSalt(env: Env, siteId: string, day: string): Promise<string> {
  if (day !== saltMemoDay) {
    for (const [id, entry] of saltMemo) {
      if (entry.day !== day) saltMemo.delete(id);
    }
    saltMemoDay = day;
  }
  const hit = saltMemo.get(siteId);
  if (hit && hit.day === day) return hit.salt;

  // Miss rate is the R3 metric (DO requests ≈ events + misses on Free).
  console.log("collector: salt memo miss", { siteId, day });
  // Memoize the in-flight promise: concurrent beacons on a cold isolate share
  // one RPC. A failed fetch is evicted so the next beacon retries.
  const salt = fetchSalt(env, siteId, day);
  if (saltMemo.size >= SITE_CACHE_MAX && !saltMemo.has(siteId)) saltMemo.clear();
  saltMemo.set(siteId, { day, salt });
  salt.catch(() => {
    if (saltMemo.get(siteId)?.salt === salt) saltMemo.delete(siteId);
  });
  return salt;
}

/**
 * One `getSalt` RPC raced against SALT_TIMEOUT_MS, so a stalled call fails
 * inside the waitUntil budget instead of being cancelled with the WAE point. A
 * `.retryable` error is retried once on a fresh stub (getSalt is idempotent);
 * `.overloaded` never is (Cloudflare DO error-handling guidance).
 */
async function fetchSalt(env: Env, siteId: string, day: string): Promise<string> {
  const attempt = async (): Promise<string> => {
    try {
      return await siteLiveStub(env, siteId).getSalt(day);
    } catch (err) {
      const e = err as { retryable?: boolean; overloaded?: boolean } | null;
      if (e?.retryable === true && e.overloaded !== true) {
        return siteLiveStub(env, siteId).getSalt(day);
      }
      throw err;
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`getSalt timed out after ${SALT_TIMEOUT_MS} ms`)),
      SALT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([attempt(), timeout]);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Strip the query string from `beacon.p` for anything that gets stored or
 * rolled up (blob2, blob12, DO `path`). `p` is `location.pathname + location.search`
 * (privacy: the query is needed for UTM parsing but must never be persisted as
 * the page path — it can carry PII). Falls back to the input unchanged if it
 * doesn't parse as a path.
 */
function stripQuery(pathWithQuery: string): string {
  try {
    return new URL(pathWithQuery, "https://skopia.invalid").pathname;
  } catch {
    return pathWithQuery;
  }
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
    const parsed: unknown = JSON.parse(text);
    // `JSON.parse` accepts `null`, arrays, and primitives too — none of those
    // are a valid beacon, and reading `.s` off them below would throw outside
    // this try, escaping as Hono's default 500 (no CORS headers).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return new Response(null, { status: 400, headers: origin ? corsHeaders(origin) : {} });
    }
    beacon = parsed as Beacon;
  } catch {
    return new Response(null, { status: 400, headers: origin ? corsHeaders(origin) : {} });
  }

  // ---------- 3. Validate beacon shape ----------
  const siteId = beacon.s;
  if (
    !siteId ||
    typeof siteId !== "string" ||
    siteId.length > 64 ||
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
  // `pathname` keeps the query string (UTM parsing needs it); `path` is the
  // stored/rolled-up value — query-string-free, since query strings can carry
  // PII (session ids, emails, tokens) and must never land in WAE or the DO.
  const pathname = truncate(beacon.p, MAX_PATH_CHARS);
  const path = truncate(stripQuery(pathname), MAX_PATH_CHARS);
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

    // ---------- 9. Cookieless identity inputs ----------
    const ip =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For") ??
      "0.0.0.0";
    // The one designated event day (ADR-0013 §1a): computed once at receipt and
    // used for the salt, the WAE blob14 and the DO rollup bucket alike.
    const day = utcDay(new Date());

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

    // ---------- 11. Build WAE event (vid filled in by step 12) ----------
    const isPageview = beacon.t === "pv" ? 1 : 0;
    const waeEvent: WaeEvent = {
      siteId,
      vid: "",
      pathname: path,
      referrerHost,
      utmSource: utm.source,
      utmMedium: utm.medium,
      utmCampaign: utm.campaign,
      country: cf.country,
      deviceClass,
      browser: uaInfo.browser,
      os: uaInfo.os,
      eventName,
      entryPath: path, // MVP: entry path = current path (no session tracking)
      propsJson,
      eventDay: day,
      count: 1,
      isPageview: isPageview as 0 | 1,
      screenWidth: screenWidth ?? 0,
    };

    // ---------- 12-13. Salt -> vid -> WAE -> SiteLive DO, after the 204 ----------
    // ADR-0013 §5: the first salt fetch per isolate is a cross-colo DO round
    // trip, so all identity work runs in one waitUntil task. The 204 never meant
    // "written". The task catches on its own — it runs outside this try/catch.
    ctx.waitUntil(
      (async () => {
        let salt: string;
        try {
          salt = await getCachedSalt(env, siteId, day);
        } catch (err) {
          // ADR-0013 §4: never fall back to another salt. Keep the raw event in
          // WAE with an empty vid (pageviews stay recomputable; a visitor
          // recompute must exclude blob1 = '') and skip the DO, whose `seen`
          // set needs a real vid.
          console.error("collector: salt fetch failed", err);
          env.WAE.writeDataPoint(toDataPoint(waeEvent));
          return;
        }
        const vid = await deriveVid(env.IDENTITY_HMAC_SECRET, salt, ip, ua, siteId);
        waeEvent.vid = vid;
        env.WAE.writeDataPoint(toDataPoint(waeEvent));

        // One DO call per event drives BOTH the live count and the dimensional
        // rollup (spec §3). The DO reads a JSON body — query-string params are
        // not used.
        const eventBody = JSON.stringify({
          siteId,
          day,
          vid,
          isPageview,
          path,
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
        await siteLiveStub(env, siteId)
          .fetch(
            new Request("https://do-internal/event", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: eventBody,
            }),
          )
          .catch(() => {
            // Bounded, accepted loss (ADR-0011): the cron reconciler is retired,
            // so a dropped DO delivery is no longer self-healed automatically.
            // WAE still retains the raw events, so any affected day can be
            // recomputed manually from WAE if a parity spot-check ever shows loss.
          });
      })().catch((err) => {
        console.error("collector: identity task failed", err);
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

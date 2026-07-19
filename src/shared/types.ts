/**
 * Skopia — shared types (foundation-owned, FINAL).
 *
 * This module is the contract every feature agent codes against. The WAE slot
 * mapping, D1 row shapes, dashboard view-models, and the `Env` binding interface
 * are the single source of truth. Source: docs/specs/2026-06-21-technical-spec.md.
 */

// ---------------------------------------------------------------------------
// Bindings & environment (wrangler.jsonc + secrets)
// ---------------------------------------------------------------------------

/** The Durable Object namespace for the per-site live-visitor object. */
export type SiteLiveNamespace = DurableObjectNamespace;

/**
 * The Worker environment: every binding declared in wrangler.jsonc plus the
 * secrets set out-of-band. Feature agents import this; they do not redeclare it.
 */
export interface Env {
  /** Raw event ingest. Index = site_id, 1 data point per event (spec §4.1). */
  WAE: AnalyticsEngineDataset;
  /** Relational metadata + exact daily rollups (spec §4.2). */
  DB: D1Database;
  /** Dashboard response cache, 60-120 s TTL (spec §5.3). */
  CACHE: KVNamespace;
  /** Rotating daily salt for the cookieless visitor hash (spec §4 / §5.3). */
  SALT: KVNamespace;
  /** Per-site live-visitor Durable Object, one instance per site (spec §6). */
  SITE_LIVE: SiteLiveNamespace;

  // ---- vars (wrangler.jsonc `vars`) ----
  /** Event retention horizon in days. Default "90" (WAE hard cap, spec §4). */
  RETENTION_DAYS: string;

  // ---- secrets (never committed; `wrangler secret put`) ----
  /** HMAC key for the cookieless daily visitor hash (spec §3.5). */
  IDENTITY_HMAC_SECRET: string;
  /** HMAC key for the signed-session auth cookie (spec §7.2). */
  AUTH_COOKIE_SECRET: string;
  /** Cloudflare account id, for the WAE SQL HTTP API (spec §5.2). */
  CF_ACCOUNT_ID: string;
  /** Bearer token (Account Analytics Read) for the WAE SQL HTTP API. */
  WAE_API_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Beacon (client -> collector wire format)
// ---------------------------------------------------------------------------

/**
 * The flat JSON body the tracking script POSTs to `/e`. Kept terse to defend the
 * <2 KB script budget (spec §2). `t` (type) is the extensibility hook: new event
 * kinds (outbound link, file download, scroll, web-vitals) are new `t` values on
 * the same transport and schema (spec §2 / §10).
 */
export type BeaconType = "pv" | "event";

export interface Beacon {
  /** Event type. "pv" = pageview, "event" = custom/named event. */
  t: BeaconType;
  /** site_id (the WAE index). */
  s: string;
  /** location.pathname. */
  p: string;
  /** document.referrer (full URL; collector parses the host server-side). */
  r?: string;
  /** document.title (page identity for top-pages). */
  ti?: string;
  /** screen.width (collector buckets server-side). */
  w?: number;
  /** Custom-event name (required when t === "event"). */
  n?: string;
  /** Small custom-event props bag (capped; serialized into WAE blob13). */
  d?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// WAE data-point schema (collector -> WAE)  — spec §4.1
// ---------------------------------------------------------------------------

/**
 * The exact WAE slot mapping for one event. ONE `writeDataPoint` per event.
 * Limits honored: 1 index (≤96 B), ≤20 blobs (≤16 KB total), ≤20 doubles.
 *
 * This interface is the human-readable view of the data point; serialize it with
 * {@link toDataPoint} when writing.
 */
export interface WaeEvent {
  /** index1 — site_id (the partition key; never a per-visitor id). */
  siteId: string;

  // ---- blobs (strings) ----
  /** blob1 — 16-hex cookieless daily visitor hash. */
  vid: string;
  /** blob2 — normalized page path (top pages). */
  pathname: string;
  /** blob3 — parsed referrer hostname (sources). '' when none. */
  referrerHost: string;
  /** blob4 — utm_source. */
  utmSource: string;
  /** blob5 — utm_medium. */
  utmMedium: string;
  /** blob6 — utm_campaign. */
  utmCampaign: string;
  /** blob7 — request.cf.country (geo). */
  country: string;
  /** blob8 — device class: 'mobile' | 'tablet' | 'desktop'. */
  deviceClass: DeviceClass;
  /** blob9 — browser family (from UA). */
  browser: string;
  /** blob10 — OS family (from UA). */
  os: string;
  /** blob11 — event name; '' for a pageview. */
  eventName: string;
  /** blob12 — entry path (future funnels/landing). */
  entryPath: string;
  /** blob13 — small JSON of custom-event props (capped). '' when none. */
  propsJson: string;

  // ---- doubles (numbers) ----
  /** double1 — event count, always 1 (SUM(_sample_interval*double1)=events). */
  count: 1;
  /** double2 — is_pageview: 1 for pageview, 0 for custom event. */
  isPageview: 0 | 1;
  /** double3 — screen width (viewport bucket input). */
  screenWidth: number;
}

/** Device class derived server-side from the User-Agent (spec §3.4). */
export type DeviceClass = "mobile" | "tablet" | "desktop";

/**
 * Ordered blob slot names, blob1..blob13. The index in this array + 1 is the WAE
 * `blobN` slot. Slots 14..20 are reserved (web-vitals, outbound target, etc.).
 */
export const WAE_BLOB_SLOTS = [
  "vid",
  "pathname",
  "referrerHost",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "country",
  "deviceClass",
  "browser",
  "os",
  "eventName",
  "entryPath",
  "propsJson",
] as const satisfies readonly (keyof WaeEvent)[];

/**
 * Ordered double slot names, double1..double3. The index + 1 is the WAE `doubleN`
 * slot. Slots 4..20 are reserved (CWV values, scroll %, revenue).
 */
export const WAE_DOUBLE_SLOTS = [
  "count",
  "isPageview",
  "screenWidth",
] as const satisfies readonly (keyof WaeEvent)[];

/**
 * The shape `AnalyticsEngineDataset.writeDataPoint` accepts. Foundation owns the
 * serializer ({@link toDataPoint}); the collector agent calls it.
 */
export interface WaeDataPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

// ---------------------------------------------------------------------------
// D1 row types  — spec §4.2 / migrations/0001_init.sql
// ---------------------------------------------------------------------------

export interface SiteRow {
  id: string;
  name: string;
  domain: string;
  origin_allowlist: string;
  public_token: string | null;
  created_at: number;
}

export interface UserRow {
  id: number;
  email: string;
  pw_hash: string;
  role: string;
  created_at: number;
}

export interface GoalRow {
  id: number;
  site_id: string;
  name: string;
  match_type: GoalMatchType;
  match_value: string;
  created_at: number;
}

export type GoalMatchType = "event" | "path" | "path_prefix";

/** The dimensions stored in `rollup_daily.dimension`. */
export type RollupDimension =
  | "total"
  | "page"
  | "referrer"
  | "utm_source"
  | "utm_medium"
  | "utm_campaign"
  | "country"
  | "device"
  | "browser"
  | "os"
  | "event";

// ---------------------------------------------------------------------------
// Dashboard view-models  — what src/db/queries.ts returns and the SSR renders
// ---------------------------------------------------------------------------

/** A relative or absolute window selected in the date-range picker. */
export interface DateRange {
  /** Inclusive UTC start, 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive UTC end, 'YYYY-MM-DD'. */
  to: string;
}

/** One point on the pageviews/visitors time-series chart. */
export interface TimeSeriesPoint {
  /** UTC 'YYYY-MM-DD'. */
  day: string;
  pageviews: number;
  visitors: number;
  /** True if any contributing rollup row was sampled (drives the "~est" badge). */
  sampled: boolean;
}

/** One row in a "top N" breakdown table (pages, sources, countries, …). */
export interface BreakdownRow {
  /** The dimension bucket value (path, referrer host, country code, …). */
  label: string;
  pageviews: number;
  visitors: number;
  /** Share of the window total, 0..1 (UI renders the bar). */
  share: number;
  sampled: boolean;
}

/** The four headline stat cards (spec / design dashboard Overview). */
export interface StatCards {
  pageviews: number;
  visitors: number;
  /** Pageviews per visitor, rounded to 1 dp. */
  viewsPerVisitor: number;
  /** Share of single-event visitors, 0..1 (bounce proxy). */
  bounceRate: number;
  /** True if any card value was computed from sampled data. */
  sampled: boolean;
}

/** The live-visitor snapshot pushed by the SiteLive DO (spec §6). */
export interface LiveSnapshot {
  /** Distinct visitors active in the last 5 minutes. */
  visitors: number;
  /** Top active pages right now (path -> active visitor count). */
  topPages: BreakdownRow[];
}

/** The full Overview-page view-model the dashboard SSR renders in one pass. */
export interface OverviewView {
  site: SiteRow;
  range: DateRange;
  cards: StatCards;
  series: TimeSeriesPoint[];
  topPages: BreakdownRow[];
  topSources: BreakdownRow[];
  topCountries: BreakdownRow[];
  /** True if any panel on the page is showing sampled (estimated) data. */
  sampled: boolean;
}

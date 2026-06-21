/**
 * Stratus — D1 read layer (foundation-owned signatures, FINAL).
 *
 * Every read the dashboard needs, returning the view-model types from
 * shared/types.ts. The BACKBONE agent implements these against the
 * `rollup_daily` / `sites` / `users` / `goals` tables; the DASHBOARD agent
 * imports them. Signatures are final — implement the bodies, do not change them.
 *
 * All counts come pre-corrected from the cron rollup, so these functions just
 * read D1; no sampling math happens here (it happened at rollup time, spec §5.1).
 * Each function returning analytics surfaces a `sampled` flag sourced from
 * `rollup_daily.sampled`. Stubs throw until implemented.
 */

import type {
  BreakdownRow,
  DateRange,
  GoalRow,
  OverviewView,
  RollupDimension,
  SiteRow,
  StatCards,
  TimeSeriesPoint,
  UserRow,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Site / user / goal metadata
// ---------------------------------------------------------------------------

/** Every site tracked by this deployment. */
export async function listSites(db: D1Database): Promise<SiteRow[]> {
  void db;
  throw new Error("not implemented");
}

/** A single site by id, or null if it does not exist. */
export async function getSite(db: D1Database, siteId: string): Promise<SiteRow | null> {
  void db, void siteId;
  throw new Error("not implemented");
}

/** A single site by its public share token, or null (spec §7.1). */
export async function getSiteByPublicToken(
  db: D1Database,
  token: string,
): Promise<SiteRow | null> {
  void db, void token;
  throw new Error("not implemented");
}

/** The owner user (single-owner MVP), or null before first-run setup. */
export async function getOwner(db: D1Database): Promise<UserRow | null> {
  void db;
  throw new Error("not implemented");
}

/** Goal definitions for a site (spec §4.2). */
export async function listGoals(db: D1Database, siteId: string): Promise<GoalRow[]> {
  void db, void siteId;
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Stat cards & time-series
// ---------------------------------------------------------------------------

/** The four headline stat cards for a site over a window. */
export async function getStatCards(
  db: D1Database,
  siteId: string,
  range: DateRange,
): Promise<StatCards> {
  void db, void siteId, void range;
  throw new Error("not implemented");
}

/** Daily pageviews/visitors time-series for a site over a window. */
export async function getTimeSeries(
  db: D1Database,
  siteId: string,
  range: DateRange,
): Promise<TimeSeriesPoint[]> {
  void db, void siteId, void range;
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Breakdown ("top N") tables
// ---------------------------------------------------------------------------

/**
 * Generic top-N breakdown for one dimension over a window, ordered by pageviews.
 * The dimension-specific helpers below delegate to this.
 */
export async function getBreakdown(
  db: D1Database,
  siteId: string,
  range: DateRange,
  dimension: RollupDimension,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void dimension, void limit;
  throw new Error("not implemented");
}

/** Top pages by pageviews (dimension = "page"). */
export async function getTopPages(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** Top referrer sources (dimension = "referrer"). */
export async function getTopSources(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** Top countries (dimension = "country"). */
export async function getTopCountries(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** Device-class breakdown (dimension = "device"). */
export async function getTopDevices(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** Browser breakdown (dimension = "browser"). */
export async function getTopBrowsers(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** OS breakdown (dimension = "os"). */
export async function getTopOperatingSystems(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** UTM-source breakdown (dimension = "utm_source"). */
export async function getTopUtmSources(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

/** Custom-event breakdown by event name (dimension = "event"). */
export async function getTopEvents(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  void db, void siteId, void range, void limit;
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Composed page view-model & realtime
// ---------------------------------------------------------------------------

/**
 * The full Overview page in one call: site + cards + series + the three default
 * top-lists. Composes the helpers above so the SSR route reads it in one await.
 */
export async function getOverview(
  db: D1Database,
  siteId: string,
  range: DateRange,
): Promise<OverviewView | null> {
  void db, void siteId, void range;
  throw new Error("not implemented");
}

/**
 * Realtime visitor count for a site. The authoritative live count comes from the
 * SiteLive DO over WebSocket (spec §6); this D1-backed helper is the
 * initial-render / no-WS fallback, derived from the most recent rollup bucket.
 */
export async function getRealtimeCount(db: D1Database, siteId: string): Promise<number> {
  void db, void siteId;
  throw new Error("not implemented");
}

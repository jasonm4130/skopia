/**
 * Skopia — D1 read layer (foundation-owned signatures, FINAL).
 *
 * Every read the dashboard needs, returning the view-model types from
 * shared/types.ts. Signatures are final — only bodies are implemented here.
 *
 * All counts come pre-corrected from the cron rollup, so these functions just
 * read D1; no sampling math happens here (it happened at rollup time, spec §5.1).
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
  const result = await db.prepare("SELECT * FROM sites ORDER BY created_at").all<SiteRow>();
  return result.results ?? [];
}

/** A single site by id, or null if it does not exist. */
export async function getSite(db: D1Database, siteId: string): Promise<SiteRow | null> {
  return db.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
}

/** A single site by its public share token, or null (spec §7.1). */
export async function getSiteByPublicToken(db: D1Database, token: string): Promise<SiteRow | null> {
  return db.prepare("SELECT * FROM sites WHERE public_token = ?").bind(token).first<SiteRow>();
}

/** The owner user (single-owner MVP), or null before first-run setup. */
export async function getOwner(db: D1Database): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE role = 'owner' LIMIT 1").first<UserRow>();
}

/** Goal definitions for a site (spec §4.2). */
export async function listGoals(db: D1Database, siteId: string): Promise<GoalRow[]> {
  const result = await db
    .prepare("SELECT * FROM goals WHERE site_id = ? ORDER BY id")
    .bind(siteId)
    .all<GoalRow>();
  return result.results ?? [];
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
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(pageviews), 0) AS pageviews,
         COALESCE(SUM(visitors), 0) AS visitors,
         MAX(sampled) AS sampled
       FROM rollup_daily
       WHERE site_id = ? AND dimension = 'total' AND day >= ? AND day <= ?`,
    )
    .bind(siteId, range.from, range.to)
    .first<{ pageviews: number; visitors: number; sampled: number }>();

  const pageviews = Number(row?.pageviews ?? 0);
  const visitors = Number(row?.visitors ?? 0);
  const sampled = (row?.sampled ?? 0) === 1;

  // Bounce rate proxy: % of sessions with a single pageview.
  // We approximate using the total visitors who had exactly one pageview event.
  // Since D1 rollups don't store per-session detail, we approximate:
  // bounce_rate = 1 - (pageviews - visitors) / visitors  when pv >= visitors
  // i.e. (visitors with >1 PV) / visitors. If pv = visitors, all bounced.
  const viewsPerVisitor = visitors > 0 ? Math.round((pageviews / visitors) * 10) / 10 : 0;
  const bounceRate = visitors > 0 ? Math.max(0, 1 - (pageviews - visitors) / visitors) : 0;

  return {
    pageviews,
    visitors,
    viewsPerVisitor,
    bounceRate: Math.min(1, bounceRate),
    sampled,
  };
}

/** Daily pageviews/visitors time-series for a site over a window. */
export async function getTimeSeries(
  db: D1Database,
  siteId: string,
  range: DateRange,
): Promise<TimeSeriesPoint[]> {
  const result = await db
    .prepare(
      `SELECT day,
              COALESCE(SUM(pageviews), 0) AS pageviews,
              COALESCE(SUM(visitors), 0) AS visitors,
              MAX(sampled) AS sampled
       FROM rollup_daily
       WHERE site_id = ? AND dimension = 'total' AND day >= ? AND day <= ?
       GROUP BY day
       ORDER BY day`,
    )
    .bind(siteId, range.from, range.to)
    .all<{ day: string; pageviews: number; visitors: number; sampled: number }>();

  return (result.results ?? []).map((r) => ({
    day: r.day,
    pageviews: Number(r.pageviews),
    visitors: Number(r.visitors),
    sampled: r.sampled === 1,
  }));
}

// ---------------------------------------------------------------------------
// Breakdown ("top N") tables
// ---------------------------------------------------------------------------

/**
 * Generic top-N breakdown for one dimension over a window, ordered by pageviews.
 */
export async function getBreakdown(
  db: D1Database,
  siteId: string,
  range: DateRange,
  dimension: RollupDimension,
  limit: number,
): Promise<BreakdownRow[]> {
  // Get the total pageviews for the window (for share calculation)
  const totalRow = await db
    .prepare(
      `SELECT COALESCE(SUM(pageviews), 0) AS total
       FROM rollup_daily
       WHERE site_id = ? AND dimension = 'total' AND day >= ? AND day <= ?`,
    )
    .bind(siteId, range.from, range.to)
    .first<{ total: number }>();
  const totalPageviews = Number(totalRow?.total ?? 0);

  const result = await db
    .prepare(
      `SELECT dim_value,
              SUM(pageviews) AS pageviews,
              SUM(visitors) AS visitors,
              MAX(sampled) AS sampled
       FROM rollup_daily
       WHERE site_id = ? AND dimension = ? AND day >= ? AND day <= ?
       GROUP BY dim_value
       ORDER BY pageviews DESC
       LIMIT ?`,
    )
    .bind(siteId, dimension, range.from, range.to, limit)
    .all<{ dim_value: string; pageviews: number; visitors: number; sampled: number }>();

  return (result.results ?? []).map((r) => ({
    label: r.dim_value,
    pageviews: Number(r.pageviews),
    visitors: Number(r.visitors),
    share: totalPageviews > 0 ? Number(r.pageviews) / totalPageviews : 0,
    sampled: r.sampled === 1,
  }));
}

/** Top pages by pageviews (dimension = "page"). */
export async function getTopPages(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "page", limit);
}

/** Top referrer sources (dimension = "referrer"). */
export async function getTopSources(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "referrer", limit);
}

/** Top countries (dimension = "country"). */
export async function getTopCountries(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "country", limit);
}

/** Device-class breakdown (dimension = "device"). */
export async function getTopDevices(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "device", limit);
}

/** Browser breakdown (dimension = "browser"). */
export async function getTopBrowsers(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "browser", limit);
}

/** OS breakdown (dimension = "os"). */
export async function getTopOperatingSystems(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "os", limit);
}

/** UTM-source breakdown (dimension = "utm_source"). */
export async function getTopUtmSources(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "utm_source", limit);
}

/** Custom-event breakdown by event name (dimension = "event"). */
export async function getTopEvents(
  db: D1Database,
  siteId: string,
  range: DateRange,
  limit: number,
): Promise<BreakdownRow[]> {
  return getBreakdown(db, siteId, range, "event", limit);
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
  const site = await getSite(db, siteId);
  if (!site) return null;

  const [cards, series, topPages, topSources, topCountries] = await Promise.all([
    getStatCards(db, siteId, range),
    getTimeSeries(db, siteId, range),
    getTopPages(db, siteId, range, 10),
    getTopSources(db, siteId, range, 10),
    getTopCountries(db, siteId, range, 10),
  ]);

  const sampled =
    cards.sampled ||
    series.some((p) => p.sampled) ||
    topPages.some((r) => r.sampled) ||
    topSources.some((r) => r.sampled) ||
    topCountries.some((r) => r.sampled);

  return { site, range, cards, series, topPages, topSources, topCountries, sampled };
}

/**
 * Realtime visitor count fallback from D1 (most recent day's total visitors).
 * The authoritative live count comes from the SiteLive DO over WebSocket (spec §6).
 */
export async function getRealtimeCount(db: D1Database, siteId: string): Promise<number> {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;

  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(visitors), 0) AS visitors
       FROM rollup_daily
       WHERE site_id = ? AND dimension = 'total' AND day = ?`,
    )
    .bind(siteId, day)
    .first<{ visitors: number }>();
  return Number(row?.visitors ?? 0);
}

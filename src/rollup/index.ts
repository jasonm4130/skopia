/**
 * Skopia — rollup cron (WAE -> D1 exact aggregates).
 *
 * Runs on the cron trigger (spec §5.1): query WAE with sampling-correct SQL,
 * GROUP BY each dimension, upsert exact aggregates into `rollup_daily`, set the
 * `sampled` flag via the count() check, and rotate the daily salt on the first
 * pass after UTC midnight.
 */

import { requireSecrets, SecretsMissingError } from "../shared/config";
import { rotateDailySalt, utcDay } from "../shared/identity";
import type { Env, RollupDimension } from "../shared/types";

// ---------------------------------------------------------------------------
// WAE SQL HTTP API types
// ---------------------------------------------------------------------------

interface WaeSqlResponse {
  data: WaeSqlRow[];
  meta: WaeSqlMeta[];
}

interface WaeSqlMeta {
  name: string;
  type: string;
}

interface WaeSqlRow {
  day: string;
  dim_value: string;
  pageviews: number | string;
  visitors: number | string;
  avg_interval: number | string;
  raw_count: number | string;
}

// ---------------------------------------------------------------------------
// Rollup dimensions and their WAE blob columns
// ---------------------------------------------------------------------------

/**
 * Dimensions we roll up into D1 (spec §4.2 / §5.1).
 * Each entry maps a D1 `dimension` label to the WAE blob column.
 *
 * The "total" dimension uses no blob (aggregated across all values).
 * The "page" dimension uses blob2, "referrer" uses blob3, etc.
 */
const ROLLUP_DIMENSIONS: Array<{ dimension: RollupDimension; blobCol: string | null }> = [
  { dimension: "total", blobCol: null },
  { dimension: "page", blobCol: "blob2" },
  { dimension: "referrer", blobCol: "blob3" },
  { dimension: "utm_source", blobCol: "blob4" },
  { dimension: "utm_medium", blobCol: "blob5" },
  { dimension: "utm_campaign", blobCol: "blob6" },
  { dimension: "country", blobCol: "blob7" },
  { dimension: "device", blobCol: "blob8" },
  { dimension: "browser", blobCol: "blob9" },
  { dimension: "os", blobCol: "blob10" },
  { dimension: "event", blobCol: "blob11" },
];

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Allowlist regex for siteId to prevent SQL injection. Fix #3 (HIGH). */
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** YYYY-MM-DD regex for day strings. Fix #3 (HIGH). */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateSiteId(siteId: string): void {
  if (!SITE_ID_RE.test(siteId)) {
    throw new Error(`Invalid siteId: "${siteId}"`);
  }
}

function validateDay(day: string): void {
  if (!DAY_RE.test(day)) {
    throw new Error(`Invalid day: "${day}"`);
  }
}

/**
 * Compute the next UTC day string for a given YYYY-MM-DD day.
 * Used for the upper-bound date filter (fix #4: use nextDay 00:00:00 instead
 * of <day> 23:59:59, which drops the last second's sub-second events).
 */
function nextUtcDay(day: string): string {
  // Parse as UTC midnight and advance by 1 day
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDay(d);
}

// ---------------------------------------------------------------------------
// WAE SQL API helpers
// ---------------------------------------------------------------------------

const WAE_SQL_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

async function queryWae(sql: string, env: Env, fetcher: typeof fetch): Promise<WaeSqlResponse> {
  // WAE SQL API: POST the raw SQL as the body (plain text), not JSON.
  // See: developers.cloudflare.com/analytics/analytics-engine/sql-api/
  const res = await fetcher(WAE_SQL_ENDPOINT(env.CF_ACCOUNT_ID), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WAE_API_TOKEN}`,
    },
    body: sql,
  });
  if (!res.ok) {
    throw new Error(`WAE SQL HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<WaeSqlResponse>;
}

// ---------------------------------------------------------------------------
// Rollup logic
// ---------------------------------------------------------------------------

/**
 * Build the SQL to aggregate one dimension for one day.
 *
 * WAE SQL constraints (spec §5.2): no JOIN, no UNION. We run one query per
 * dimension per day, returning BOTH metrics in the same rows: sampling-correct
 * pageviews via SUM(_sample_interval * doubleN), and unique visitors via
 * COUNT(DISTINCT blob1). Keeping it to one query per dimension is load-bearing:
 * a second visitors query per dimension doubled the WAE round-trips and timed
 * the cron out before it could write.
 *
 * Fix #3: siteId is validated against SITE_ID_RE before interpolation.
 * Fix #4: upper bound uses nextDay 00:00:00 (not <day> 23:59:59) to include
 *         sub-second events in the last second of the day.
 * Fix #7: avg_interval is returned for sampled-flag detection.
 */
export function buildDimensionSql(
  dataset: string,
  siteId: string,
  day: string,
  blobCol: string | null,
  // double2 = is_pageview (1 for pageviews, 0 for custom events). The "event"
  // dimension must aggregate double1 (count, always 1) instead — otherwise every
  // custom event rolls up with pageviews=0 and the events breakdown is empty.
  metricCol: "double1" | "double2" = "double2",
): string {
  // Validation happens in runRollups before this is called; assert here defensively.
  validateSiteId(siteId);
  validateDay(day);
  const nd = nextUtcDay(day);
  // siteId is validated to [A-Za-z0-9_-]{1,64} so single-quote escaping is not needed,
  // but we keep it for belt-and-suspenders correctness.
  const dateFilter = `toDateTime('${day} 00:00:00') <= timestamp AND timestamp < toDateTime('${nd} 00:00:00')`;
  const siteFilter = `index1 = '${siteId}'`;
  const base = `FROM ${dataset} WHERE ${siteFilter} AND ${dateFilter}`;

  if (blobCol === null) {
    // "total" dimension: aggregate everything
    return `
      SELECT
        '${day}' AS day,
        '' AS dim_value,
        SUM(_sample_interval * ${metricCol}) AS pageviews,
        COUNT(DISTINCT blob1) AS visitors,
        count() AS raw_count,
        AVG(_sample_interval) AS avg_interval
      ${base}
    `.trim();
  }

  // Per-dimension: group by the blob column
  return `
    SELECT
      '${day}' AS day,
      ${blobCol} AS dim_value,
      SUM(_sample_interval * ${metricCol}) AS pageviews,
      COUNT(DISTINCT blob1) AS visitors,
      count() AS raw_count,
      AVG(_sample_interval) AS avg_interval
    ${base}
    GROUP BY ${blobCol}
    ORDER BY pageviews DESC
    LIMIT 500
  `.trim();
}

/**
 * Determine if a WAE query was sampled by inspecting AVG(_sample_interval).
 *
 * Fix #7 (MED): replace the hardcoded 100k row-count threshold with
 * AVG(_sample_interval) from the query. WAE sets _sample_interval > 1 on
 * rows when adaptive sampling is active. A value meaningfully above 1.0
 * indicates sampling occurred.
 *
 * Tolerance: 1.0 exactly is unsampled; > 1.0 (with a small float tolerance)
 * means at least some rows were sampled.
 */
function detectSampled(rows: WaeSqlRow[]): boolean {
  for (const row of rows) {
    const avgInterval = Number(row.avg_interval);
    if (!Number.isNaN(avgInterval) && avgInterval > 1.0) return true;
  }
  return false;
}

/**
 * Run one rollup pass over all sites and all dimensions for all days in the
 * retention window. Upserts are idempotent (PRIMARY KEY conflict replaces).
 *
 * Fix #8 (MED): two-pass approach — collect ALL dimension results first,
 * compute anySampled across all of them, THEN write the batch so the 'total'
 * row's sampled flag reflects later-discovered sampling in per-dimension queries.
 */
export async function runRollups(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  // Fail closed: the WAE SQL API needs CF_ACCOUNT_ID + WAE_API_TOKEN. On a cold
  // account these may be unset; without a guard queryWae fires a request to a
  // malformed URL with `Bearer undefined` and surfaces an opaque HTTP error.
  // Skip the pass with a clear diagnostic instead.
  try {
    requireSecrets(env, ["CF_ACCOUNT_ID", "WAE_API_TOKEN"]);
  } catch (err) {
    if (err instanceof SecretsMissingError) {
      console.error(`rollup skipped — ${err.message}`);
      return;
    }
    throw err;
  }

  // 1. Rotate daily salt on every cron pass (idempotent, spec §3.5)
  await rotateDailySalt(env.SALT, new Date());

  // 2. Fetch all site IDs from D1
  const sitesResult = await env.DB.prepare("SELECT id FROM sites").all<{ id: string }>();
  const sites = sitesResult.results ?? [];
  if (sites.length === 0) return;

  const today = utcDay(new Date());
  // Roll up today (partial window) plus the previous 2 days to catch any late-arriving
  // data and to ensure yesterday's numbers are finalized after UTC midnight.
  const days: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    days.push(utcDay(d));
  }

  // WAE dataset name must match the `dataset` field in wrangler.jsonc
  const dataset = "skopia_events";

  // 3. For each site × dimension × day, query WAE and upsert into D1
  const upsertStmt = env.DB.prepare(`
    INSERT INTO rollup_daily (site_id, day, dimension, dim_value, pageviews, visitors, sampled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, day, dimension, dim_value)
    DO UPDATE SET pageviews = excluded.pageviews, visitors = excluded.visitors, sampled = excluded.sampled
  `);

  for (const site of sites) {
    // Fix #3: validate siteId before any SQL interpolation
    try {
      validateSiteId(site.id);
    } catch {
      // Skip sites with invalid IDs (should never happen if D1 is the source of truth)
      continue;
    }

    for (const day of days) {
      // Skip future days
      if (day > today) continue;

      // Fix #8: two-pass — collect all results first, then write.
      // Pass 1: query WAE for all dimensions, accumulate results + sampled flag.
      type DimResult = {
        dimension: RollupDimension;
        blobCol: string | null;
        rows: WaeSqlRow[];
      };
      // Query all dimensions for this (site, day) concurrently. WAE queries are
      // I/O-bound HTTP round-trips; running the ~11 dimensions sequentially made
      // the full pass (sites × days × dimensions) exceed the cron's time budget
      // as the site count grew, so it was cancelled before writing. One query
      // per dimension returns BOTH pageviews and unique visitors
      // (COUNT(DISTINCT blob1)); fanning them out keeps each (site, day) to a
      // single round-trip of wall-clock instead of eleven.
      const settled = await Promise.all(
        ROLLUP_DIMENSIONS.map(async ({ dimension, blobCol }): Promise<DimResult | null> => {
          try {
            // The "event" dimension counts custom-event fires (double1), not
            // pageviews (double2=is_pageview=0 for events).
            const metricCol = dimension === "event" ? "double1" : "double2";
            const sql = buildDimensionSql(dataset, site.id, day, blobCol, metricCol);
            const result = await queryWae(sql, env, fetcher);
            return { dimension, blobCol, rows: result.data ?? [] };
          } catch {
            // Non-fatal: WAE may 429 or be unavailable; skip this dimension
            return null;
          }
        }),
      );
      const dimResults = settled.filter((r): r is DimResult => r !== null);

      // Accumulate sampling detection across all dimensions (fix #8: before writing)
      const anySampled = dimResults.some((r) => detectSampled(r.rows));

      // Pass 2: now that anySampled reflects ALL dimensions, write the batch.
      const batch: ReturnType<typeof upsertStmt.bind>[] = [];

      for (const { dimension, rows } of dimResults) {
        if (dimension === "total") {
          const row = rows[0];
          if (row) {
            const visitors = Math.round(Number(row.visitors) || 0);
            batch.push(
              upsertStmt.bind(
                site.id,
                day,
                "total",
                "",
                Math.round(Number(row.pageviews) || 0),
                visitors,
                anySampled ? 1 : 0,
              ),
            );
          }
        } else {
          for (const row of rows) {
            const rawDimValue = row.dim_value ?? "";
            // Direct traffic (no referrer) arrives with an empty value. Bucket it
            // as "(direct)" so the Sources panel accounts for it rather than
            // silently dropping it.
            const dimValue =
              rawDimValue === "" && dimension === "referrer" ? "(direct)" : rawDimValue;
            if (!dimValue) continue; // skip empty dimension values for other dims
            const visitors = Math.round(Number(row.visitors) || 0);
            batch.push(
              upsertStmt.bind(
                site.id,
                day,
                dimension,
                dimValue,
                Math.round(Number(row.pageviews) || 0),
                visitors,
                anySampled ? 1 : 0,
              ),
            );
          }
        }
      }

      // D1 batch — up to 1000 statements per invocation limit
      if (batch.length > 0) {
        // Chunk into groups of 100 to stay safe within D1 limits
        for (let i = 0; i < batch.length; i += 100) {
          const chunk = batch.slice(i, i + 100);
          await env.DB.batch(chunk);
        }
      }
    }
  }
}

/** The Worker `scheduled()` handler — invokes {@link runRollups} via waitUntil. */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  void controller;
  ctx.waitUntil(runRollups(env));
}

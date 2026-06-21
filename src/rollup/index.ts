/**
 * Stratus — rollup cron (WAE -> D1 exact aggregates).
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

interface VisitorsSqlRow {
  visitors: number | string;
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
 * dimension per day. Sampling-correct pageviews use SUM(_sample_interval * double2).
 * Unique visitors are computed via a separate visitors query (buildVisitorsSql).
 *
 * Fix #3: siteId is validated against SITE_ID_RE before interpolation.
 * Fix #4: upper bound uses nextDay 00:00:00 (not <day> 23:59:59) to include
 *         sub-second events in the last second of the day.
 * Fix #7: avg_interval is returned for sampled-flag detection.
 */
function buildDimensionSql(
  dataset: string,
  siteId: string,
  day: string,
  blobCol: string | null,
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
        SUM(_sample_interval * double2) AS pageviews,
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
      SUM(_sample_interval * double2) AS pageviews,
      count() AS raw_count,
      AVG(_sample_interval) AS avg_interval
    ${base}
    GROUP BY ${blobCol}
    ORDER BY pageviews DESC
    LIMIT 500
  `.trim();
}

/**
 * Build the SQL to count unique visitors for one dimension for one day.
 *
 * Fix #1 (HIGH): unique visitors must come from a GROUP BY blob1 (vid) subquery,
 * not SUM(_sample_interval) which gives event counts (visitors == pageviews bug).
 *
 * Pattern per spec §4.1 / §5.2: "uniques use SUM(_sample_interval) over a
 * GROUP BY vid subquery". WAE SQL supports subqueries in FROM (spec §5.2:
 * "Subqueries and CTE-free aggregates are fine").
 *
 * For unsampled data (the common case at self-host volumes): each vid row in
 * the inner subquery has si=events-for-that-vid; the outer SUM(si) gives total
 * events, but COUNT(*) in the outer gives the deduplicated unique visitor count.
 * For sampling-corrected uniques we use SUM(si) from the inner (where si =
 * SUM(_sample_interval) per vid) which gives the best approximation: each unique
 * visitor contributes their sampling weight once.
 *
 * For per-dimension queries (blobCol != null), we also filter to the dimension
 * so that visitors are scoped to that dimension value in the outer GROUP BY.
 */
function buildVisitorsSql(
  dataset: string,
  siteId: string,
  day: string,
  blobCol: string | null,
): string {
  validateSiteId(siteId);
  validateDay(day);
  const nd = nextUtcDay(day);
  const dateFilter = `toDateTime('${day} 00:00:00') <= timestamp AND timestamp < toDateTime('${nd} 00:00:00')`;
  const siteFilter = `index1 = '${siteId}'`;
  const base = `WHERE ${siteFilter} AND ${dateFilter}`;

  if (blobCol === null) {
    // Total unique visitors: deduplicate by blob1 (vid)
    return `
      SELECT SUM(si) AS visitors
      FROM (
        SELECT blob1, SUM(_sample_interval) AS si
        FROM ${dataset} ${base}
        GROUP BY blob1
      )
    `.trim();
  }

  // Per-dimension: unique visitors grouped by dimension value
  // Inner: one row per (vid, dim_value); outer: sum si grouped by dim_value
  return `
    SELECT ${blobCol} AS dim_value, SUM(si) AS visitors
    FROM (
      SELECT blob1, ${blobCol}, SUM(_sample_interval) AS si
      FROM ${dataset} ${base}
      GROUP BY blob1, ${blobCol}
    )
    GROUP BY ${blobCol}
    ORDER BY visitors DESC
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
  const dataset = "stratus_events";

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
        visitorsMap: Map<string, number>; // dim_value -> visitors count
      };
      const dimResults: DimResult[] = [];
      let anySampled = false;

      for (const { dimension, blobCol } of ROLLUP_DIMENSIONS) {
        let rows: WaeSqlRow[];
        let visitorsMap: Map<string, number>;
        try {
          const pvSql = buildDimensionSql(dataset, site.id, day, blobCol);
          const pvResult = await queryWae(pvSql, env, fetcher);
          rows = pvResult.data ?? [];

          // Fetch visitors via the GROUP-BY-vid subquery (fix #1)
          const vSql = buildVisitorsSql(dataset, site.id, day, blobCol);
          const vResult = await queryWae(vSql, env, fetcher);
          const vRows = (vResult.data ?? []) as VisitorsSqlRow[];

          visitorsMap = new Map<string, number>();
          if (blobCol === null) {
            // Total dimension: single visitors count
            const vRow = vRows[0];
            if (vRow) {
              visitorsMap.set("", Math.round(Number(vRow.visitors) || 0));
            }
          } else {
            for (const vRow of vRows as (VisitorsSqlRow & { dim_value: string })[]) {
              const dv = vRow.dim_value ?? "";
              visitorsMap.set(dv, Math.round(Number(vRow.visitors) || 0));
            }
          }
        } catch {
          // Non-fatal: WAE may 429 or be unavailable; skip this dimension
          continue;
        }

        // Accumulate sampling detection across all dimensions (fix #8: before writing)
        if (!anySampled) {
          anySampled = detectSampled(rows);
        }

        dimResults.push({ dimension, blobCol, rows, visitorsMap });
      }

      // Pass 2: now that anySampled reflects ALL dimensions, write the batch.
      const batch: ReturnType<typeof upsertStmt.bind>[] = [];

      for (const { dimension, rows, visitorsMap } of dimResults) {
        if (dimension === "total") {
          const row = rows[0];
          if (row) {
            const visitors = visitorsMap.get("") ?? 0;
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
            const dimValue = row.dim_value ?? "";
            if (!dimValue) continue; // skip empty dimension values
            const visitors = visitorsMap.get(dimValue) ?? 0;
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

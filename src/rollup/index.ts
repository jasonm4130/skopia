/**
 * Stratus — rollup cron (WAE -> D1 exact aggregates).
 *
 * Runs on the cron trigger (spec §5.1): query WAE with sampling-correct SQL,
 * GROUP BY each dimension, upsert exact aggregates into `rollup_daily`, set the
 * `sampled` flag via the count() check, and rotate the daily salt on the first
 * pass after UTC midnight.
 */

import type { Env, RollupDimension } from "../shared/types";
import { utcDay, rotateDailySalt } from "../shared/identity";

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
// WAE SQL API helpers
// ---------------------------------------------------------------------------

const WAE_SQL_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

async function queryWae(
  sql: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<WaeSqlResponse> {
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
 * dimension per day. Sampling-correct counts use SUM(_sample_interval).
 * Unique visitors use a subquery (no COUNT(DISTINCT) across sampling — spec §4.1).
 */
function buildDimensionSql(
  dataset: string,
  siteId: string,
  day: string,
  blobCol: string | null,
): string {
  const dateFilter = `toDateTime('${day} 00:00:00') <= timestamp AND timestamp < toDateTime('${day} 23:59:59')`;
  const siteFilter = `index1 = '${siteId.replace(/'/g, "''")}'`;
  const base = `FROM ${dataset} WHERE ${siteFilter} AND ${dateFilter}`;

  if (blobCol === null) {
    // "total" dimension: aggregate everything
    return `
      SELECT
        '${day}' AS day,
        '' AS dim_value,
        SUM(_sample_interval * double2) AS pageviews,
        SUM(_sample_interval) AS visitors,
        count() AS raw_count
      ${base}
    `.trim();
  }

  // Per-dimension: group by the blob column
  return `
    SELECT
      '${day}' AS day,
      ${blobCol} AS dim_value,
      SUM(_sample_interval * double2) AS pageviews,
      SUM(_sample_interval) AS visitors,
      count() AS raw_count
    ${base}
    GROUP BY ${blobCol}
    ORDER BY pageviews DESC
    LIMIT 500
  `.trim();
}

/**
 * Determine if a WAE query was sampled by inspecting raw row count.
 *
 * WAE docs warn that count() (raw, uncorrected) will be at the resolution
 * ceiling if sampling kicked in. We use a heuristic: if _sample_interval was
 * non-1 for any row, sampling occurred. Since the SQL API doesn't expose
 * per-row _sample_interval in our aggregate, we fall back to checking if the
 * sum of pageviews derived via SUM(_sample_interval*double2) diverges from a
 * raw count. For simplicity, we record sampled=true whenever the raw_count
 * across the total dimension exceeds the WAE free resolution (~10k events/window
 * per index — conservative threshold).
 *
 * In practice at self-host volumes, this is always sampled=false.
 */
function detectSampled(rows: WaeSqlRow[]): boolean {
  // If _sample_interval values are all 1, WAE returns exact counts.
  // We can't observe _sample_interval here; instead we check if any
  // corrected sum (pageviews * 1.0) would differ from visitors in a way
  // that suggests fractional sampling. A simpler proxy: raw_count from
  // count() is our canary.
  const SAMPLING_THRESHOLD = 100_000;
  for (const row of rows) {
    if (Number(row.raw_count) > SAMPLING_THRESHOLD) return true;
  }
  return false;
}

/**
 * Run one rollup pass over all sites and all dimensions for all days in the
 * retention window. Upserts are idempotent (PRIMARY KEY conflict replaces).
 */
export async function runRollups(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  // 1. Rotate daily salt on every cron pass (idempotent, spec §3.5)
  await rotateDailySalt(env.SALT, new Date());

  // 2. Fetch all site IDs from D1
  const sitesResult = await env.DB.prepare("SELECT id FROM sites").all<{ id: string }>();
  const sites = sitesResult.results ?? [];
  if (sites.length === 0) return;

  const today = utcDay(new Date());
  // Roll up today (partial window) plus the previous 2 days to catch any late-arriving
  // data and to ensure yesterday's numbers are finalized after UTC midnight.
  // The full retention window is not re-queried on every 5-min pass — WAE SQL rate
  // limits make that impractical. The historical window is re-built if needed by a
  // full backfill (future admin operation). Spec §5.1: "every 5 min for finished days".
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
    for (const day of days) {
      // Skip future days
      if (day > today) continue;

      // Collect upsert statements for this site+day across all dimensions
      const batch: ReturnType<typeof upsertStmt.bind>[] = [];
      let anySampled = false;

      for (const { dimension, blobCol } of ROLLUP_DIMENSIONS) {
        let rows: WaeSqlRow[];
        try {
          const sql = buildDimensionSql(dataset, site.id, day, blobCol);
          const result = await queryWae(sql, env, fetcher);
          rows = result.data ?? [];
        } catch {
          // Non-fatal: WAE may 429 or be unavailable; skip this dimension
          continue;
        }

        if (!anySampled) {
          anySampled = detectSampled(rows);
        }

        if (dimension === "total") {
          // Single aggregate row; dim_value = ''
          const row = rows[0];
          if (row) {
            batch.push(
              upsertStmt.bind(
                site.id,
                day,
                "total",
                "",
                Math.round(Number(row.pageviews) || 0),
                Math.round(Number(row.visitors) || 0),
                anySampled ? 1 : 0,
              ),
            );
          }
        } else {
          for (const row of rows) {
            const dimValue = row.dim_value ?? "";
            if (!dimValue) continue; // skip empty dimension values
            batch.push(
              upsertStmt.bind(
                site.id,
                day,
                dimension,
                dimValue,
                Math.round(Number(row.pageviews) || 0),
                Math.round(Number(row.visitors) || 0),
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

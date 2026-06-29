/**
 * Tests for src/rollup/index.ts
 *
 * Mocks the WAE SQL fetch and asserts D1 rows written, including sampling math.
 *
 * The rollup issues ONE WAE query per dimension. That query returns both
 * pageviews (SUM(_sample_interval * doubleN)) and unique visitors
 * (COUNT(DISTINCT blob1)) in the same rows. A previous design used a second
 * visitors query per dimension, which doubled the WAE round-trips (~600
 * sequential calls) and pushed the cron past its time budget so waitUntil was
 * cancelled before the writes landed — hence the single-query rule.
 *
 * Fix #1: visitors != pageviews (COUNT(DISTINCT blob1)).
 * Fix #7: sampled detection uses AVG(_sample_interval) > 1.0, not raw_count threshold.
 * Fix #8: anySampled is computed over ALL dimensions before writing the 'total' row.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildDimensionSql, runRollups } from "../src/rollup/index";
import { applyMigrations } from "./apply-migrations";

// ---------------------------------------------------------------------------
// SQL-builder unit tests (guard the exact aggregate formulas)
// ---------------------------------------------------------------------------
describe("buildDimensionSql", () => {
  it("uses double2 (is_pageview) as the metric for pageview dimensions", () => {
    const sql = buildDimensionSql("skopia_events", "site-a", "2026-06-19", "blob2");
    expect(sql).toContain("SUM(_sample_interval * double2) AS pageviews");
  });

  it("uses double1 (count) as the metric for the event dimension so counts are non-zero", () => {
    // Custom events have double2 (is_pageview) = 0, so the event dimension must
    // aggregate double1 (count==1) or every event count rolls up as 0.
    const sql = buildDimensionSql("skopia_events", "site-a", "2026-06-19", "blob11", "double1");
    expect(sql).toContain("SUM(_sample_interval * double1) AS pageviews");
    expect(sql).not.toContain("double2");
  });

  it("counts unique visitors via COUNT(DISTINCT blob1) in the same query (no second round-trip)", () => {
    // The visitors count must ride along on the single pageviews query — a
    // separate visitors query per dimension doubled WAE calls and timed the
    // cron out before it could write.
    const total = buildDimensionSql("skopia_events", "site-a", "2026-06-19", null);
    expect(total).toContain("COUNT(DISTINCT blob1) AS visitors");
    const perDim = buildDimensionSql("skopia_events", "site-a", "2026-06-19", "blob3");
    expect(perDim).toContain("COUNT(DISTINCT blob1) AS visitors");
  });
});

beforeAll(async () => {
  // Apply the real migrations/0001_init.sql (creates all tables; no demo site
  // is seeded — the test registers its own sites below).
  await applyMigrations();
  await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
    .bind("rollup-site", "Rollup Test Site", "rollup.example.com")
    .run();
});

// ---------------------------------------------------------------------------
// WAE SQL mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a fetch stub that returns canned WAE SQL API responses.
 *
 * The rollup issues one query per dimension; each returned row carries both
 * `pageviews` and `visitors` (plus `avg_interval` and optional `dim_value`).
 *
 * `responses` — keyed by a substring to match in the SQL body; value = the
 *   WAE response for any query whose SQL contains that substring.
 */
function makeWaeFetcher(
  responses: Record<string, { data: object[] }>,
  fallback: { data: object[] } = { data: [] },
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const sql = init?.body ? String(init.body) : "";
    for (const [key, response] of Object.entries(responses)) {
      if (sql.includes(key)) {
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify(fallback), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// Today's date in UTC YYYY-MM-DD (same logic as utcDay)
function today(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRollups", () => {
  it("upserts total dimension rows into rollup_daily with visitors != pageviews (fix #1)", async () => {
    const day = today();

    // 30 unique visitors != 42 pageviews — both come from the same query row.
    const data = [{ day, dim_value: "", pageviews: 42, visitors: 30, avg_interval: 1.0 }];
    const fetcher = makeWaeFetcher({ "rollup-site": { data } });

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT * FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("rollup-site", day)
      .first<{ pageviews: number; visitors: number; sampled: number }>();

    expect(row).not.toBeNull();
    expect(row?.pageviews).toBe(42);
    // Fix #1: visitors comes from COUNT(DISTINCT blob1), not SUM(_sample_interval)
    expect(row?.visitors).toBe(30);
    // Verify visitors != pageviews (the core bug)
    expect(row?.visitors).not.toBe(row?.pageviews);
  });

  it("sets sampled=0 when avg_interval=1.0 (unsampled data — fix #7)", async () => {
    const day = today();

    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("low-vol-site", "Low Vol", "lowvol.example.com")
      .run();

    // avg_interval = 1.0 → not sampled (fix #7: AVG-based detection replaces raw_count threshold)
    const fetcher = makeWaeFetcher({
      "low-vol-site": {
        data: [{ day, dim_value: "", pageviews: 500, visitors: 400, avg_interval: 1.0 }],
      },
    });

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT sampled FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("low-vol-site", day)
      .first<{ sampled: number }>();

    expect(row?.sampled).toBe(0);
  });

  it("sets sampled=1 when avg_interval > 1.0 (sampled data — fix #7)", async () => {
    const day = today();

    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("high-vol-site", "High Vol", "highvol.example.com")
      .run();

    // avg_interval = 5.2 → sampled (WAE set sample interval > 1)
    const fetcher = makeWaeFetcher({
      "high-vol-site": {
        data: [{ day, dim_value: "", pageviews: 150000, visitors: 25000, avg_interval: 5.2 }],
      },
    });

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT sampled FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("high-vol-site", day)
      .first<{ sampled: number }>();

    expect(row?.sampled).toBe(1);
  });

  it("upsert is idempotent: running rollup twice gives the same row count", async () => {
    const day = today();

    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("idem-site", "Idempotent Site", "idem.example.com")
      .run();

    const fetcher = makeWaeFetcher({
      "idem-site": {
        data: [{ day, dim_value: "", pageviews: 77, visitors: 55, avg_interval: 1.0 }],
      },
    });

    await runRollups(env, fetcher);
    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("idem-site", day)
      .first<{ cnt: number }>();

    // ON CONFLICT upsert: exactly one row
    expect(row?.cnt).toBe(1);
  });

  it("gracefully handles WAE returning an empty result set", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("empty-wae-site", "Empty WAE", "empty.example.com")
      .run();

    const fetcher = makeWaeFetcher({}, { data: [] });
    await expect(runRollups(env, fetcher)).resolves.not.toThrow();
  });

  it("skips dimensions when WAE returns an HTTP error (non-fatal)", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("error-wae-site", "Error WAE", "error.example.com")
      .run();

    const fetcher = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(runRollups(env, fetcher)).resolves.not.toThrow();
  });

  it("two-pass: sampled flag on total row reflects sampling found in per-dimension queries (fix #8)", async () => {
    const day = today();

    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("twopass-site", "Two Pass Site", "twopass.example.com")
      .run();

    // Total dimension: avg_interval = 1.0 (looks unsampled on its own).
    // Per-dimension queries: avg_interval = 3.0 (reveals sampling happened).
    // Fix #8: the 'total' row must have sampled=1 because a later dimension revealed it.
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sql = init?.body ? String(init.body) : "";
      const isTotal = sql.includes("'' AS dim_value");
      if (sql.includes("twopass-site")) {
        const data = isTotal
          ? [{ day, dim_value: "", pageviews: 100, visitors: 10, avg_interval: 1.0 }]
          : [{ day, dim_value: "example", pageviews: 50, visitors: 5, avg_interval: 3.0 }];
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT sampled FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("twopass-site", day)
      .first<{ sampled: number }>();

    // The 'total' row must show sampled=1 because per-dimension data revealed sampling
    expect(row?.sampled).toBe(1);
  });

  it("buckets direct traffic (empty referrer) as '(direct)' rather than dropping it", async () => {
    const day = today();
    await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .bind("direct-site", "Direct Site", "direct.example.com")
      .run();

    // The referrer query (GROUP BY blob3) returns a direct-traffic row with an
    // empty dim_value carrying both pageviews and visitors. Keyed by a marker
    // unique to the referrer dimension's SQL so only that dimension matches.
    const fetcher = makeWaeFetcher({
      "blob3 AS dim_value": {
        data: [{ day, dim_value: "", pageviews: 12, visitors: 9, avg_interval: 1.0 }],
      },
    });

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id = ? AND dimension = 'referrer' AND dim_value = '(direct)' AND day = ?",
    )
      .bind("direct-site", day)
      .first<{ pageviews: number; visitors: number }>();

    expect(row).not.toBeNull();
    expect(row?.pageviews).toBe(12);
    expect(row?.visitors).toBe(9);
  });
});

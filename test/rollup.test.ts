/**
 * Tests for src/rollup/index.ts
 *
 * Mocks the WAE SQL fetch and asserts D1 rows written, including sampling math.
 *
 * The rollup now issues TWO WAE queries per dimension:
 *   1. A pageviews query  — contains "AVG(_sample_interval)" (returns pageviews + avg_interval)
 *   2. A visitors query   — contains "GROUP BY blob1" (returns visitor counts from
 *                           a GROUP BY blob1 subquery)
 *
 * Fix #1: visitors != pageviews (unique visitor subquery).
 * Fix #7: sampled detection uses AVG(_sample_interval) > 1.0, not raw_count threshold.
 * Fix #8: anySampled is computed over ALL dimensions before writing the 'total' row.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildDimensionSql, buildVisitorsSql, runRollups } from "../src/rollup/index";
import { applyMigrations } from "./apply-migrations";

// ---------------------------------------------------------------------------
// SQL-builder unit tests (guard the exact aggregate formulas)
// ---------------------------------------------------------------------------
describe("buildVisitorsSql", () => {
  it("counts DISTINCT visitor hashes, not total events (visitors != pageviews)", () => {
    const sql = buildVisitorsSql("skopia_events", "site-a", "2026-06-19", null);
    // Unique visitors = COUNT(*) over a GROUP BY blob1 subquery.
    expect(sql).toContain("COUNT(*) AS visitors");
    expect(sql).toContain("GROUP BY blob1");
    // The old SUM(si) formula collapsed to total events == pageviews — must be gone.
    expect(sql).not.toContain("SUM(si)");
    expect(sql).not.toContain("SUM(_sample_interval)");
  });

  it("counts distinct visitors per dimension value for breakdowns", () => {
    const sql = buildVisitorsSql("skopia_events", "site-a", "2026-06-19", "blob3");
    expect(sql).toContain("COUNT(*) AS visitors");
    expect(sql).toContain("GROUP BY blob1, blob3");
    expect(sql).not.toContain("SUM(si)");
  });
});

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
});

beforeAll(async () => {
  // Apply the real migrations/0001_init.sql (creates all tables + seeds the
  // 'default' site).
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
 * The rollup now issues two WAE queries per dimension:
 *   - pageviews query: identified by "AVG(_sample_interval)" in the SQL body
 *   - visitors query:  identified by "GROUP BY blob1" in the SQL body
 *
 * `pvResponses` — keyed by a substring to match in the SQL; value = pageviews response
 *   (rows should have: pageviews, avg_interval)
 * `visitorResponses` — keyed by same substring; value = visitors response
 *   (rows should have: visitors, and optionally dim_value for per-dimension queries)
 */
function makeWaeFetcher(
  pvResponses: Record<string, { data: object[] }>,
  visitorResponses: Record<string, { data: object[] }>,
  fallback: { data: object[] } = { data: [] },
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const sql = init?.body ? String(init.body) : "";

    // Identify query type by marker strings unique to each query
    const isVisitorsQuery = sql.includes("GROUP BY blob1");

    const responses = isVisitorsQuery ? visitorResponses : pvResponses;

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

    // Pageviews query response (identified by AVG(_sample_interval) marker)
    const pvData = [{ day, dim_value: "", pageviews: 42, avg_interval: 1.0 }];
    // Visitors query response (identified by GROUP BY blob1 marker)
    // 30 unique visitors != 42 pageviews — verifies the fix
    const visData = [{ visitors: 30 }];

    const fetcher = makeWaeFetcher(
      { "rollup-site": { data: pvData } },
      { "rollup-site": { data: visData } },
    );

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT * FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("rollup-site", day)
      .first<{ pageviews: number; visitors: number; sampled: number }>();

    expect(row).not.toBeNull();
    expect(row?.pageviews).toBe(42);
    // Fix #1: visitors comes from the GROUP BY blob1 subquery, not SUM(_sample_interval)
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
    const fetcher = makeWaeFetcher(
      { "low-vol-site": { data: [{ day, dim_value: "", pageviews: 500, avg_interval: 1.0 }] } },
      { "low-vol-site": { data: [{ visitors: 400 }] } },
    );

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
    const fetcher = makeWaeFetcher(
      {
        "high-vol-site": {
          data: [{ day, dim_value: "", pageviews: 150000, avg_interval: 5.2 }],
        },
      },
      { "high-vol-site": { data: [{ visitors: 25000 }] } },
    );

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

    const fetcher = makeWaeFetcher(
      { "idem-site": { data: [{ day, dim_value: "", pageviews: 77, avg_interval: 1.0 }] } },
      { "idem-site": { data: [{ visitors: 55 }] } },
    );

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

    const fetcher = makeWaeFetcher({}, {}, { data: [] });
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

    // Total dimension: avg_interval = 1.0 (looks unsampled on its own)
    // Per-dimension queries: avg_interval = 3.0 (reveals sampling happened)
    // Fix #8: the 'total' row must have sampled=1 because a later dimension revealed it.
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sql = init?.body ? String(init.body) : "";
      const isVisitorsQuery = sql.includes("GROUP BY blob1");

      if (isVisitorsQuery) {
        // Visitors query: always return simple count
        return new Response(JSON.stringify({ data: [{ visitors: 10 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pageviews query: total dimension has avg_interval=1.0, others have avg_interval=3.0
      const isTotal = sql.includes("'' AS dim_value");
      if (sql.includes("twopass-site")) {
        const data = isTotal
          ? [{ day, dim_value: "", pageviews: 100, avg_interval: 1.0 }]
          : [{ day, dim_value: "example", pageviews: 50, avg_interval: 3.0 }];
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
});

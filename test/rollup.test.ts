/**
 * Tests for src/rollup/index.ts
 *
 * Mocks the WAE SQL fetch and asserts D1 rows written, including sampling math.
 */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { runRollups } from "../src/rollup/index";
import { applyMigrations } from "./apply-migrations";

beforeAll(async () => {
  // Apply the real migrations/0001_init.sql (creates all tables + seeds the
  // 'default' site).
  await applyMigrations();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)",
  )
    .bind("rollup-site", "Rollup Test Site", "rollup.example.com")
    .run();
});

// ---------------------------------------------------------------------------
// WAE SQL mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a fetch stub that returns canned WAE SQL API responses.
 * The rollup queries WAE by POSTing raw SQL (plain text body).
 * We match by looking for a substring in the SQL body.
 */
function makeWaeFetcher(
  responses: Record<string, { data: object[] }>,
  fallback: { data: object[] } = { data: [] },
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    // WAE SQL API: body is raw SQL text (not JSON)
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
  it("upserts total dimension rows into rollup_daily", async () => {
    const day = today();

    const fetcher = makeWaeFetcher({
      "rollup-site": {
        data: [
          { day, dim_value: "", pageviews: 42, visitors: 30, raw_count: 42 },
        ],
      },
    });

    await runRollups(env, fetcher);

    const row = await env.DB.prepare(
      "SELECT * FROM rollup_daily WHERE site_id = ? AND dimension = 'total' AND day = ?",
    )
      .bind("rollup-site", day)
      .first<{ pageviews: number; visitors: number; sampled: number }>();

    expect(row).not.toBeNull();
    expect(typeof row?.pageviews).toBe("number");
    expect(typeof row?.visitors).toBe("number");
  });

  it("sets sampled=0 for low-volume data (below sampling threshold)", async () => {
    const day = today();

    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)",
    )
      .bind("low-vol-site", "Low Vol", "lowvol.example.com")
      .run();

    // raw_count well below 100k SAMPLING_THRESHOLD
    const fetcher = makeWaeFetcher({
      "low-vol-site": {
        data: [{ day, dim_value: "", pageviews: 500, visitors: 400, raw_count: 500 }],
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

  it("sets sampled=1 for high-volume data (above sampling threshold)", async () => {
    const day = today();

    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)",
    )
      .bind("high-vol-site", "High Vol", "highvol.example.com")
      .run();

    // raw_count > 100k → sampled=true
    const fetcher = makeWaeFetcher({
      "high-vol-site": {
        data: [{ day, dim_value: "", pageviews: 150000, visitors: 120000, raw_count: 150000 }],
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

    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)",
    )
      .bind("idem-site", "Idempotent Site", "idem.example.com")
      .run();

    const fetcher = makeWaeFetcher({
      "idem-site": {
        data: [{ day, dim_value: "", pageviews: 77, visitors: 55, raw_count: 77 }],
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
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)",
    )
      .bind("empty-wae-site", "Empty WAE", "empty.example.com")
      .run();

    const fetcher = makeWaeFetcher({}, { data: [] });
    await expect(runRollups(env, fetcher)).resolves.not.toThrow();
  });

  it("skips dimensions when WAE returns an HTTP error (non-fatal)", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)",
    )
      .bind("error-wae-site", "Error WAE", "error.example.com")
      .run();

    const fetcher = vi.fn(async () =>
      new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(runRollups(env, fetcher)).resolves.not.toThrow();
  });
});

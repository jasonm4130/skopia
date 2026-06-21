/**
 * Tests for src/db/queries.ts
 *
 * Seeds rollup_daily in a migrated D1 and asserts view-model shapes.
 * Uses env.DB.exec() to apply the schema, then seeds data.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBreakdown,
  getOverview,
  getOwner,
  getRealtimeCount,
  getSite,
  getSiteByPublicToken,
  getStatCards,
  getTimeSeries,
  getTopCountries,
  getTopPages,
  listGoals,
  listSites,
} from "../src/db/queries";
import { applyMigrations } from "./apply-migrations";

beforeAll(async () => {
  // Apply the real migrations/0001_init.sql (creates all tables + seeds the
  // 'default' site).
  await applyMigrations();

  // Seed sites
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist, public_token) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("site-a", "Site A", "sitea.com", "https://sitea.com", "pub-token-a")
    .run();

  // Seed a user
  await env.DB.prepare("INSERT OR IGNORE INTO users (email, pw_hash, role) VALUES (?, ?, ?)")
    .bind("owner@example.com", "hashed-pw", "owner")
    .run();

  // Seed goals
  await env.DB.prepare(
    "INSERT OR IGNORE INTO goals (site_id, name, match_type, match_value) VALUES (?, ?, ?, ?)",
  )
    .bind("site-a", "Signup", "event", "signup_complete")
    .run();

  // Seed rollup_daily for site-a
  // Three days of data: 2026-06-19, 2026-06-20, 2026-06-21
  const rows: [string, string, string, string, number, number, number][] = [
    // total dimension
    ["site-a", "2026-06-19", "total", "", 100, 80, 0],
    ["site-a", "2026-06-20", "total", "", 150, 100, 0],
    ["site-a", "2026-06-21", "total", "", 200, 130, 1], // sampled on 21st
    // page dimension
    ["site-a", "2026-06-19", "page", "/home", 60, 50, 0],
    ["site-a", "2026-06-19", "page", "/about", 40, 35, 0],
    ["site-a", "2026-06-20", "page", "/home", 90, 70, 0],
    ["site-a", "2026-06-21", "page", "/home", 120, 90, 1],
    // country dimension
    ["site-a", "2026-06-19", "country", "US", 70, 55, 0],
    ["site-a", "2026-06-19", "country", "DE", 30, 25, 0],
    ["site-a", "2026-06-20", "country", "US", 100, 75, 0],
  ];

  const stmt = env.DB.prepare(
    "INSERT OR REPLACE INTO rollup_daily (site_id, day, dimension, dim_value, pageviews, visitors, sampled) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch(rows.map((r) => stmt.bind(...r)));
});

// ---------------------------------------------------------------------------
// Site / user / goal metadata
// ---------------------------------------------------------------------------
describe("listSites", () => {
  it("returns all seeded sites", async () => {
    const sites = await listSites(env.DB);
    const ids = sites.map((s) => s.id);
    expect(ids).toContain("site-a");
    expect(ids).toContain("default"); // seeded by migration
  });
});

describe("getSite", () => {
  it("returns a site by id", async () => {
    const site = await getSite(env.DB, "site-a");
    expect(site).not.toBeNull();
    expect(site?.name).toBe("Site A");
  });

  it("returns null for unknown id", async () => {
    const site = await getSite(env.DB, "no-such-site");
    expect(site).toBeNull();
  });
});

describe("getSiteByPublicToken", () => {
  it("returns site by public token", async () => {
    const site = await getSiteByPublicToken(env.DB, "pub-token-a");
    expect(site?.id).toBe("site-a");
  });

  it("returns null for unknown token", async () => {
    const site = await getSiteByPublicToken(env.DB, "not-a-token");
    expect(site).toBeNull();
  });
});

describe("getOwner", () => {
  it("returns the owner user", async () => {
    const user = await getOwner(env.DB);
    expect(user?.email).toBe("owner@example.com");
    expect(user?.role).toBe("owner");
  });
});

describe("listGoals", () => {
  it("returns goals for a site", async () => {
    const goals = await listGoals(env.DB, "site-a");
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals[0]?.name).toBe("Signup");
  });

  it("returns empty array for unknown site", async () => {
    const goals = await listGoals(env.DB, "no-site");
    expect(goals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------
describe("getStatCards", () => {
  it("sums pageviews and visitors over the range", async () => {
    const cards = await getStatCards(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    // 100 + 150 + 200 = 450
    expect(cards.pageviews).toBe(450);
    // 80 + 100 + 130 = 310
    expect(cards.visitors).toBe(310);
  });

  it("sets sampled=true when any row is sampled", async () => {
    const cards = await getStatCards(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    expect(cards.sampled).toBe(true);
  });

  it("sets sampled=false when no row is sampled", async () => {
    const cards = await getStatCards(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-20" });
    expect(cards.sampled).toBe(false);
  });

  it("returns zeros for a site with no data", async () => {
    const cards = await getStatCards(env.DB, "default", { from: "2026-06-19", to: "2026-06-21" });
    expect(cards.pageviews).toBe(0);
    expect(cards.visitors).toBe(0);
  });

  it("computes viewsPerVisitor", async () => {
    const cards = await getStatCards(env.DB, "site-a", { from: "2026-06-20", to: "2026-06-20" });
    // 150 / 100 = 1.5
    expect(cards.viewsPerVisitor).toBe(1.5);
  });

  it("bounceRate is in [0, 1]", async () => {
    const cards = await getStatCards(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    expect(cards.bounceRate).toBeGreaterThanOrEqual(0);
    expect(cards.bounceRate).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------
describe("getTimeSeries", () => {
  it("returns one point per day in range", async () => {
    const series = await getTimeSeries(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    expect(series).toHaveLength(3);
    expect(series[0]?.day).toBe("2026-06-19");
    expect(series[1]?.day).toBe("2026-06-20");
    expect(series[2]?.day).toBe("2026-06-21");
  });

  it("correctly reports sampled flag per day", async () => {
    const series = await getTimeSeries(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    expect(series[0]?.sampled).toBe(false);
    expect(series[2]?.sampled).toBe(true);
  });

  it("has correct pageview values", async () => {
    const series = await getTimeSeries(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    expect(series[0]?.pageviews).toBe(100);
    expect(series[1]?.pageviews).toBe(150);
    expect(series[2]?.pageviews).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------
describe("getBreakdown / getTopPages", () => {
  it("returns top pages ordered by pageviews", async () => {
    const pages = await getTopPages(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" }, 10);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]?.label).toBe("/home"); // highest pageviews
  });

  it("share values are in [0, 1]", async () => {
    const pages = await getTopPages(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" }, 10);
    for (const page of pages) {
      expect(page.share).toBeGreaterThanOrEqual(0);
      expect(page.share).toBeLessThanOrEqual(1);
    }
  });

  it("respects the limit parameter", async () => {
    const pages = await getTopPages(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" }, 1);
    expect(pages.length).toBeLessThanOrEqual(1);
  });

  it("returns empty array for site with no data", async () => {
    const pages = await getTopPages(
      env.DB,
      "default",
      { from: "2026-06-19", to: "2026-06-21" },
      10,
    );
    expect(pages).toHaveLength(0);
  });
});

describe("getTopCountries", () => {
  it("returns country breakdown", async () => {
    const countries = await getTopCountries(
      env.DB,
      "site-a",
      { from: "2026-06-19", to: "2026-06-20" },
      10,
    );
    const labels = countries.map((c) => c.label);
    expect(labels).toContain("US");
    expect(labels).toContain("DE");
  });
});

describe("getBreakdown generic", () => {
  it("works for the 'country' dimension", async () => {
    const rows = await getBreakdown(
      env.DB,
      "site-a",
      { from: "2026-06-19", to: "2026-06-19" },
      "country",
      10,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.label).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getOverview
// ---------------------------------------------------------------------------
describe("getOverview", () => {
  it("returns the full overview view-model", async () => {
    const overview = await getOverview(env.DB, "site-a", { from: "2026-06-19", to: "2026-06-21" });
    expect(overview).not.toBeNull();
    expect(overview?.site.id).toBe("site-a");
    expect(overview?.cards.pageviews).toBe(450);
    expect(overview?.series).toHaveLength(3);
    expect(overview?.topPages.length).toBeGreaterThan(0);
    expect(typeof overview?.sampled).toBe("boolean");
  });

  it("returns null for unknown site", async () => {
    const overview = await getOverview(env.DB, "no-site", { from: "2026-06-19", to: "2026-06-21" });
    expect(overview).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRealtimeCount
// ---------------------------------------------------------------------------
describe("getRealtimeCount", () => {
  it("returns a number (may be 0 if today has no data)", async () => {
    const count = await getRealtimeCount(env.DB, "site-a");
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

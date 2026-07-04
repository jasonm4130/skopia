/**
 * Tests for src/collector/index.ts
 *
 * Coverage:
 * - CORS preflight: returns 204 with CORS headers
 * - POST /e: validates beacon shape (rejects bad payloads)
 * - POST /e: validates CORS origin allowlist (allow/deny)
 * - POST /e: bot drop (bot UA gets 204 without WAE write)
 * - POST /e: WAE.writeDataPoint is called with the exact blob/double mapping
 * - POST /e: missing site_id returns 404
 * - POST /e: valid beacon returns 204
 */

import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleCollect, handlePreflight } from "../src/collector/index";
import worker from "../src/index";
import { WAE_BLOB_SLOTS, WAE_DOUBLE_SLOTS } from "../src/shared/types";
import { applyMigrations } from "./apply-migrations";

beforeAll(async () => {
  // Apply the real migrations/0001_init.sql so all tables exist (no demo site
  // is seeded — the test registers its own sites below).
  await applyMigrations();
  // Seed test sites
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
  )
    .bind("test-site", "Test Site", "example.com", "https://example.com")
    .run();
  // Open site (no allowlist)
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
  )
    .bind("open-site", "Open Site", "open.com", "")
    .run();
});

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------
function makeBeaconRequest(
  body: object,
  opts?: {
    origin?: string;
    ua?: string;
    acceptLanguage?: string;
    cf?: Record<string, unknown>;
    ip?: string;
  },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": opts?.ua ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0",
    "Accept-Language": opts?.acceptLanguage ?? "en-US,en;q=0.9",
  };
  if (opts?.origin) headers.Origin = opts.origin;
  if (opts?.ip) headers["CF-Connecting-IP"] = opts.ip;

  const req = new Request("https://skopia.test/e", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, "cf", {
    value: opts?.cf ?? { country: "US", asn: 12345, asOrganization: "Example ISP" },
    writable: false,
  });
  return req;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
describe("handlePreflight", () => {
  it("returns 204 with CORS headers", () => {
    const req = new Request("https://skopia.test/e", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    });
    const res = handlePreflight(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("returns 400 when no Origin header", () => {
    const req = new Request("https://skopia.test/e", { method: "OPTIONS" });
    const res = handlePreflight(req, env);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Collect — validation
// ---------------------------------------------------------------------------
describe("handleCollect — validation", () => {
  it("rejects non-POST with 405", async () => {
    const req = new Request("https://skopia.test/e", { method: "GET" });
    Object.defineProperty(req, "cf", { value: {}, writable: false });
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(405);
  });

  it("rejects missing site_id with 400", async () => {
    const req = makeBeaconRequest({ t: "pv", p: "/" });
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects unknown event type with 400", async () => {
    const req = makeBeaconRequest({ t: "unknown", s: "test-site", p: "/" });
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects custom event without name with 400", async () => {
    const req = makeBeaconRequest(
      { t: "event", s: "test-site", p: "/" },
      { origin: "https://example.com" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects missing pathname with 400", async () => {
    const req = makeBeaconRequest({ t: "pv", s: "test-site" });
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects unknown site_id with 404", async () => {
    const req = makeBeaconRequest(
      { t: "pv", s: "no-such-site", p: "/" },
      { origin: "https://example.com" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Collect — CORS origin allowlist
// ---------------------------------------------------------------------------
describe("handleCollect — CORS origin allowlist", () => {
  it("accepts request from allowed origin", async () => {
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      { origin: "https://example.com", ip: "1.2.3.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("rejects request from disallowed origin with 403", async () => {
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      { origin: "https://evil.com" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it("rejects headerless POST to site with a non-empty allowlist (fix #2)", async () => {
    // 'test-site' has origin_allowlist="https://example.com", so a request with
    // no Origin header must be rejected — it would otherwise bypass the allowlist.
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      // No origin header — omit the key entirely
      { ip: "1.2.3.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it("accepts headerless POST to open site (empty allowlist)", async () => {
    // 'open-site' has an empty allowlist — headerless requests are fine.
    const req = makeBeaconRequest(
      { t: "pv", s: "open-site", p: "/" },
      { ip: "1.2.3.4" },
      // No origin header
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
  });

  it("accepts request to open site from any origin", async () => {
    const req = makeBeaconRequest(
      { t: "pv", s: "open-site", p: "/" },
      { origin: "https://anywhere.com", ip: "1.2.3.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Collect — bot drop
// ---------------------------------------------------------------------------
describe("handleCollect — bot drop", () => {
  it("silently drops bot UA with 204 (no error)", async () => {
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      {
        origin: "https://example.com",
        ua: "Googlebot/2.1 (+http://www.google.com/bot.html)",
        acceptLanguage: "en-US",
      },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Collect — secret guard (fail-closed)
// ---------------------------------------------------------------------------
describe("handleCollect — secret guard", () => {
  it("returns 503 when IDENTITY_HMAC_SECRET is unset", async () => {
    const envWithoutSecret = { ...env, IDENTITY_HMAC_SECRET: "" } as typeof env;
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      { origin: "https://example.com", ip: "1.2.3.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, envWithoutSecret, ctx);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("collector not configured");
  });

  it("returns 503 when IDENTITY_HMAC_SECRET is explicitly undefined", async () => {
    const envWithoutSecret = { ...env, IDENTITY_HMAC_SECRET: undefined } as unknown as typeof env;
    const req = makeBeaconRequest({ t: "pv", s: "open-site", p: "/" }, { ip: "1.2.3.4" });
    const ctx = createExecutionContext();
    const res = await handleCollect(req, envWithoutSecret, ctx);
    expect(res.status).toBe(503);
  });

  it("returns 204 (happy path) when IDENTITY_HMAC_SECRET is set", async () => {
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      { origin: "https://example.com", ip: "1.2.3.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Collect — infra resilience (Task 6: beacon path must never 5xx)
// ---------------------------------------------------------------------------
describe("handleCollect — infra resilience (never 5xx)", () => {
  it("returns 204 with CORS headers when the D1 site lookup throws", async () => {
    // Simulate a transient D1 outage at the site-lookup query. Pre-fix this
    // propagates to Hono's bare 500 (no CORS headers); post-fix it must be
    // caught and answered as a silent 204.
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1 unavailable (simulated)");
    });

    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/" },
      { origin: "https://example.com", ip: "1.2.3.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Collect — WAE writeDataPoint blob/double mapping
// ---------------------------------------------------------------------------
describe("handleCollect — WAE slot mapping", () => {
  it("calls WAE.writeDataPoint with the correct blob/double count and order", async () => {
    const writes: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { indexes: string[]; blobs: string[]; doubles: number[] });
    });

    const req = makeBeaconRequest(
      {
        t: "pv",
        s: "test-site",
        p: "/test-page?utm_source=google&utm_medium=cpc&utm_campaign=test",
        r: "https://www.google.com/search",
        ti: "Test Page",
        w: 1440,
      },
      {
        origin: "https://example.com",
        ip: "10.0.0.1",
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0",
        cf: { country: "US", asn: 12345, asOrganization: "Example ISP" },
      },
    );

    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes.length).toBe(1);

    const dp = writes[0]!;

    // Indexes: exactly 1, should be site_id
    expect(dp.indexes).toHaveLength(1);
    expect(dp.indexes[0]).toBe("test-site");

    // Blobs: must match WAE_BLOB_SLOTS length (13)
    expect(dp.blobs).toHaveLength(WAE_BLOB_SLOTS.length);

    // Blob1 = vid (16-hex)
    expect(dp.blobs[0]).toMatch(/^[0-9a-f]{16}$/);
    // Blob2 = pathname
    expect(dp.blobs[1]).toContain("/test-page");
    // Blob3 = referrer host
    expect(dp.blobs[2]).toBe("www.google.com");
    // Blob4 = utm_source
    expect(dp.blobs[3]).toBe("google");
    // Blob5 = utm_medium
    expect(dp.blobs[4]).toBe("cpc");
    // Blob6 = utm_campaign
    expect(dp.blobs[5]).toBe("test");
    // Blob7 = country
    expect(dp.blobs[6]).toBe("US");
    // Blob8 = device_class
    expect(["mobile", "tablet", "desktop"]).toContain(dp.blobs[7]);
    // Blob9 = browser
    expect(dp.blobs[8]).toBe("Chrome");
    // Blob10 = os
    expect(dp.blobs[9]).toBe("Windows");
    // Blob11 = event_name (empty for pageview)
    expect(dp.blobs[10]).toBe("");
    // Blob12 = entry_path
    expect(dp.blobs[11]).toContain("/test-page");
    // Blob13 = props_json (empty for pageview)
    expect(dp.blobs[12]).toBe("");

    // Doubles: must match WAE_DOUBLE_SLOTS length (3)
    expect(dp.doubles).toHaveLength(WAE_DOUBLE_SLOTS.length);
    // Double1 = count = 1
    expect(dp.doubles[0]).toBe(1);
    // Double2 = is_pageview = 1
    expect(dp.doubles[1]).toBe(1);
    // Double3 = screen_width
    expect(dp.doubles[2]).toBe(1440);

    vi.restoreAllMocks();
  });

  it("sets is_pageview=0 and event_name for custom events", async () => {
    const writes: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { indexes: string[]; blobs: string[]; doubles: number[] });
    });

    const req = makeBeaconRequest(
      { t: "event", s: "test-site", p: "/signup", n: "signup_complete", d: { plan: "pro" } },
      { origin: "https://example.com", ip: "10.0.0.2" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes.length).toBe(1);

    const dp = writes[0]!;
    // Blob11 = event_name
    expect(dp.blobs[10]).toBe("signup_complete");
    // Double2 = is_pageview = 0
    expect(dp.doubles[1]).toBe(0);
    // Double1 = count = 1
    expect(dp.doubles[0]).toBe(1);
    // Blob13 = props_json
    expect(dp.blobs[12]).toBe(JSON.stringify({ plan: "pro" }));

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Collect — referrer honesty (self-referral filter)
// ---------------------------------------------------------------------------
describe("handleCollect — referrer honesty (self-referral filter)", () => {
  it("treats own-domain referrer as direct (empty blob)", async () => {
    const writes: Array<{ blobs: string[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { blobs: string[] });
    });

    // 'test-site' has domain="example.com" (seeded in beforeAll).
    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/", r: "https://example.com/other-page" },
      { origin: "https://example.com", ip: "198.51.100.1" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes[0]?.blobs[2]).toBe("");

    vi.restoreAllMocks();
  });

  it("treats own-domain referrer with a leading www. as direct", async () => {
    const writes: Array<{ blobs: string[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { blobs: string[] });
    });

    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/", r: "https://www.example.com/other-page" },
      { origin: "https://example.com", ip: "198.51.100.2" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes[0]?.blobs[2]).toBe("");

    vi.restoreAllMocks();
  });

  it("treats own-domain referrer with mixed case as direct", async () => {
    const writes: Array<{ blobs: string[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { blobs: string[] });
    });

    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/", r: "https://EXAMPLE.COM/other-page" },
      { origin: "https://example.com", ip: "198.51.100.3" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes[0]?.blobs[2]).toBe("");

    vi.restoreAllMocks();
  });

  it("leaves an external referrer unchanged", async () => {
    const writes: Array<{ blobs: string[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { blobs: string[] });
    });

    const req = makeBeaconRequest(
      { t: "pv", s: "test-site", p: "/", r: "https://www.google.com/search" },
      { origin: "https://example.com", ip: "198.51.100.4" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes[0]?.blobs[2]).toBe("www.google.com");

    vi.restoreAllMocks();
  });

  it("skips the filter entirely for a site with the default empty domain", async () => {
    // Task 7 caches the site row per isolate — mutating 'open-site' in place
    // would race a warm cache entry from earlier tests. Use a dedicated site
    // with domain '' from creation so this test is independent of cache state.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
    )
      .bind("no-domain-site", "No Domain Site", "", "")
      .run();

    const writes: Array<{ blobs: string[] }> = [];
    vi.spyOn(env.WAE, "writeDataPoint").mockImplementation((dp) => {
      writes.push(dp as { blobs: string[] });
    });

    const req = makeBeaconRequest(
      { t: "pv", s: "no-domain-site", p: "/", r: "https://open.com/other-page" },
      { ip: "198.51.100.5" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(writes[0]?.blobs[2]).toBe("open.com");

    vi.restoreAllMocks();
  });

  it("performs exactly one D1 query for the site lookup", async () => {
    // Fresh site id: Task 7's per-isolate cache would otherwise serve 'test-site'
    // from cache (0 queries) by the time this test runs, hiding what this test
    // actually checks — that a single lookup is one merged SELECT, not two.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
    )
      .bind("single-query-site", "Single Query Site", "single-query.example", "")
      .run();

    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();

    const req = makeBeaconRequest(
      { t: "pv", s: "single-query-site", p: "/", r: "https://single-query.example/other-page" },
      { origin: "https://example.com", ip: "198.51.100.6" },
    );
    const ctx = createExecutionContext();
    const res = await handleCollect(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Live count (SiteLive DO bump)
// ---------------------------------------------------------------------------
describe("handleCollect — SiteLive DO bump", () => {
  it("bumps the DO with the real vid so distinct visitors are counted, not collapsed to 'unknown'", async () => {
    // Fresh site id → fresh DO with an empty visitor map (isolated from other tests).
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
    )
      .bind("live-site", "Live Site", "live.com", "")
      .run();

    // Two beacons from two different visitors (distinct IPs → distinct vids).
    const ctx = createExecutionContext();
    await handleCollect(
      makeBeaconRequest({ t: "pv", s: "live-site", p: "/a" }, { ip: "203.0.113.1" }),
      env,
      ctx,
    );
    await handleCollect(
      makeBeaconRequest({ t: "pv", s: "live-site", p: "/b" }, { ip: "203.0.113.2" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx); // flush the waitUntil DO bumps

    const stub = env.SITE_LIVE.get(env.SITE_LIVE.idFromName("live-site"));
    const count = await runInDurableObject(
      stub,
      (instance) => (instance as unknown as { visitors: Map<string, unknown> }).visitors.size,
    );

    // With the body-vs-query-param bug both visitors collapse to "unknown" → 1.
    // Correctly wired, the two distinct vids yield 2.
    expect(count).toBe(2);

    // The same /event calls also feed the incremental rollup. Fire the DO alarm
    // to flush, then the shadow table must hold the two pageviews.
    const { runDurableObjectAlarm } = await import("cloudflare:test");
    await runDurableObjectAlarm(stub);
    const shadow = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily_shadow WHERE site_id=? AND dimension='total'",
    )
      .bind("live-site")
      .first<{ pageviews: number; visitors: number }>();
    expect(shadow?.pageviews).toBe(2);
    expect(shadow?.visitors).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Collect — hot-path caching (Task 7)
// ---------------------------------------------------------------------------
describe("handleCollect — hot-path caching (Task 7)", () => {
  it("caches the site lookup: two beacons to the same site cost one D1 query", async () => {
    // Fresh site id — never queried by another test — so this test's cache
    // slot starts cold regardless of file execution order.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
    )
      .bind("hotpath-site", "Hotpath Site", "hotpath.example", "")
      .run();

    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();

    const ctx = createExecutionContext();
    await handleCollect(
      makeBeaconRequest({ t: "pv", s: "hotpath-site", p: "/a" }, { ip: "203.0.113.50" }),
      env,
      ctx,
    );
    await handleCollect(
      makeBeaconRequest({ t: "pv", s: "hotpath-site", p: "/b" }, { ip: "203.0.113.51" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // The second beacon must be served from the in-isolate site cache, not a
    // second D1 round trip.
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it("caches unknown-site (negative) lookups too: two beacons to a bogus site cost one D1 query", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    prepareSpy.mockClear();

    const ctx = createExecutionContext();
    await handleCollect(
      makeBeaconRequest({ t: "pv", s: "never-registered-site", p: "/a" }, { ip: "203.0.113.60" }),
      env,
      ctx,
    );
    await handleCollect(
      makeBeaconRequest({ t: "pv", s: "never-registered-site", p: "/b" }, { ip: "203.0.113.61" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(prepareSpy).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it("caches the daily salt: two beacons on the same day cost one KV get", async () => {
    // A synthetic day no other test touches keeps the day-keyed salt memo
    // cold at the start of this test, regardless of file execution order.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sites (id, name, domain, origin_allowlist) VALUES (?, ?, ?, ?)",
    )
      .bind("salt-cache-site", "Salt Cache Site", "saltcache.example", "")
      .run();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-05-17T12:00:00Z"));

      const getSpy = vi.spyOn(env.SALT, "get");
      getSpy.mockClear();

      const ctx = createExecutionContext();
      await handleCollect(
        makeBeaconRequest({ t: "pv", s: "salt-cache-site", p: "/a" }, { ip: "203.0.113.70" }),
        env,
        ctx,
      );
      await handleCollect(
        makeBeaconRequest({ t: "pv", s: "salt-cache-site", p: "/b" }, { ip: "203.0.113.71" }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(getSpy).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /e — CSP work dropped on the collector route (Task 7)
// ---------------------------------------------------------------------------
describe("POST /e — CSP exemption (Task 7)", () => {
  it("has no Content-Security-Policy header on the collector route", async () => {
    const req = new Request("https://skopia.test/e", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ t: "pv", s: "test-site", p: "/" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("still sets Content-Security-Policy on GET /health", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://skopia.test/health"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});

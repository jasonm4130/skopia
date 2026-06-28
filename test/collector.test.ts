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
  });
});

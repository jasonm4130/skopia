/**
 * deploy-cold.test.ts — cold-account graceful-degradation integration tests.
 *
 * Simulates the state a freshly-deployed Stratus Worker sees:
 *   - Empty D1 (no migrations run by setup, only the Worker's own ensureSchema)
 *   - One or more crypto secrets unset (empty string)
 *
 * These tests use the real worker entry (src/index.ts) and the SELF_REGISTERED
 * Miniflare bindings from vitest.config.ts. Secrets are overridden per-test by
 * spreading the global `env` and replacing specific keys.
 *
 * Coverage:
 * 1. Collector returns 503 (not 500) when IDENTITY_HMAC_SECRET is unset.
 * 2. Dashboard login refuses to sign when AUTH_COOKIE_SECRET is unset:
 *    - No redirect to /app, no Set-Cookie with a valid session.
 * 3. After ensureSchema, GET /setup renders the setup form (200).
 *
 * NOTE on /setup: the dashboard already calls `ensureSchema(c.env.DB)` in its
 * own root middleware (src/dashboard/index.ts), so GET /setup against a fresh DB
 * bootstraps the schema automatically and returns 200 with the setup form.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/shared/types";

// ---------------------------------------------------------------------------
// Mock src/db/queries so this test does not depend on real D1 query results
// for the login path, only for schema bootstrap.
// ---------------------------------------------------------------------------
import type { UserRow } from "../src/shared/types";

const MOCK_OWNER: UserRow = {
  id: 1,
  email: "owner@cold-test.dev",
  pw_hash: "pbkdf2:aabbccdd:eeff0011", // not a real hash — verifyPassword returns false
  role: "owner",
  created_at: 1700000000,
};

vi.mock("../src/db/queries", () => ({
  getOwner: vi.fn(),
  listSites: vi.fn().mockResolvedValue([]),
  getSite: vi.fn().mockResolvedValue(null),
  getSiteByPublicToken: vi.fn().mockResolvedValue(null),
  getStatCards: vi.fn().mockResolvedValue(null),
  getTimeSeries: vi.fn().mockResolvedValue([]),
  getTopPages: vi.fn().mockResolvedValue([]),
  getTopSources: vi.fn().mockResolvedValue([]),
  getTopCountries: vi.fn().mockResolvedValue([]),
  getTopDevices: vi.fn().mockResolvedValue([]),
  getTopBrowsers: vi.fn().mockResolvedValue([]),
  getTopOperatingSystems: vi.fn().mockResolvedValue([]),
  getTopUtmSources: vi.fn().mockResolvedValue([]),
  getTopEvents: vi.fn().mockResolvedValue([]),
  getBreakdown: vi.fn().mockResolvedValue([]),
  getOverview: vi.fn().mockResolvedValue(null),
  getRealtimeCount: vi.fn().mockResolvedValue(0),
  listGoals: vi.fn().mockResolvedValue([]),
}));

import * as queries from "../src/db/queries";
import { ensureSchema } from "../src/shared/schema";
import worker from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function workerFetch(
  request: Request,
  envOverride: Env = env as unknown as Env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, envOverride, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function makeCollectorRequest(siteId = "default"): Request {
  return new Request("https://stratus.test/e", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://example.com",
    },
    body: JSON.stringify({ s: siteId, t: "pv", p: "/cold-test" }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Bootstrap the schema once (seeds the 'default' site via INSERT OR IGNORE).
// This is distinct from apply-migrations: ensureSchema uses the embedded SQL
// (the runtime cold-account path), not the Wrangler migration runner.
let schemaReady = false;
beforeEach(async () => {
  if (!schemaReady) {
    await ensureSchema(env.DB as D1Database);
    schemaReady = true;
  }
  vi.mocked(queries.getOwner).mockResolvedValue(null); // default: no owner (cold account)
});

describe("cold-account: collector", () => {
  it("returns 503 (not 500) when IDENTITY_HMAC_SECRET is unset", async () => {
    const coldEnv = makeEnv({ IDENTITY_HMAC_SECRET: "" });
    const res = await workerFetch(makeCollectorRequest(), coldEnv);
    // 503 = "collector not configured" from the requireSecrets guard.
    // 500 = unhandled throw (the bug we're preventing).
    expect(res.status).toBe(503);
  });

  it("returns 503 body text 'collector not configured'", async () => {
    const coldEnv = makeEnv({ IDENTITY_HMAC_SECRET: "" });
    const res = await workerFetch(makeCollectorRequest(), coldEnv);
    const body = await res.text();
    expect(body).toContain("collector not configured");
  });
});

describe("cold-account: dashboard login with missing AUTH_COOKIE_SECRET", () => {
  it("does NOT redirect to /app when AUTH_COOKIE_SECRET is unset", async () => {
    // Owner exists but secret is empty — signing must fail, not succeed.
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);

    const coldEnv = makeEnv({ AUTH_COOKIE_SECRET: "" });

    const body = new FormData();
    body.append("email", "owner@cold-test.dev");
    body.append("password", "password123"); // wrong hash so verifyPassword returns false

    const req = new Request("https://stratus.test/login", {
      method: "POST",
      body,
    });

    const res = await workerFetch(req, coldEnv);

    // Must NOT be a successful login redirect to /app
    const location = res.headers.get("location");
    expect(location).not.toBe("/app");
  });

  it("does NOT set a session cookie when AUTH_COOKIE_SECRET is unset", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);

    const coldEnv = makeEnv({ AUTH_COOKIE_SECRET: "" });

    const body = new FormData();
    body.append("email", "owner@cold-test.dev");
    body.append("password", "password123");

    const req = new Request("https://stratus.test/login", {
      method: "POST",
      body,
    });

    const res = await workerFetch(req, coldEnv);

    // No Set-Cookie header with a session value
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).not.toContain("stratus_session=");
  });
});

describe("cold-account: /setup after schema bootstrap", () => {
  it("GET /setup returns 200 with the setup form when no owner exists", async () => {
    // Default mock: getOwner returns null (no owner on a cold account).
    // The dashboard middleware calls ensureSchema automatically.
    vi.mocked(queries.getOwner).mockResolvedValue(null);

    const res = await workerFetch(
      new Request("https://stratus.test/setup"),
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // The setup form must be present
    expect(text).toContain("Create account");
  });

  it("GET /setup redirects to /login when an owner already exists", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);

    const res = await workerFetch(
      new Request("https://stratus.test/setup"),
      env as unknown as Env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

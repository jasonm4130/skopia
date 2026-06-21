/**
 * Stratus — dashboard SSR + auth tests.
 *
 * Tests:
 *   - /setup GET renders the first-run form
 *   - /login GET renders the login form (after owner exists)
 *   - /login POST with wrong credentials returns 401
 *   - /app redirects to /login when unauthenticated
 *   - /app/pages redirects to /login when unauthenticated
 *   - /app/sources redirects to /login when unauthenticated
 *   - /app/geography redirects to /login when unauthenticated
 *   - /public/:token returns 404 for unknown token
 *   - /public/:token returns 200 with HTML overview sections for a known token
 *   - /logout clears the session cookie
 *
 * src/db/queries.ts is mocked so these tests do not depend on the backbone
 * agent's implementation.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock src/db/queries.ts before importing the worker
// ---------------------------------------------------------------------------

import type {
  SiteRow,
  UserRow,
  StatCards,
  TimeSeriesPoint,
  BreakdownRow,
} from "../../src/shared/types";

const MOCK_SITE: SiteRow = {
  id: "site-001",
  name: "test.dev",
  domain: "test.dev",
  origin_allowlist: "https://test.dev",
  public_token: "pub-tok-abc123",
  created_at: 1700000000,
};

const MOCK_OWNER: UserRow = {
  id: 1,
  email: "owner@test.dev",
  // PBKDF2 hash of "password123" — not a real hash for tests, we override verifyPassword via mocking
  pw_hash: "pbkdf2:aabbccdd:eeff0011",
  role: "owner",
  created_at: 1700000000,
};

const MOCK_CARDS: StatCards = {
  pageviews: 5000,
  visitors: 1200,
  viewsPerVisitor: 4.2,
  bounceRate: 0.38,
  sampled: false,
};

const MOCK_SERIES: TimeSeriesPoint[] = [
  { day: "2026-05-22", pageviews: 160, visitors: 80, sampled: false },
  { day: "2026-05-29", pageviews: 220, visitors: 100, sampled: false },
  { day: "2026-06-05", pageviews: 190, visitors: 90, sampled: false },
];

const MOCK_BREAKDOWN: BreakdownRow[] = [
  { label: "/home", pageviews: 3000, visitors: 800, share: 0.67, sampled: false },
  { label: "/pricing", pageviews: 2000, visitors: 400, share: 0.33, sampled: false },
];

vi.mock("../../src/db/queries", () => ({
  getOwner: vi.fn(),
  listSites: vi.fn(),
  getSite: vi.fn(),
  getSiteByPublicToken: vi.fn(),
  getStatCards: vi.fn(),
  getTimeSeries: vi.fn(),
  getTopPages: vi.fn(),
  getTopSources: vi.fn(),
  getTopCountries: vi.fn(),
  getTopDevices: vi.fn(),
  getTopBrowsers: vi.fn(),
  getTopOperatingSystems: vi.fn(),
  getTopUtmSources: vi.fn(),
  getTopEvents: vi.fn(),
  getBreakdown: vi.fn(),
  getOverview: vi.fn(),
  getRealtimeCount: vi.fn(),
  listGoals: vi.fn(),
}));

import * as queries from "../../src/db/queries";
import worker from "../../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(path: string, opts?: RequestInit): Request {
  return new Request(`https://stratus.test${path}`, opts);
}

async function fetch_(request: Request): Promise<{ res: Response; text: string }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { res, text };
}

// ---------------------------------------------------------------------------
// Setup mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
  vi.mocked(queries.listSites).mockResolvedValue([MOCK_SITE]);
  vi.mocked(queries.getSite).mockResolvedValue(MOCK_SITE);
  vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(null); // default: not found
  vi.mocked(queries.getStatCards).mockResolvedValue(MOCK_CARDS);
  vi.mocked(queries.getTimeSeries).mockResolvedValue(MOCK_SERIES);
  vi.mocked(queries.getTopPages).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopSources).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopCountries).mockResolvedValue(MOCK_BREAKDOWN);
});

// ---------------------------------------------------------------------------
// /setup
// ---------------------------------------------------------------------------

describe("/setup", () => {
  it("GET /setup redirects to /login when owner already exists", async () => {
    const { res } = await fetch_(req("/setup"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("GET /setup renders setup form when no owner", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const { res, text } = await fetch_(req("/setup"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/html/);
    expect(text).toContain("Welcome to Stratus");
    expect(text).toContain('action="/setup"');
  });
});

// ---------------------------------------------------------------------------
// /login
// ---------------------------------------------------------------------------

describe("/login", () => {
  it("GET /login renders the sign-in form", async () => {
    const { res, text } = await fetch_(req("/login"));
    expect(res.status).toBe(200);
    expect(text).toContain("Sign in");
    expect(text).toContain('action="/login"');
  });

  it("GET /login redirects to /setup when no owner exists", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const { res } = await fetch_(req("/login"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/setup");
  });

  it("POST /login with wrong password returns 401 and error message", async () => {
    const form = new URLSearchParams({ email: "owner@test.dev", password: "wrongpassword" });
    const { res, text } = await fetch_(
      req("/login", {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(401);
    expect(text).toContain("Invalid email or password");
  });

  it("POST /login with wrong email returns 401", async () => {
    const form = new URLSearchParams({ email: "notowner@test.dev", password: "password123" });
    const { res, text } = await fetch_(
      req("/login", {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(401);
    expect(text).toContain("Invalid email or password");
  });
});

// ---------------------------------------------------------------------------
// /logout
// ---------------------------------------------------------------------------

describe("/logout", () => {
  it("GET /logout redirects to /login and clears session cookie", async () => {
    const { res } = await fetch_(req("/logout"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("stratus_session");
  });
});

// ---------------------------------------------------------------------------
// Auth gating on /app routes
// ---------------------------------------------------------------------------

describe("auth gating", () => {
  it("GET /app without a cookie redirects to /login", async () => {
    const { res } = await fetch_(req("/app"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("GET /app/pages without a cookie redirects to /login", async () => {
    const { res } = await fetch_(req("/app/pages"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("GET /app/sources without a cookie redirects to /login", async () => {
    const { res } = await fetch_(req("/app/sources"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("GET /app/geography without a cookie redirects to /login", async () => {
    const { res } = await fetch_(req("/app/geography"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("GET /app with invalid cookie redirects to /login", async () => {
    const { res } = await fetch_(
      req("/app", { headers: { Cookie: "stratus_session=bogus.invalidsig" } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

// ---------------------------------------------------------------------------
// /public/:token
// ---------------------------------------------------------------------------

describe("/public/:token", () => {
  it("returns 404 for an unknown token", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(null);
    const { res } = await fetch_(req("/public/nonexistent-token"));
    expect(res.status).toBe(404);
  });

  it("returns 200 with HTML for a valid token", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    const { res, text } = await fetch_(req("/public/pub-tok-abc123"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/html/);
    expect(text).toContain("test.dev");
  });

  it("public view shows stat-card values from mock data", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    // fmtNum(1200) = "1.2K"
    expect(text).toContain("1.2K");
    // fmtNum(5000) = "5K"
    expect(text).toContain("5K");
  });

  it("public view contains 'read-only' badge", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    expect(text).toContain("read-only");
  });

  it("public view contains top pages breakdown", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    expect(text).toContain("/home");
    expect(text).toContain("Top pages");
    expect(text).toContain("Top sources");
  });

  it("public view does NOT contain sidebar nav (no auth shell)", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    // The sidebar "Overview" nav link is only in the auth'd shell
    expect(text).not.toContain('href="/app"');
  });

  it("range picker is present on public view", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    expect(text).toContain("Last 30 days");
  });
});

// ---------------------------------------------------------------------------
// Sampled badge
// ---------------------------------------------------------------------------

describe("sampled data badge", () => {
  it("shows ~est badge when cards.sampled is true", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    vi.mocked(queries.getStatCards).mockResolvedValue({ ...MOCK_CARDS, sampled: true });
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    expect(text).toContain("~est");
  });

  it("does NOT show ~est badge when cards.sampled is false", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValue(MOCK_SITE);
    vi.mocked(queries.getStatCards).mockResolvedValue({ ...MOCK_CARDS, sampled: false });
    const { text } = await fetch_(req("/public/pub-tok-abc123"));
    expect(text).not.toContain("~est");
  });
});

// ---------------------------------------------------------------------------
// /live — WebSocket
// ---------------------------------------------------------------------------

describe("/live", () => {
  it("returns 400 when site param is missing", async () => {
    const { res } = await fetch_(req("/live"));
    expect(res.status).toBe(400);
  });

  it("returns 426 when Upgrade header is missing", async () => {
    const { res } = await fetch_(req("/live?site=site-001"));
    expect(res.status).toBe(426);
  });
});

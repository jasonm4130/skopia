/**
 * Skopia — dashboard SSR + auth tests.
 *
 * Tests:
 *   - /setup GET renders the first-run form
 *   - /login GET renders the login form (after owner exists)
 *   - /login POST with wrong credentials returns 401
 *   - /app redirects to /login when unauthenticated
 *   - /app/pages redirects to /login when unauthenticated
 *   - /app/sources redirects to /login when unauthenticated
 *   - /app/geography redirects to /login when unauthenticated
 *   - /logout clears the session cookie
 *   - /live unauthenticated is rejected (redirected to /login)
 *   - /live authenticated but missing Upgrade returns 426
 *
 * The public /share/:token surface (launch-readiness Task 1, replacing
 * /public/:token) has its own suite: test/dashboard/share.test.ts.
 *
 * src/db/queries.ts is mocked so these tests do not depend on the backbone
 * agent's implementation.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock src/db/queries.ts before importing the worker
// ---------------------------------------------------------------------------

import type {
  BreakdownRow,
  SiteRow,
  StatCards,
  TimeSeriesPoint,
  UserRow,
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

const MOCK_DEVICES: BreakdownRow[] = [
  { label: "desktop", pageviews: 3000, visitors: 800, share: 0.7, sampled: false },
  { label: "mobile", pageviews: 1200, visitors: 350, share: 0.3, sampled: false },
];

const MOCK_UTM: BreakdownRow[] = [
  { label: "newsletter", pageviews: 400, visitors: 300, share: 0.6, sampled: false },
  { label: "twitter", pageviews: 250, visitors: 200, share: 0.4, sampled: false },
];

const MOCK_EVENTS: BreakdownRow[] = [
  { label: "signup", pageviews: 42, visitors: 30, share: 0.02, sampled: false },
  { label: "download", pageviews: 17, visitors: 15, share: 0.01, sampled: false },
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
  getTopUtmMediums: vi.fn(),
  getTopUtmCampaigns: vi.fn(),
  getTopEvents: vi.fn(),
  getBreakdown: vi.fn(),
  getOverview: vi.fn(),
  getRealtimeCount: vi.fn(),
  listGoals: vi.fn(),
}));

import * as queries from "../../src/db/queries";
import worker from "../../src/index";
import { applyMigrations } from "../apply-migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(path: string, opts?: RequestInit): Request {
  return new Request(`https://skopia.test${path}`, opts);
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
  vi.mocked(queries.getTopDevices).mockResolvedValue(MOCK_DEVICES);
  vi.mocked(queries.getTopBrowsers).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopOperatingSystems).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopUtmSources).mockResolvedValue(MOCK_UTM);
  vi.mocked(queries.getTopUtmMediums).mockResolvedValue(MOCK_UTM);
  vi.mocked(queries.getTopUtmCampaigns).mockResolvedValue(MOCK_UTM);
  vi.mocked(queries.getTopEvents).mockResolvedValue(MOCK_EVENTS);
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
    expect(text).toContain("Welcome to Skopia");
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

  // -------------------------------------------------------------------------
  // Timing oracle (Task 9): the `emailMatches && verifyPassword(...)` check
  // must not short-circuit on email mismatch — verifyPassword (PBKDF2, via
  // crypto.subtle.deriveBits) has to run either way so a wrong email and a
  // wrong password cost the same CPU time.
  // -------------------------------------------------------------------------

  it("still runs the PBKDF2 check on an email mismatch (no timing oracle)", async () => {
    const deriveBitsSpy = vi.spyOn(crypto.subtle, "deriveBits");
    const form = new URLSearchParams({
      email: "definitely-not-owner@test.dev",
      password: "whatever",
    });
    const { res, text } = await fetch_(
      req("/login", {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(401);
    expect(text).toContain("Invalid email or password");
    expect(deriveBitsSpy).toHaveBeenCalled();
    deriveBitsSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PBKDF2 iteration cap (production incident 2026-07-05): the Workers runtime
// rejects PBKDF2 above 100k iterations ("NotSupportedError: iteration counts
// above 100000 are not supported"), which turned every production POST /login
// into a 500 while the code derived at 210k. Local workerd does NOT enforce
// the cap, so these tests pin the code-level contract instead: new hashes
// embed their iteration count, verification derives at the embedded (or
// legacy-implied 100k) count, and a count above the cap is rejected without
// ever calling deriveBits.
// ---------------------------------------------------------------------------

async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function loginForm(email: string, password: string): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams({ email, password }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

describe("PBKDF2 iteration cap", () => {
  const SALT_HEX = "000102030405060708090a0b0c0d0e0f";

  it("accepts a v2 hash with an embedded 100k iteration count", async () => {
    const hash = await pbkdf2Hex("password123", SALT_HEX, 100_000);
    vi.mocked(queries.getOwner).mockResolvedValue({
      ...MOCK_OWNER,
      pw_hash: `pbkdf2:100000:${SALT_HEX}:${hash}`,
    });
    const { res } = await fetch_(req("/login", loginForm("owner@test.dev", "password123")));
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("skopia_session");
  });

  it("verifies a legacy 3-part hash at the 100k it was created with", async () => {
    const hash = await pbkdf2Hex("password123", SALT_HEX, 100_000);
    vi.mocked(queries.getOwner).mockResolvedValue({
      ...MOCK_OWNER,
      pw_hash: `pbkdf2:${SALT_HEX}:${hash}`,
    });
    const { res } = await fetch_(req("/login", loginForm("owner@test.dev", "password123")));
    expect(res.status).toBe(302);
  });

  it("rejects a hash demanding iterations above the cap without deriving (401, not 500)", async () => {
    const deriveBitsSpy = vi.spyOn(crypto.subtle, "deriveBits");
    vi.mocked(queries.getOwner).mockResolvedValue({
      ...MOCK_OWNER,
      pw_hash: `pbkdf2:210000:${SALT_HEX}:${"ab".repeat(32)}`,
    });
    const { res } = await fetch_(req("/login", loginForm("owner@test.dev", "password123")));
    expect(res.status).toBe(401);
    for (const call of deriveBitsSpy.mock.calls) {
      expect((call[0] as { iterations: number }).iterations).toBeLessThanOrEqual(100_000);
    }
    deriveBitsSpy.mockRestore();
  });

  it("new hashes created by /setup embed the 100k iteration count", async () => {
    await applyMigrations();
    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const form = new URLSearchParams({
      email: "fresh@test.dev",
      password: "password123",
      confirm: "password123",
    });
    const { res } = await fetch_(
      req("/setup", {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(302);
    const row = await env.DB.prepare("SELECT pw_hash FROM users WHERE email = ?")
      .bind("fresh@test.dev")
      .first<{ pw_hash: string }>();
    expect(row?.pw_hash).toMatch(/^pbkdf2:100000:[0-9a-f]{32}:[0-9a-f]{64}$/);
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
    expect(setCookie).toContain("skopia_session");
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
      req("/app", { headers: { Cookie: "skopia_session=bogus.invalidsig" } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

// ---------------------------------------------------------------------------
// Stat-card labels (Task 5 — honest "bounce rate" relabel)
//
// Migrated off /public/:token (launch-readiness Task 1: /share/:token
// replaces it — public-surface coverage lives in test/dashboard/share.test.ts
// now). statCardsHtml() is shared verbatim between /app and /share, so
// asserting its output via the still-authed /app route preserves the same
// coverage without coupling this suite to the public surface.
// ---------------------------------------------------------------------------

describe("stat-card labels", () => {
  it("renders the 'Single-Page Visits' label, not 'Bounce Rate'", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain("Single-Page Visits");
    expect(text).not.toContain("Bounce Rate");
  });

  it("footnotes the imprecise metrics with an honest caveat tooltip", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    // Visitors is a sum of daily uniques across the range — the caveat must say so.
    expect(text).toContain("counted once per day");
    // Single-Page Visits is estimated, not measured per-session.
    expect(text).toContain("Approximate. Estimated from pageviews and visitors");
  });
});

// ---------------------------------------------------------------------------
// CSP nonce on inline scripts (Task 4)
// ---------------------------------------------------------------------------

/** Sign a valid session cookie using the test env's AUTH_COOKIE_SECRET. */
async function authedCookie(): Promise<string> {
  const secret = (env as { AUTH_COOKIE_SECRET?: string }).AUTH_COOKIE_SECRET ?? "test-secret";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `1|${expiry}`;
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return encodeURIComponent(`${payload}.${sigHex}`);
}

describe("CSP nonce", () => {
  it("authed /app inline <script> carries a nonce= attribute", async () => {
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    // Every inline <script> (no src) must be nonced for strict-dynamic CSP.
    expect(text).toMatch(/<script nonce="[a-f0-9]+">/);
    // No un-nonced inline script blocks.
    expect(text).not.toMatch(/<script>\s*\n/);
    // The CSP header from the root middleware advertises the same nonce.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[a-f0-9]+' 'strict-dynamic'/);
  });

  it("chart metric toggle is wired via addEventListener, not blocked inline onclick", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    // Strict CSP (no script-src-attr) blocks inline handlers, so the toggle must
    // not rely on them — otherwise "Visitors vs Pageviews" silently does nothing.
    expect(text).not.toMatch(/onclick="setMetric/);
    expect(text).not.toMatch(/onmouseleave=/);
    expect(text).toContain("getElementById('btn-visitors').addEventListener('click'");
    expect(text).toContain("getElementById('btn-pageviews').addEventListener('click'");
  });
});

// ---------------------------------------------------------------------------
// Multi-site switcher, range preservation, empty state
// ---------------------------------------------------------------------------

const MOCK_SITE_2: SiteRow = {
  id: "site-002",
  name: "other.dev",
  domain: "other.dev",
  origin_allowlist: "",
  public_token: "pub-tok-two",
  created_at: 1700000001,
};

describe("site switcher", () => {
  it("renders a switcher listing all sites with the active one selected", async () => {
    vi.mocked(queries.listSites).mockResolvedValue([MOCK_SITE, MOCK_SITE_2]);
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    expect(text).toContain('id="skopia-site-switcher"');
    expect(text).toContain('<option value="site-001" selected>test.dev</option>');
    expect(text).toContain('<option value="site-002">other.dev</option>');
  });

  it("selects the site named by ?site= ", async () => {
    vi.mocked(queries.listSites).mockResolvedValue([MOCK_SITE, MOCK_SITE_2]);
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app?site=site-002", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    expect(text).toContain('<option value="site-002" selected>other.dev</option>');
    expect(text).toContain('<option value="site-001">test.dev</option>');
  });
});

describe("range preservation across nav", () => {
  it("sidebar nav links and the switcher carry the active range", async () => {
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app?range=7d", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    // Navigating Overview → Pages must keep range=7d.
    expect(text).toContain('href="/app/pages?site=site-001&range=7d"');
    expect(text).toContain('href="/app/sources?site=site-001&range=7d"');
    // The switcher remembers the range for its on-change navigation.
    expect(text).toContain('data-range="7d"');
  });
});

describe("no-sites empty state", () => {
  it("renders honest setup copy without the misleading /setup link", async () => {
    vi.mocked(queries.listSites).mockResolvedValue([]);
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    expect(text).toContain("No sites tracked yet");
    expect(text).toContain("wrangler d1 execute");
    // The old copy linked to /setup (owner creation) — a redirect-loop trap.
    expect(text).not.toContain("Add a site");
  });
});

// ---------------------------------------------------------------------------
// Sampled badge
//
// Migrated off /public/:token (see "stat-card labels" above for why /app is
// the right stand-in now that /share/:token owns the public surface).
// ---------------------------------------------------------------------------

describe("sampled data badge", () => {
  it("shows ~est badge when cards.sampled is true", async () => {
    vi.mocked(queries.getStatCards).mockResolvedValue({ ...MOCK_CARDS, sampled: true });
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain("~est");
  });

  it("does NOT show ~est badge when cards.sampled is false", async () => {
    vi.mocked(queries.getStatCards).mockResolvedValue({ ...MOCK_CARDS, sampled: false });
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).not.toContain("~est");
  });
});

// ---------------------------------------------------------------------------
// Breakdown-table honesty (Task 9): the Visitors column is a sum of daily
// uniques (same caveat as the Overview stat card), and a sampled row must
// carry the same ~est badge the Overview shows.
// ---------------------------------------------------------------------------

describe("breakdown table honesty (Task 9)", () => {
  it("Visitors column header carries the same daily-counted-once caveat as Overview", async () => {
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app/pages", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    const visitorsHeaderIdx = text.indexOf(">Visitors<");
    expect(visitorsHeaderIdx).toBeGreaterThan(-1);
    const headerSnippet = text.slice(Math.max(0, visitorsHeaderIdx - 400), visitorsHeaderIdx);
    expect(headerSnippet).toContain("counted once per day");
  });

  it("renders the ~est badge on a row whose sampled flag is set, not on unsampled rows", async () => {
    const sampledRow: BreakdownRow = {
      label: "/sampled-page",
      pageviews: 900,
      visitors: 300,
      share: 0.3,
      sampled: true,
    };
    vi.mocked(queries.getTopPages).mockResolvedValue([...MOCK_BREAKDOWN, sampledRow]);
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app/pages", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    const sampledRowStart = text.indexOf("/sampled-page");
    expect(sampledRowStart).toBeGreaterThan(-1);
    expect(text.slice(sampledRowStart, sampledRowStart + 800)).toContain("~est");

    const homeRowStart = text.indexOf("/home");
    expect(homeRowStart).toBeGreaterThan(-1);
    expect(text.slice(homeRowStart, homeRowStart + 800)).not.toContain("~est");
  });
});

// ---------------------------------------------------------------------------
// Geography map JSON safety (Task 9): jsonForScript must neutralize
// "</script>" inside a country label before it lands inline in a <script>
// block. Not exploitable today (cf.country is trusted), but the escaping
// must hold for any value routed through this helper.
// ---------------------------------------------------------------------------

describe("geography map JSON safety (jsonForScript, Task 9)", () => {
  it("escapes </script> inside a country label instead of leaking it verbatim", async () => {
    const evilRow: BreakdownRow = {
      label: "</script><img src=x>",
      pageviews: 10,
      visitors: 5,
      share: 1,
      sampled: false,
    };
    vi.mocked(queries.getTopCountries).mockResolvedValue([evilRow]);
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app/geography", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    // Plain JSON.stringify would emit this literally inside the inline
    // <script> block, letting the string's own "</script>" close the tag.
    expect(text).not.toContain("</script><img src=x>");
    // jsonForScript escapes the angle brackets to literal < / >
    // text, which stays valid JSON/JS but can no longer close the tag.
    expect(text).toContain("\\u003c/script\\u003e\\u003cimg src=x\\u003e");
  });
});

// ---------------------------------------------------------------------------
// /live — WebSocket (auth-gated)
// ---------------------------------------------------------------------------

describe("/live", () => {
  it("redirects unauthenticated requests to /login", async () => {
    // No cookie → requireAuth redirects before the WS upgrade check.
    const { res } = await fetch_(req("/live?site=site-001"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("redirects unauthenticated /live (no site param) to /login", async () => {
    const { res } = await fetch_(req("/live"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("returns 426 when authenticated but Upgrade header is missing", async () => {
    // Provide a valid signed cookie so requireAuth passes.
    // We sign a synthetic cookie using the test env's AUTH_COOKIE_SECRET.
    const secret = (env as { AUTH_COOKIE_SECRET?: string }).AUTH_COOKIE_SECRET ?? "test-secret";
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const payload = `1|${expiry}`;
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const sigHex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cookieVal = encodeURIComponent(`${payload}.${sigHex}`);

    const { res } = await fetch_(
      req("/live?site=site-001", {
        headers: { Cookie: `skopia_session=${cookieVal}` },
      }),
    );
    expect(res.status).toBe(426);
  });
});

// ---------------------------------------------------------------------------
// /app/devices (Theme A)
// ---------------------------------------------------------------------------

describe("/app/devices", () => {
  it("redirects to /login when unauthenticated", async () => {
    const { res } = await fetch_(req("/app/devices"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders device, browser and OS panels when authed", async () => {
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app/devices", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    expect(text).toContain("Device type");
    expect(text).toContain("Browser");
    expect(text).toContain("Operating system");
    expect(text).toContain("desktop"); // MOCK_DEVICES row rendered
  });

  it("sidebar nav carries a Devices link preserving site & range", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app?range=7d", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain('href="/app/devices?site=site-001&range=7d"');
  });

  it("mobile tab bar keeps exactly 4 tabs; Devices lives in the More sheet", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    // The tab bar renders the first four views as tabs only; overflow views
    // render as full-label links inside the <details> More sheet — so Devices
    // must appear after the <details> marker, not before it.
    const tabbarStart = text.indexOf('class="mobile-tabbar"');
    const moreStart = text.indexOf('<details class="mobile-more"', tabbarStart);
    expect(moreStart).toBeGreaterThan(tabbarStart);
    const tabsSection = text.slice(tabbarStart, moreStart);
    const moreSection = text.slice(moreStart);
    expect(tabsSection).toContain(">Geo</a>");
    expect(tabsSection).not.toContain(">Devices</a>");
    expect(moreSection).toContain(">Devices</a>");
  });
});

// ---------------------------------------------------------------------------
// /app/campaigns (Theme A)
// ---------------------------------------------------------------------------

describe("/app/campaigns", () => {
  it("redirects to /login when unauthenticated", async () => {
    const { res } = await fetch_(req("/app/campaigns"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders UTM source, medium and campaign panels when authed", async () => {
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app/campaigns", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    expect(text).toContain("UTM source");
    expect(text).toContain("UTM medium");
    expect(text).toContain("UTM campaign");
    expect(text).toContain("newsletter"); // MOCK_UTM row rendered
  });

  it("sidebar nav carries a Campaigns link preserving site & range", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app?range=7d", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain('href="/app/campaigns?site=site-001&range=7d"');
  });
});

// ---------------------------------------------------------------------------
// /app/events (Theme A)
// ---------------------------------------------------------------------------

describe("/app/events", () => {
  it("redirects to /login when unauthenticated", async () => {
    const { res } = await fetch_(req("/app/events"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders the events table with honest Count column when authed", async () => {
    const cookieVal = await authedCookie();
    const { res, text } = await fetch_(
      req("/app/events", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(res.status).toBe(200);
    expect(text).toContain("signup");
    expect(text).toContain("download");
    // For dimension='event' the pageviews column counts fires, so the header
    // must say Count, not Pageviews.
    expect(text).toContain("Count");
  });

  it("shows instrument-it copy when there are no events", async () => {
    vi.mocked(queries.getTopEvents).mockResolvedValue([]);
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app/events", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain("No custom events in this period");
    expect(text).toContain("skopia(&#39;event&#39;");
  });

  it("sidebar nav carries an Events link preserving site & range", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app?range=7d", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain('href="/app/events?site=site-001&range=7d"');
  });
});

// ---------------------------------------------------------------------------
// Live top-pages panel (Theme A)
// ---------------------------------------------------------------------------

describe("live top-pages panel", () => {
  it("Overview renders the live-pages panel container", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).toContain("Active pages right now");
    expect(text).toContain('id="live-pages-list"');
  });

  it("live script consumes topPages and builds DOM safely (no innerHTML)", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    const script = text.slice(text.indexOf("function connect()"));
    expect(script).toContain("d.topPages");
    // Paths are visitor-controlled input: rows must be built via
    // createElement/textContent, never innerHTML string concatenation.
    expect(script).toContain("textContent=p.label");
    expect(script).not.toContain("innerHTML+=");
  });

  it("non-Overview pages do not render the panel (script no-ops via null check)", async () => {
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app/pages", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    expect(text).not.toContain('id="live-pages-list"');
  });

  it("live script pings the socket on an interval to refresh a stale live count", async () => {
    // Eviction is lazy server-side (site-live.ts currentSnapshot()): without a
    // client-driven ping, a dashboard left open would show a stale count
    // forever once a visitor leaves and no further site-wide traffic arrives.
    const cookieVal = await authedCookie();
    const { text } = await fetch_(
      req("/app", { headers: { Cookie: `skopia_session=${cookieVal}` } }),
    );
    const script = text.slice(text.indexOf("function connect()"));
    expect(script).toContain("setInterval(function(){");
    expect(script).toContain("ws.send('ping')");
    // The timer must be torn down on close so a reconnect doesn't leak a
    // second ping loop stacked on top of the old one.
    expect(script).toContain("clearInterval(pingTimer)");
  });
});

/**
 * Skopia — public share-link surface (`/share/:token`) tests (launch-readiness
 * Task 1: docs/plans/2026-07-05-launch-readiness.md).
 *
 * `/share/:token` is a logged-out, read-only, single-site view. Security
 * invariants under test (ADR-0012 / Global Constraints 4-5):
 *   - valid token → 200, overview content, header/body nonce match
 *   - unknown, malformed-shape, and revoked tokens → byte-identical 404s
 *   - malformed-shape tokens never reach the DB (shape pre-filter runs first)
 *   - no Set-Cookie, ever
 *   - no listSites call, no /app or /login hrefs, no site-switcher markup
 *   - no live WebSocket client on the public surface
 *   - unauthenticated /live stays auth-gated (roadmap-7 regression)
 *
 * src/db/queries.ts is mocked exactly as test/dashboard/dashboard.test.ts does.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BreakdownRow, SiteRow, StatCards, TimeSeriesPoint } from "../../src/shared/types";

const MOCK_SITE: SiteRow = {
  id: "site-001",
  name: "test.dev",
  domain: "test.dev",
  origin_allowlist: "https://test.dev",
  public_token: `shr_${"a".repeat(43)}`,
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

const VALID_TOKEN = MOCK_SITE.public_token as string;

beforeEach(() => {
  // Clear call history between tests — several tests assert exact call
  // counts on getSiteByPublicToken (the shape pre-filter must never call it).
  vi.clearAllMocks();
  vi.mocked(queries.getOwner).mockResolvedValue(null);
  vi.mocked(queries.listSites).mockResolvedValue([MOCK_SITE]);
  vi.mocked(queries.getSite).mockResolvedValue(MOCK_SITE);
  // getSiteByPublicToken resolves the mock site only for the exact valid
  // token — every other value (including shape-valid-but-unknown tokens)
  // resolves null, same as an unknown or revoked token would in D1.
  vi.mocked(queries.getSiteByPublicToken).mockImplementation(async (_db, token) =>
    token === VALID_TOKEN ? MOCK_SITE : null,
  );
  vi.mocked(queries.getStatCards).mockResolvedValue(MOCK_CARDS);
  vi.mocked(queries.getTimeSeries).mockResolvedValue(MOCK_SERIES);
  vi.mocked(queries.getTopPages).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopSources).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopCountries).mockResolvedValue(MOCK_BREAKDOWN);
});

// ---------------------------------------------------------------------------
// GET /share/:token
// ---------------------------------------------------------------------------

describe("GET /share/:token", () => {
  it("valid token: 200 with overview stat cards, site name, and a header nonce matching the baked body nonce", async () => {
    const { res, text } = await fetch_(req(`/share/${VALID_TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    expect(text).toContain("test.dev");
    // fmtNum(1200) = "1.2K", fmtNum(5000) = "5K" — stat cards from mock data.
    expect(text).toContain("1.2K");
    expect(text).toContain("5K");

    const csp = res.headers.get("content-security-policy") ?? "";
    const headerNonce = csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
    const bodyNonce = text.match(/nonce="([a-f0-9]+)"/)?.[1];
    expect(headerNonce).toBeTruthy();
    expect(headerNonce).toBe(bodyNonce);
  });

  // Migrated from the old /public/:token suite (dashboard.test.ts):
  // read-only badge, breakdown cards, and range picker carry over unchanged.
  it("renders the read-only badge, top-pages/top-sources breakdown, and the range picker", async () => {
    const { text } = await fetch_(req(`/share/${VALID_TOKEN}`));
    expect(text).toContain("read-only");
    expect(text).toContain("/home");
    expect(text).toContain("Top pages");
    expect(text).toContain("Top sources");
    expect(text).toContain("Last 30 days");
  });

  it("404s unknown and malformed tokens with byte-identical bodies; malformed shapes never reach the DB", async () => {
    const shapeValidButUnknown = `shr_${"b".repeat(43)}`; // well-formed, not in DB
    const wrongLength = `shr_${"a".repeat(10)}`; // malformed: wrong length
    const noShrPrefix = "not-a-share-token-xxxxxxxxxxxxxxxxxxxxxxx"; // malformed: no shr_ prefix

    const unknown = await fetch_(req(`/share/${shapeValidButUnknown}`));
    const short = await fetch_(req(`/share/${wrongLength}`));
    const noPrefix = await fetch_(req(`/share/${noShrPrefix}`));

    for (const { res } of [unknown, short, noPrefix]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect(short.text).toBe(unknown.text);
    expect(noPrefix.text).toBe(unknown.text);

    // Only the shape-valid token reaches getSiteByPublicToken — the two
    // malformed shapes are rejected by the pre-filter before any D1 read.
    expect(queries.getSiteByPublicToken).toHaveBeenCalledTimes(1);
    expect(queries.getSiteByPublicToken).toHaveBeenCalledWith(
      expect.anything(),
      shapeValidButUnknown,
    );
  });

  it("revoked token (previously valid, now resolves null) 404s the same way as unknown", async () => {
    vi.mocked(queries.getSiteByPublicToken).mockResolvedValueOnce(null);
    const { res, text } = await fetch_(req(`/share/${VALID_TOKEN}`));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(text).not.toContain("test.dev");
  });

  it("never sets a Set-Cookie header, on success or on 404", async () => {
    const ok = await fetch_(req(`/share/${VALID_TOKEN}`));
    expect(ok.res.headers.get("set-cookie")).toBeNull();

    const notFound = await fetch_(req(`/share/shr_${"z".repeat(43)}`));
    expect(notFound.res.headers.get("set-cookie")).toBeNull();
  });

  it("never calls listSites and excludes /app, /login, and site-switcher markup", async () => {
    const { text } = await fetch_(req(`/share/${VALID_TOKEN}`));
    expect(queries.listSites).not.toHaveBeenCalled();
    expect(text).not.toContain('href="/app"');
    expect(text).not.toContain("/login");
    expect(text).not.toContain("js-site-switcher");
  });

  it("never renders a live WebSocket client", async () => {
    const { text } = await fetch_(req(`/share/${VALID_TOKEN}`));
    expect(text).not.toContain("new WebSocket(");
    expect(text).not.toContain("/live?site=");
  });
});

// ---------------------------------------------------------------------------
// Task 2 — read-through cache + server-rendered "online now" count
//
// The share overview is fronted by a two-tier read-through cache (Cache API
// over the CACHE KV namespace), keyed by site id (Global Constraint 6). A cache
// hit replays the exact stored Response — body AND the nonce baked into both the
// CSP header and the inline scripts — so the second GET of a URL carries the
// same nonce the first minted. The "online now" count is read once, server-side,
// via a single SITE_LIVE snapshot() RPC (never a public WebSocket); a snapshot
// failure degrades to no badge, never a 500.
// ---------------------------------------------------------------------------

/**
 * Minimal SITE_LIVE namespace stub: routes `.get(idFromName(id)).snapshot()` to
 * the supplied resolver so a test controls the live count (or forces a throw)
 * without standing up a real DO. Assign onto `env.SITE_LIVE`; the afterEach
 * restores the real binding.
 */
function stubSiteLive(snapshot: () => Promise<{ visitors: number; topPages: never[] }>) {
  return {
    idFromName: (name: string) => name,
    get: () => ({ snapshot }),
  };
}

describe("GET /share/:token — read-through cache + online-now (Task 2)", () => {
  let realSiteLive: typeof env.SITE_LIVE;

  beforeEach(() => {
    realSiteLive = env.SITE_LIVE;
  });
  afterEach(() => {
    (env as { SITE_LIVE: unknown }).SITE_LIVE = realSiteLive;
  });

  // Give a share request a site with a test-unique id (Global Constraint 7 —
  // the Workers pool shares KV/cache state within a file run, and the cache key
  // is keyed by site id, so unique ids keep each test's cache entry its own).
  function useSite(id: string, token: string): void {
    const site: SiteRow = { ...MOCK_SITE, id, name: `${id}.dev`, public_token: token };
    vi.mocked(queries.getSiteByPublicToken).mockImplementation(async (_db, t) =>
      t === token ? site : null,
    );
  }

  it("serves the second GET from cache: header and body carry the SAME nonce", async () => {
    const token = `shr_${"c".repeat(43)}`;
    useSite("site-cache-hit", token);
    (env as { SITE_LIVE: unknown }).SITE_LIVE = stubSiteLive(async () => ({
      visitors: 0,
      topPages: [],
    }));

    const first = await fetch_(req(`/share/${token}`));
    const second = await fetch_(req(`/share/${token}`));

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);

    const nonceOf = (csp: string | null) => (csp ?? "").match(/'nonce-([a-f0-9]+)'/)?.[1];
    const n1 = nonceOf(first.res.headers.get("content-security-policy"));
    const n2 = nonceOf(second.res.headers.get("content-security-policy"));
    const bodyNonce2 = second.text.match(/nonce="([a-f0-9]+)"/)?.[1];

    expect(n1).toBeTruthy();
    // Fresh renders mint a fresh nonce each time; a stable nonce across two
    // requests proves the second was served from cache, not re-rendered.
    expect(n2).toBe(n1);
    expect(bodyNonce2).toBe(n1);
    // The whole cached body is replayed byte-for-byte.
    expect(second.text).toBe(first.text);
  });

  it("200 responses carry Cache-Control: public, s-maxage=60", async () => {
    const token = `shr_${"d".repeat(43)}`;
    useSite("site-cache-cc", token);
    (env as { SITE_LIVE: unknown }).SITE_LIVE = stubSiteLive(async () => ({
      visitors: 0,
      topPages: [],
    }));

    const { res } = await fetch_(req(`/share/${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
  });

  it("renders the online-now badge from the SITE_LIVE snapshot count", async () => {
    const token = `shr_${"e".repeat(43)}`;
    useSite("site-live-count", token);
    (env as { SITE_LIVE: unknown }).SITE_LIVE = stubSiteLive(async () => ({
      visitors: 7,
      topPages: [],
    }));

    const { res, text } = await fetch_(req(`/share/${token}`));
    expect(res.status).toBe(200);
    expect(text).toContain("7 online now");
  });

  it("degrades to 200 with no online-now badge when the snapshot RPC throws", async () => {
    const token = `shr_${"f".repeat(43)}`;
    useSite("site-live-throws", token);
    (env as { SITE_LIVE: unknown }).SITE_LIVE = stubSiteLive(async () => {
      throw new Error("DO unreachable");
    });

    const { res, text } = await fetch_(req(`/share/${token}`));
    expect(res.status).toBe(200);
    expect(text).not.toContain("online now");
  });
});

// ---------------------------------------------------------------------------
// Roadmap-7 regression: /live stays auth-gated regardless of /share/* existing
// ---------------------------------------------------------------------------

describe("/live stays auth-gated", () => {
  it("unauthenticated GET /live?site=x redirects to /login", async () => {
    const { res } = await fetch_(req("/live?site=x"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

/**
 * Skopia — dashboard accessibility (WCAG 2.2 AA + mobile) structural tests.
 *
 * Renders the auth forms (/login, /setup), the public share surface
 * (/share/:token overview + /share/:token/pages), and an authed /app view,
 * then PARSES the HTML with node-html-parser and asserts on structure via
 * selectors — not brittle substring bans. Covers the approved a11y plan:
 * one <h1> per page, no skipped heading levels, landmarks (<main>, labelled
 * <nav>, <header>), label/for↔input/id pairs, native <table> breakdowns with
 * <th scope> inside a scrollable wrapper, aria-live live regions, a decorative
 * (aria-hidden) chart <svg> backed by a .sr-only data <table>, the focus /
 * sr-only / reduced-motion CSS utilities, muted-text contrast, and fluid
 * (max-width) auth cards.
 *
 * src/db/queries.ts is mocked exactly as test/dashboard/*.test.ts does.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { type HTMLElement, parse } from "node-html-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BreakdownRow,
  SiteRow,
  StatCards,
  TimeSeriesPoint,
  UserRow,
} from "../src/shared/types";

const VALID_TOKEN = `shr_${"a".repeat(43)}`;

const MOCK_SITE: SiteRow = {
  id: "site-a11y",
  name: "test.dev",
  domain: "test.dev",
  origin_allowlist: "https://test.dev",
  public_token: VALID_TOKEN,
  created_at: 1700000000,
};

const MOCK_OWNER: UserRow = {
  id: 1,
  email: "owner@test.dev",
  pw_hash: "pbkdf2:100000:aabbccdd:eeff0011",
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

vi.mock("../src/db/queries", () => ({
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

import * as queries from "../src/db/queries";
import worker from "../src/index";

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

async function render(
  path: string,
  opts?: RequestInit,
): Promise<{ res: Response; text: string; root: HTMLElement }> {
  const { res, text } = await fetch_(req(path, opts));
  return { res, text, root: parse(text) };
}

/** Sign a valid session cookie using the test env's AUTH_COOKIE_SECRET. */
async function authedCookie(): Promise<string> {
  const secret =
    (env as { AUTH_COOKIE_SECRET?: string }).AUTH_COOKIE_SECRET ?? "test-cookie-secret";
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

/** Heading levels in document order, e.g. [1, 2, 2, 2]. */
function headingLevels(root: HTMLElement): number[] {
  return root
    .querySelectorAll("h1,h2,h3,h4,h5,h6")
    .map((h) => Number(String(h.tagName).replace(/\D/g, "")));
}

/** No heading level skips deeper than +1 from the previous heading. */
function noSkippedLevels(levels: number[]): boolean {
  if (levels.length === 0) return true;
  if (levels[0] !== 1) return false;
  for (let i = 1; i < levels.length; i++) {
    if ((levels[i] as number) - (levels[i - 1] as number) > 1) return false;
  }
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
  vi.mocked(queries.listSites).mockResolvedValue([MOCK_SITE]);
  vi.mocked(queries.getSite).mockResolvedValue(MOCK_SITE);
  vi.mocked(queries.getSiteByPublicToken).mockImplementation(async (_db, token) =>
    token === VALID_TOKEN ? MOCK_SITE : null,
  );
  vi.mocked(queries.getStatCards).mockResolvedValue(MOCK_CARDS);
  vi.mocked(queries.getTimeSeries).mockResolvedValue(MOCK_SERIES);
  vi.mocked(queries.getTopPages).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopSources).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopCountries).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopDevices).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopBrowsers).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopOperatingSystems).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopUtmSources).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopUtmMediums).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopUtmCampaigns).mockResolvedValue(MOCK_BREAKDOWN);
  vi.mocked(queries.getTopEvents).mockResolvedValue(MOCK_BREAKDOWN);
});

// ---------------------------------------------------------------------------
// Heading structure — exactly one <h1> per page, no skipped levels (1.3.1)
// ---------------------------------------------------------------------------

describe("heading structure", () => {
  it("/login has exactly one <h1> and no skipped heading levels", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
    const { root } = await render("/login");
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(noSkippedLevels(headingLevels(root))).toBe(true);
  });

  it("/setup has exactly one <h1> and no skipped heading levels", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const { root } = await render("/setup");
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(noSkippedLevels(headingLevels(root))).toBe(true);
  });

  it("/share/:token overview has exactly one <h1> and no skipped heading levels", async () => {
    const { root } = await render(`/share/${VALID_TOKEN}`);
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    const levels = headingLevels(root);
    expect(levels.length).toBeGreaterThan(1); // h1 + card h2s
    expect(noSkippedLevels(levels)).toBe(true);
  });

  it("authed /app has exactly one <h1> and no skipped heading levels", async () => {
    const { root } = await render("/app", {
      headers: { Cookie: `skopia_session=${await authedCookie()}` },
    });
    const h1s = root.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(noSkippedLevels(headingLevels(root))).toBe(true);
    // The h1 must NOT live inside a breakpoint-hidden container (.mobile-only is
    // display:none on desktop) — otherwise desktop AT users get no heading at
    // all, which a CSS-blind parser would still count as "one h1".
    for (let anc = h1s[0]?.parentNode ?? null; anc; anc = anc.parentNode ?? null) {
      expect(anc.getAttribute?.("class") ?? "").not.toContain("mobile-only");
    }
  });
});

// ---------------------------------------------------------------------------
// Landmarks — <main>, labelled <nav> (distinct), <header> (2.4.1 / 1.3.1)
// ---------------------------------------------------------------------------

describe("landmarks", () => {
  it("/login and /setup wrap content in a <main>", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
    const login = await render("/login");
    expect(login.root.querySelector("main")).toBeTruthy();

    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const setup = await render("/setup");
    expect(setup.root.querySelector("main")).toBeTruthy();
  });

  it("/share has <main>, a <header>, and a single labelled <nav>", async () => {
    const { root } = await render(`/share/${VALID_TOKEN}`);
    expect(root.querySelector("main")).toBeTruthy();
    expect(root.querySelector("header")).toBeTruthy();
    const navs = root.querySelectorAll("nav");
    expect(navs.length).toBeGreaterThanOrEqual(1);
    for (const nav of navs) {
      expect(nav.getAttribute("aria-label")?.trim()).toBeTruthy();
    }
  });

  it("authed /app has <main>, <header>, and two <nav>s with DISTINCT aria-labels", async () => {
    const { root } = await render("/app", {
      headers: { Cookie: `skopia_session=${await authedCookie()}` },
    });
    expect(root.querySelector("main")).toBeTruthy();
    expect(root.querySelector("header")).toBeTruthy();
    const labels = root.querySelectorAll("nav").map((n) => n.getAttribute("aria-label") ?? "");
    expect(labels.length).toBe(2); // desktop sidebar + mobile tab bar
    for (const l of labels) expect(l.trim()).toBeTruthy();
    expect(new Set(labels).size).toBe(labels.length); // distinct
  });

  it("marks the active nav link with aria-current='page'", async () => {
    const { root } = await render(`/share/${VALID_TOKEN}`);
    const current = root.querySelectorAll("[aria-current='page']");
    expect(current.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Forms — every field has a <label for=X> matching an <input id=X> (1.3.1)
// ---------------------------------------------------------------------------

function assertLabelledInputs(root: HTMLElement): void {
  const inputs = root.querySelectorAll("input").filter((i) => i.getAttribute("type") !== "hidden");
  expect(inputs.length).toBeGreaterThan(0);
  const labelFor = new Set(root.querySelectorAll("label[for]").map((l) => l.getAttribute("for")));
  for (const input of inputs) {
    const id = input.getAttribute("id");
    expect(id, "every visible input needs an id").toBeTruthy();
    expect(labelFor.has(id), `input#${id} needs a <label for="${id}">`).toBe(true);
  }
}

describe("forms", () => {
  it("/login: each field has a <label for> matching its <input id>", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
    const { root } = await render("/login");
    assertLabelledInputs(root);
  });

  it("/setup: each field has a <label for> matching its <input id>", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const { root } = await render("/setup");
    assertLabelledInputs(root);
  });

  it("a failed /login POST flags the error with role=alert and preserves the email", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
    const { root } = await render("/login", {
      method: "POST",
      body: new URLSearchParams({ email: "typo@test.dev", password: "wrong" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const alert = root.querySelector("[role='alert']");
    expect(alert).toBeTruthy();
    const alertId = alert?.getAttribute("id");
    expect(alertId).toBeTruthy();
    // The email input keeps what was typed and points at the error.
    const email = root.querySelector("input[type='email']");
    expect(email?.getAttribute("value")).toBe("typo@test.dev");
    expect(email?.getAttribute("aria-describedby")).toBe(alertId);
    expect(email?.getAttribute("aria-invalid")).toBe("true");
  });

  it("a /setup password mismatch flags only the password fields, not the valid email", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const { root } = await render("/setup", {
      method: "POST",
      body: new URLSearchParams({
        email: "new@test.dev",
        password: "longenough",
        confirm: "different",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    // The email was valid — it must NOT be announced as invalid.
    expect(root.querySelector("#setup-email")?.getAttribute("aria-invalid")).toBeFalsy();
    expect(root.querySelector("#setup-password")?.getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector("#setup-confirm")?.getAttribute("aria-invalid")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Breakdown table — native <table> + <th scope> inside a scrollable wrapper
// (1.3.1 / 1.4.10)
// ---------------------------------------------------------------------------

describe("breakdown table", () => {
  it("/share/:token/pages renders a native <table> with <th scope='col'> in an overflow-x:auto wrapper", async () => {
    const { root } = await render(`/share/${VALID_TOKEN}/pages`);
    const table = root
      .querySelectorAll("table")
      .find((t) => !(t.getAttribute("class") ?? "").includes("sr-only"));
    expect(table, "a visible breakdown <table>").toBeTruthy();
    const ths = table?.querySelectorAll("th[scope='col']") ?? [];
    expect(ths.length).toBeGreaterThanOrEqual(2);
    // The table sits inside a keyboard-focusable horizontal-scroll container.
    let el: HTMLElement | null = table?.parentNode ?? null;
    let scroller: HTMLElement | null = null;
    while (el) {
      if ((el.getAttribute?.("style") ?? "").includes("overflow-x:auto")) {
        scroller = el;
        break;
      }
      el = el.parentNode ?? null;
    }
    expect(scroller, "table wrapped in overflow-x:auto container").toBeTruthy();
    expect(scroller?.getAttribute("tabindex")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Live regions — aria-live on the live badge + live-pages list (4.1.3)
// ---------------------------------------------------------------------------

describe("live regions", () => {
  it("authed /app puts aria-live on the live badge and the live-pages list", async () => {
    const { root } = await render("/app", {
      headers: { Cookie: `skopia_session=${await authedCookie()}` },
    });
    const badge = root.querySelector("#live-badge");
    expect(badge?.getAttribute("aria-live")).toBeTruthy();
    const list = root.querySelector("#live-pages-list");
    expect(list?.getAttribute("aria-live")).toBeTruthy();
    // The list is a <ul>, so the live script must append <li> rows.
    expect(list?.tagName?.toLowerCase()).toBe("ul");
  });
});

// ---------------------------------------------------------------------------
// Chart — decorative <svg> is aria-hidden; a .sr-only <table> carries the data
// (1.1.1); toggle buttons expose aria-pressed (4.1.2)
// ---------------------------------------------------------------------------

describe("chart accessibility", () => {
  it("/share overview hides the decorative chart <svg> and exposes a .sr-only data <table>", async () => {
    const { root } = await render(`/share/${VALID_TOKEN}`);
    const svg = root.querySelector("#chart-svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // Not also role=img — avoids double-announcement alongside the table.
    expect(svg?.getAttribute("role")).toBeFalsy();
    const srTable = root.querySelector("table.sr-only");
    expect(srTable, "visually-hidden chart data table").toBeTruthy();
    expect(srTable?.querySelectorAll("th[scope]").length).toBeGreaterThanOrEqual(1);
    // One data row per series point (MOCK_SERIES has 3).
    expect(srTable?.querySelectorAll("tbody tr")).toHaveLength(MOCK_SERIES.length);
  });

  it("chart toggle buttons carry aria-pressed reflecting the active metric", async () => {
    const { root } = await render(`/share/${VALID_TOKEN}`);
    expect(root.querySelector("#btn-visitors")?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("#btn-pageviews")?.getAttribute("aria-pressed")).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// CSS utilities — focus-visible, sr-only, reduced-motion guard live in BASE_CSS
// (2.4.7 / 2.3.3)
// ---------------------------------------------------------------------------

describe("BASE_CSS utilities", () => {
  it("ships :focus-visible, .sr-only, and a prefers-reduced-motion guard", async () => {
    const { root } = await render("/login");
    const css = root.querySelector("style")?.text ?? "";
    expect(css).toContain(":focus-visible");
    expect(css).toContain(".sr-only");
    expect(css).toContain("prefers-reduced-motion");
  });
});

// ---------------------------------------------------------------------------
// Contrast + fluid auth cards — muted text darkened; cards use max-width
// (1.4.3 / 1.4.10)
// ---------------------------------------------------------------------------

describe("contrast + responsive auth cards", () => {
  it("no #6a7184 muted text remains in any rendered surface", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
    const login = await render("/login");
    expect(login.text).not.toContain("#6a7184");

    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const setup = await render("/setup");
    expect(setup.text).not.toContain("#6a7184");

    const share = await render(`/share/${VALID_TOKEN}`);
    expect(share.text).not.toContain("#6a7184");

    const pages = await render(`/share/${VALID_TOKEN}/pages`);
    expect(pages.text).not.toContain("#6a7184");
  });

  it("auth cards use max-width, not a fixed width:360/400/440px", async () => {
    vi.mocked(queries.getOwner).mockResolvedValue(MOCK_OWNER);
    const login = await render("/login");
    // A fixed pixel width (not part of `max-width:`) must not appear.
    expect(login.text).not.toMatch(/(?<!max-)width:(?:360|400|440)px/);
    expect(login.text).toContain("max-width:360px");

    vi.mocked(queries.getOwner).mockResolvedValue(null);
    const setup = await render("/setup");
    expect(setup.text).not.toMatch(/(?<!max-)width:(?:360|400|440)px/);
    expect(setup.text).toContain("max-width:400px");
  });
});

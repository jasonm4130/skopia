/**
 * Skopia — dashboard Worker surface (SSR + auth + realtime proxy).
 *
 * Hono sub-app mounted at "/" by src/index.ts. Owns:
 *   /setup            — first-run owner account creation
 *   /login            — password login → signed-cookie session
 *   /logout           — clear session
 *   /app              — auth-gated Overview (redirects to /login when not authed)
 *   /app/pages        — auth-gated Pages breakdown
 *   /app/sources      — auth-gated Sources breakdown
 *   /app/geography    — auth-gated Geography breakdown
 *   /app/site/:id/*   — per-site sub-routes (same views filtered to one site)
 *   /share/:token     — public read-only single-site overview (no auth; ADR-0012)
 *   /live             — WebSocket proxy → SiteLive DO
 *
 * Auth (spec §7.2): HMAC-SHA256 signed HttpOnly cookie, Web Crypto only.
 * Never registers a bare "/" route — marketing pillar owns that.
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import {
  getOwner,
  getSiteByPublicToken,
  getStatCards,
  getTimeSeries,
  getTopBrowsers,
  getTopCountries,
  getTopDevices,
  getTopEvents,
  getTopOperatingSystems,
  getTopPages,
  getTopSources,
  getTopUtmCampaigns,
  getTopUtmMediums,
  getTopUtmSources,
  listSites,
} from "../db/queries";
import { requireSecrets, SecretsMissingError } from "../shared/config";
import { ensureSchema } from "../shared/schema";
import type { AppEnv } from "../shared/security-headers";
import type {
  BreakdownRow,
  DateRange,
  LiveSnapshot,
  SiteRow,
  StatCards,
  TimeSeriesPoint,
} from "../shared/types";

export { SiteLive } from "./site-live";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Dashboard env = the root AppEnv (Bindings + per-request nonce) plus the
// userId set by requireAuth. Keeps `c.get("nonce")` typed from the shared
// middleware while preserving the auth variable.
type DashEnv = {
  Bindings: AppEnv["Bindings"];
  Variables: AppEnv["Variables"] & { userId: number };
};

// ---------------------------------------------------------------------------
// Hono sub-app
// ---------------------------------------------------------------------------

export const dashboard = new Hono<DashEnv>();

// Cold-account D1 bootstrap. Registered first so it runs before any route
// handler (and before requireAuth) reads D1 — on a fresh account the migration
// has never run, so getOwner()'s SELECT would 500. ensureSchema is idempotent
// and cached per isolate, so this is cheap on warm requests.
dashboard.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = "skopia_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signCookie(userId: number, expiry: number, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const payload = `${userId}|${expiry}`;
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${payload}.${sigHex}`;
}

async function verifyCookie(value: string, secret: string): Promise<number | null> {
  const dotIdx = value.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payload = value.slice(0, dotIdx);
  const sigHex = value.slice(dotIdx + 1);
  const pipeIdx = payload.indexOf("|");
  if (pipeIdx === -1) return null;
  const userIdStr = payload.slice(0, pipeIdx);
  const expiryStr = payload.slice(pipeIdx + 1);
  const userId = parseInt(userIdStr, 10);
  const expiry = parseInt(expiryStr, 10);
  if (Number.isNaN(userId) || Number.isNaN(expiry)) return null;
  if (Date.now() > expiry) return null;

  const key = await getHmacKey(secret);
  const enc = new TextEncoder();

  // Decode the submitted signature hex to bytes.
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
  if (sigBytes.length === 0) return null;

  // Platform constant-time HMAC verify (avoids manual hex comparison).
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
  return valid ? userId : null;
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((c) => {
      const eq = c.indexOf("=");
      return eq === -1
        ? [c.trim(), ""]
        : [c.slice(0, eq).trim(), decodeURIComponent(c.slice(eq + 1).trim())];
    }),
  );
}

// The Workers runtime caps PBKDF2 at 100k iterations — a runtime policy, not
// a compat-dated behavior (enforcement reached production ~2026-07 and turned
// every login into a 500 while this code asked for 210k). Local workerd does
// NOT enforce the cap, so tests can't catch a raise; the verify clamp below is
// the guard. Higher work factors aren't available in Workers WebCrypto.
const PBKDF2_ITERATIONS = 100_000;

async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  // Derive a 32-byte salt via random bytes, then PBKDF2 for the hash.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2:")) return false;
  const parts = stored.split(":");
  let iterations: number;
  let saltHex: string;
  let expectedHex: string;
  if (parts.length === 4) {
    // v2 format: pbkdf2:<iterations>:<salt>:<hash>
    iterations = Number(parts[1]);
    saltHex = parts[2] as string;
    expectedHex = parts[3] as string;
  } else if (parts.length === 3) {
    // Legacy v1 format (no embedded count): those hashes were derived at 100k.
    iterations = 100_000;
    saltHex = parts[1] as string;
    expectedHex = parts[2] as string;
  } else {
    return false;
  }
  // Never derive above the runtime cap — deriveBits would throw in production
  // (NotSupportedError), turning a bad stored hash into a 500 instead of a 401.
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  let bits: ArrayBuffer;
  try {
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256,
    );
  } catch {
    // Any future runtime policy change degrades to "invalid credentials",
    // never a 500.
    return false;
  }
  const hashHex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time compare
  if (hashHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hashHex.length; i++) {
    diff |= hashHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

/** Escape a string for safe insertion into HTML text content or attributes. */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for safe embedding inside an inline `<script>` block.
 * `JSON.stringify` does not neutralize "</script>" (or a literal U+2028 /
 * U+2029 line separator) inside a string value — an attacker-controlled
 * value could otherwise close the script tag early. Escaping the TEXT of
 * the JSON output (not the runtime characters) keeps it valid JSON/JS.
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Fixed PBKDF2 hash burned at module load so a wrong-email login still pays
// the same cost as a wrong-password login (timing oracle fix). Generated
// once with hashPassword(); the password behind it was discarded and is
// never a real account's.
const DUMMY_PW_HASH =
  "pbkdf2:100000:524fefbac9c6134c2670b09d5e378de5:35fbc1405f9293d4a7caff3c4a0cb75beb6999be6b2e9ee09e775e1f3726388a";

// ---------------------------------------------------------------------------
// Date-range helpers
// ---------------------------------------------------------------------------

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function parseRange(
  param: string | null | undefined,
): DateRange & { label: string; key: string } {
  // `to` is today and the SQL window is inclusive on both ends, so "Last N days"
  // = today and the N-1 days before it. daysAgo(N) would span N+1 days.
  const ranges: Record<string, { from: () => string; label: string }> = {
    "7d": { from: () => daysAgo(6), label: "Last 7 days" },
    "30d": { from: () => daysAgo(29), label: "Last 30 days" },
    "90d": { from: () => daysAgo(89), label: "Last 90 days" },
  };
  const key = param && ranges[param] ? param : "30d";
  const selected = ranges[key] ?? ranges["30d"]!;
  const to = todayUtc();
  const from = selected.from();
  return { from, to, label: selected.label, key };
}

// ---------------------------------------------------------------------------
// Formatting helpers (server-side counterpart to the design's fmt())
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtPct(r: number): string {
  return `${Math.round(r * 100)}%`;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function requireAuth(c: Context<DashEnv>, next: Next): Promise<Response | void> {
  // Fail closed: on a cold deploy AUTH_COOKIE_SECRET may be unset. Reading a
  // stale session cookie would pass undefined/"" into the HMAC import and throw
  // an unhandled 500. Guard before touching the cookie and surface a clear
  // "not configured" page instead.
  try {
    requireSecrets(c.env, ["AUTH_COOKIE_SECRET"]);
  } catch (err) {
    if (err instanceof SecretsMissingError) {
      return c.html(notConfiguredPage(c.get("nonce"), err.missing), 500);
    }
    throw err;
  }

  const cookies = parseCookies(c.req.header("cookie") ?? null);
  const cookieVal = cookies[COOKIE_NAME];
  if (cookieVal) {
    const userId = await verifyCookie(cookieVal, c.env.AUTH_COOKIE_SECRET);
    if (userId !== null) {
      c.set("userId", userId);
      return next();
    }
  }
  return c.redirect("/login");
}

// ---------------------------------------------------------------------------
// Layout / shared HTML
// ---------------------------------------------------------------------------

// Self-hosted @font-face — vendored woff2 served from /fonts by the Workers
// Static Assets layer (Task 3). Zero third-party requests: no Google Fonts.
// One @font-face per weight/subset; unicode-range lets the browser fetch only
// the latin or latin-ext file it needs. font-display:swap avoids FOIT.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

function fontFace(family: string, file: string, weight: number, range: string): string {
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('/fonts/${file}.woff2') format('woff2');unicode-range:${range};}`;
}

function fontFaces(family: string, prefix: string, weights: number[]): string {
  return weights
    .flatMap((w) => [
      fontFace(family, `${prefix}-${w}-latin`, w, LATIN),
      fontFace(family, `${prefix}-${w}-latin-ext`, w, LATIN_EXT),
    ])
    .join("");
}

const FONT_FACES = [
  fontFaces("Space Grotesk", "space-grotesk", [400, 500, 600, 700]),
  fontFaces("Hanken Grotesk", "hanken-grotesk", [400, 500, 600, 700]),
  fontFaces("JetBrains Mono", "jetbrains-mono", [400, 500]),
].join("");

const BASE_CSS = `
  ${FONT_FACES}
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;background:#0a0c11;}
  body{font-family:'Hanken Grotesk',sans-serif;color:#e8eaef;}
  a{color:inherit;text-decoration:none;}
  input,button,select,textarea{font-family:inherit;}
  ::-webkit-scrollbar{width:10px;height:10px;}
  ::-webkit-scrollbar-thumb{background:#232838;border-radius:6px;}
  ::-webkit-scrollbar-track{background:transparent;}
  @keyframes skopiaPulse{0%,100%{opacity:1;}50%{opacity:.3;}}
  /* Mobile layout hooks — hidden on desktop; enabled in the @media block below. */
  .mobile-tabbar{display:none;}
  .mobile-only{display:none;}
  .mobile-more summary::-webkit-details-marker{display:none;}
  @media (max-width:768px){
    .dash-sidebar{display:none!important;}
    .mobile-only{display:flex!important;}
    .mobile-tabbar{display:flex!important;position:fixed;left:0;right:0;bottom:0;z-index:50;align-items:stretch;justify-content:space-around;background:rgba(13,16,22,.85);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid #1b1f29;padding:6px 4px calc(env(safe-area-inset-bottom,0px) + 8px);}
    .dash-topbar{padding:14px 16px!important;flex-wrap:wrap!important;gap:12px!important;}
    .dash-content{padding:16px 16px 84px!important;}
    .stat-grid{grid-template-columns:repeat(2,1fr)!important;}
    .breakdown-grid{grid-template-columns:1fr!important;}
    .geo-layout{flex-direction:column!important;}
    .geo-layout>div{flex:none!important;}
  }
`.trim();

function htmlDoc(title: string, head: string, body: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Skopia</title>
<style nonce="${nonce}">${BASE_CSS}</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sidebar & app layout
// ---------------------------------------------------------------------------

function skopiaLogo(): string {
  return `<div style="display:flex;flex-direction:column;gap:2px;">
    <div style="width:15px;height:2px;border-radius:2px;background:#4d86ff;"></div>
    <div style="width:11px;height:2px;border-radius:2px;background:#4d86ff;opacity:.7;"></div>
    <div style="width:13px;height:2px;border-radius:2px;background:#4d86ff;opacity:.45;"></div>
  </div>`;
}

const NAV_ITEMS = [
  { id: "overview", label: "Overview", href: "/app" },
  { id: "pages", label: "Pages", href: "/app/pages" },
  { id: "sources", label: "Sources", href: "/app/sources" },
  { id: "geography", label: "Geography", href: "/app/geography" },
  { id: "devices", label: "Devices", href: "/app/devices" },
  { id: "campaigns", label: "Campaigns", href: "/app/campaigns" },
  { id: "events", label: "Events", href: "/app/events" },
] as const;

// The mobile bottom bar fits 4 tabs + "More"; views past index 3 render as
// links inside the More sheet instead of tabs.
const MOBILE_TAB_COUNT = 4;

// Site switcher <select>. Shared by the desktop sidebar and the mobile top bar.
// Change events are wired by class (`.js-site-switcher`) from the nonced script
// in appLayout, so every instance works regardless of where it renders.
function siteSwitcher(
  sites: SiteRow[],
  siteId: string,
  rangeKey: string,
  opts: { id?: string; extraStyle?: string } = {},
): string {
  const idAttr = opts.id ? ` id="${opts.id}"` : "";
  const optionsHtml = sites
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === siteId ? " selected" : ""}>${esc(s.name)}</option>`,
    )
    .join("");
  return `<select${idAttr} class="js-site-switcher" data-range="${esc(rangeKey)}" aria-label="Switch site" style="${opts.extraStyle ?? ""}width:100%;cursor:pointer;font-size:13px;color:#e8eaef;background:#161a23;border:1px solid #232838;border-radius:9px;padding:10px 11px;appearance:none;-webkit-appearance:none;">${optionsHtml}</select>`;
}

// Health/status block. Shared by the desktop sidebar footer and the mobile
// "More" sheet.
function healthStatus(extraStyle = ""): string {
  return `<div style="${extraStyle}background:#161a23;border:1px solid #232838;border-radius:10px;padding:14px;">
      <div style="font-size:12px;color:#9aa1b2;line-height:1.5;margin-bottom:10px;">Running on your Worker. <span style="color:#2bd888;">Healthy.</span></div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;">skopia · d1 ok</div>
    </div>`;
}

// Fixed bottom tab bar — the mobile replacement for the sidebar. Hidden on
// desktop via `.mobile-tabbar{display:none}` in BASE_CSS; shown by the
// max-width:768px media query. First four items link the existing routes; the
// "More" <details> sheet (no JS) surfaces the sidebar footer (health status).
function mobileTabbar(activeView: string, siteId: string, rangeKey: string): string {
  const shortLabels: Record<string, string> = {
    overview: "Overview",
    pages: "Pages",
    sources: "Sources",
    geography: "Geo",
  };
  const tabs = NAV_ITEMS.slice(0, MOBILE_TAB_COUNT)
    .map(({ id, label, href }) => {
      const active = activeView === id;
      const fullHref = siteId
        ? `${href}?site=${esc(siteId)}&range=${esc(rangeKey)}`
        : `${href}?range=${esc(rangeKey)}`;
      const color = active ? "#9fb4ff" : "#8b92a4";
      const dot = active ? "background:#4d86ff;" : "border:1.5px solid #3a4150;";
      return `<a href="${fullHref}" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 2px;font-size:11px;color:${color};"><span style="width:16px;height:16px;border-radius:4px;${dot}"></span>${esc(shortLabels[id] ?? label)}</a>`;
    })
    .join("\n");

  // Views past MOBILE_TAB_COUNT render as full-label links in the More sheet.
  const moreLinks = NAV_ITEMS.slice(MOBILE_TAB_COUNT)
    .map(({ id, label, href }) => {
      const active = activeView === id;
      const fullHref = siteId
        ? `${href}?site=${esc(siteId)}&range=${esc(rangeKey)}`
        : `${href}?range=${esc(rangeKey)}`;
      return `<a href="${fullHref}" style="display:block;padding:12px 4px;font-size:14px;color:${active ? "#9fb4ff" : "#cfd4e0"};border-bottom:1px solid #161a22;">${esc(label)}</a>`;
    })
    .join("\n");

  return `<nav class="mobile-tabbar">
    ${tabs}
    <details class="mobile-more" style="flex:1;">
      <summary style="list-style:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 2px;font-size:11px;color:#8b92a4;cursor:pointer;height:100%;"><span style="width:16px;height:16px;border-radius:4px;border:1.5px solid #3a4150;"></span>More</summary>
      <div style="position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 58px);background:#0d1016;border-top:1px solid #1b1f29;padding:18px 16px calc(env(safe-area-inset-bottom,0px) + 18px);box-shadow:0 -14px 34px rgba(0,0,0,.5);">
        ${moreLinks ? `<div style="margin-bottom:14px;">${moreLinks}</div>` : ""}
        ${healthStatus()}
      </div>
    </details>
  </nav>`;
}

function sidebar(activeView: string, sites: SiteRow[], siteId: string, rangeKey: string): string {
  const navHtml = NAV_ITEMS.map(({ id, label, href }) => {
    const active = activeView === id;
    const style = [
      "display:flex;align-items:center;gap:11px;padding:10px 11px;border-radius:8px;",
      "cursor:pointer;font-size:13.5px;",
      active
        ? "font-weight:500;color:#9fb4ff;background:rgba(77,134,255,.12);"
        : "font-weight:400;color:#8b92a4;",
    ].join("");
    const dotStyle = active
      ? "width:14px;height:14px;border-radius:3px;background:#4d86ff;"
      : "width:14px;height:14px;border-radius:3px;border:1.5px solid #3a4150;";
    // Preserve the active range when navigating between views.
    const fullHref = siteId
      ? `${href}?site=${esc(siteId)}&range=${esc(rangeKey)}`
      : `${href}?range=${esc(rangeKey)}`;
    return `<a href="${fullHref}" style="${style}"><span style="${dotStyle}"></span>${esc(label)}</a>`;
  }).join("\n");

  // Site switcher: a <select> whose change event is wired by the nonced script
  // in appLayout (inline on* handlers are blocked by the strict CSP).
  const switcher = siteSwitcher(sites, siteId, rangeKey, { id: "skopia-site-switcher" });

  return `<div class="dash-sidebar" style="flex:none;width:224px;background:#0d1016;border-right:1px solid #1b1f29;padding:24px 16px;display:flex;flex-direction:column;height:100vh;position:sticky;top:0;">
    <div style="display:flex;align-items:center;gap:9px;padding:0 8px;margin-bottom:30px;">
      ${skopiaLogo()}
      <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">Skopia</span>
    </div>
    <div style="margin-bottom:24px;">${switcher}</div>
    ${navHtml}
    ${healthStatus("margin-top:auto;")}
  </div>`;
}

function appLayout(
  activeView: string,
  sites: SiteRow[],
  site: SiteRow,
  headerRight: string,
  content: string,
  nonce: string,
  rangeKey: string,
): string {
  // Wire the site switcher and range <select> change events here: the strict
  // CSP (script-src 'self' 'nonce' 'strict-dynamic', no script-src-attr) blocks
  // inline on* handlers, so these must be attached from a nonced script.
  const navScript = `<script nonce="${nonce}">(function(){
    var ss=document.querySelectorAll('.js-site-switcher');
    ss.forEach(function(s){s.addEventListener('change',function(){location.href='/app?site='+encodeURIComponent(s.value)+'&range='+encodeURIComponent(s.getAttribute('data-range')||'30d');});});
    var r=document.querySelector('select[name="range"]');
    if(r&&r.form){r.addEventListener('change',function(){r.form.submit();});}
  })();</script>`;
  return `<div style="display:flex;min-height:100vh;background:#0a0c11;">
  ${sidebar(activeView, sites, site.id, rangeKey)}
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
    <div class="dash-topbar" style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:20px 32px;border-bottom:1px solid #1b1f29;">
      <div class="mobile-only" style="flex-basis:100%;align-items:center;gap:10px;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex:none;">${skopiaLogo()}<span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#fff;">Skopia</span></div>
        <div style="flex:1;min-width:0;">${siteSwitcher(sites, site.id, rangeKey)}</div>
      </div>
      <div id="live-badge" style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#2bd888;background:rgba(43,216,136,.1);padding:8px 13px;border-radius:8px;font-weight:500;">
        <span style="width:7px;height:7px;border-radius:50%;background:#2bd888;animation:skopiaPulse 1.6s infinite;"></span>
        <span id="live-count">—</span> online now
      </div>
      ${headerRight}
    </div>
    <div class="dash-content" style="flex:1;overflow:auto;padding:28px 32px 40px;">
      ${content}
    </div>
  </div>
  ${mobileTabbar(activeView, site.id, rangeKey)}
  ${navScript}
</div>`;
}

// ---------------------------------------------------------------------------
// Range picker HTML (inline form)
// ---------------------------------------------------------------------------

function rangePicker(currentKey: string, extraParams: string): string {
  const options = [
    { key: "7d", label: "Last 7 days" },
    { key: "30d", label: "Last 30 days" },
    { key: "90d", label: "Last 90 days" },
  ];
  const optHtml = options
    .map(
      ({ key, label }) =>
        `<option value="${esc(key)}"${currentKey === key ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
  return `<form method="get" style="display:inline;">
    ${extraParams}
    <select name="range" style="cursor:pointer;font-size:13px;color:#cfd4e0;background:#12151d;border:1px solid #262b38;padding:8px 15px;border-radius:8px;appearance:none;-webkit-appearance:none;">
      ${optHtml}
    </select>
  </form>`;
}

// ---------------------------------------------------------------------------
// Stat cards HTML
// ---------------------------------------------------------------------------

// Shared with the breakdown table's Visitors column header — same caveat,
// same wording, wherever a "Visitors" figure is a sum of daily uniques.
const VISITORS_TOOLTIP =
  "Sum of each day's unique visitors. Someone who visits on several days is counted once per day, so multi-day totals run higher than true unique visitors.";

/** The "~est" badge for a metric derived from sampled (not exact) data. */
function sampledBadge(sampled: boolean): string {
  return sampled
    ? `<span title="Estimated from sampled data" style="font-size:10px;color:#9aa1b2;background:#1a1f2a;padding:2px 6px;border-radius:4px;margin-left:6px;">~est</span>`
    : "";
}

function statCardsHtml(cards: StatCards, sampled: boolean): string {
  // `tip` carries an honest caveat for the metrics that are not exact counts.
  // Rendered as a native title tooltip on an ⓘ glyph (no JS — CSP-safe).
  const items: { label: string; value: string; tip?: string }[] = [
    { label: "Visitors", value: fmtNum(cards.visitors), tip: VISITORS_TOOLTIP },
    { label: "Pageviews", value: fmtNum(cards.pageviews) },
    { label: "Views / Visitor", value: cards.viewsPerVisitor.toFixed(1) },
    {
      label: "Single-Page Visits",
      value: fmtPct(cards.bounceRate),
      tip: "Approximate. Estimated from pageviews and visitors, not per-session tracking.",
    },
  ];
  const badge = sampledBadge(sampled);
  const cardsHtml = items
    .map(
      ({ label, value, tip }) =>
        `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:18px 20px;">
      <div style="font-size:12.5px;color:#8b92a4;margin-bottom:10px;">${esc(label)}${
        tip
          ? ` <span title="${esc(tip)}" style="cursor:help;color:#6a7184;border-bottom:1px dotted #3a4150;">&#9432;</span>`
          : ""
      }</div>
      <div style="display:flex;align-items:baseline;gap:8px;">
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;color:#fff;letter-spacing:-.01em;">${esc(value)}${badge}</span>
      </div>
    </div>`,
    )
    .join("\n");
  return `<div class="stat-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;">${cardsHtml}</div>`;
}

// ---------------------------------------------------------------------------
// Time-series chart HTML (SVG area chart, server-rendered paths + client hover)
// ---------------------------------------------------------------------------

function timeSeriesChartHtml(
  series: TimeSeriesPoint[],
  rangeLabel: string,
  _siteId: string,
  _rangeKey: string,
  nonce: string,
): string {
  if (series.length === 0) {
    return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:60px 24px;text-align:center;margin-bottom:20px;">
      <span style="color:#6a7184;font-size:14px;">No data for this period.</span>
    </div>`;
  }

  // Serialize series to JSON for client-side hover interactions
  const seriesJson = JSON.stringify(
    series.map((p) => ({ day: p.day, v: p.visitors, pv: p.pageviews })),
  );

  // Compute SVG paths (server-side for SSR, client can update metric toggle)
  const VW = 1000,
    VH = 260,
    padT = 18,
    padB = 30;
  const plotH = VH - padT - padB;

  function computePaths(arr: number[]): { linePath: string; areaPath: string } {
    const n = arr.length;
    const lo = Math.min(...arr) * 0.72;
    const hi = Math.max(...arr) * 1.08 || 1;
    const X = (i: number) => (n > 1 ? (i / (n - 1)) * VW : 0);
    const Y = (val: number) => padT + (1 - (val - lo) / (hi - lo)) * plotH;
    const pts = arr.map((val, i) => ({ x: X(i), y: Y(val) }));
    const linePath = `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}`;
    const areaPath = `${linePath} L${VW},${VH - padB} L0,${VH - padB} Z`;
    return { linePath, areaPath };
  }

  const visitorsArr = series.map((p) => p.visitors);
  const { linePath, areaPath } = computePaths(visitorsArr);

  // Axis labels: up to 5 evenly spaced day labels
  const axisIndices =
    series.length <= 5
      ? series.map((_, i) => i)
      : [
          0,
          Math.floor(series.length / 4),
          Math.floor(series.length / 2),
          Math.floor((3 * series.length) / 4),
          series.length - 1,
        ];
  const axisLabels = axisIndices
    .map((i) => `<span>${esc(series[i]?.day.slice(5) ?? "")}</span>`)
    .join("");

  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:22px 24px;margin-bottom:20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
    <div style="display:flex;gap:7px;">
      <button id="btn-visitors" style="cursor:pointer;font-size:12.5px;font-weight:600;color:#fff;background:#4d86ff;padding:7px 14px;border-radius:7px;border:none;">Visitors</button>
      <button id="btn-pageviews" style="cursor:pointer;font-size:12.5px;font-weight:500;color:#9aa1b2;background:#1a1f2a;padding:7px 14px;border-radius:7px;border:none;">Pageviews</button>
    </div>
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;">${esc(rangeLabel)}</span>
  </div>
  <div style="position:relative;height:250px;" id="chart-wrap">
    <svg id="chart-svg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">
      <defs>
        <linearGradient id="areaDash" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#4d86ff" stop-opacity=".30"/>
          <stop offset="1" stop-color="#4d86ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="46" x2="${VW}" y2="46" stroke="#1a1f2a" stroke-width="1"/>
      <line x1="0" y1="110" x2="${VW}" y2="110" stroke="#1a1f2a" stroke-width="1"/>
      <line x1="0" y1="174" x2="${VW}" y2="174" stroke="#1a1f2a" stroke-width="1"/>
      <path id="chart-area" d="${esc(areaPath)}" fill="url(#areaDash)"></path>
      <path id="chart-line" d="${esc(linePath)}" fill="none" stroke="#4d86ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
    </svg>
    <div id="hover-line" style="display:none;position:absolute;top:0;height:100%;width:1px;background:rgba(77,134,255,.35);pointer-events:none;"></div>
    <div id="hover-dot" style="display:none;position:absolute;width:11px;height:11px;border-radius:50%;background:#4d86ff;box-shadow:0 0 0 4px rgba(77,134,255,.18);pointer-events:none;transform:translate(-50%,-50%);"></div>
    <div id="hover-tip" style="display:none;position:absolute;background:#0d1016;border:1px solid #2a3040;border-radius:10px;padding:11px 13px;box-shadow:0 14px 34px rgba(0,0,0,.6);pointer-events:none;z-index:5;">
      <div id="tip-date" style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#9aa1b2;margin-bottom:6px;"></div>
      <div style="display:flex;align-items:center;gap:7px;font-size:13px;color:#fff;white-space:nowrap;"><span style="width:8px;height:8px;border-radius:2px;background:#4d86ff;"></span> <span id="tip-visitors">0</span> visitors</div>
      <div style="display:flex;align-items:center;gap:7px;font-size:13px;color:#cfd4e0;white-space:nowrap;margin-top:3px;"><span style="width:8px;height:8px;border-radius:2px;background:#6a7184;"></span> <span id="tip-pageviews">0</span> views</div>
    </div>
    <div style="position:absolute;inset:0;display:flex;" id="overlay-cells"></div>
  </div>
  <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#6a7184;margin-top:8px;">${axisLabels}</div>
</div>
<script nonce="${nonce}">
(function(){
  var series=${seriesJson};
  var metric='visitors';
  var VW=${VW},VH=${VH},padT=${padT},padB=${padB},plotH=${plotH};

  function fmt(n){return n>=1000000?(n/1000000).toFixed(1).replace(/\\.0$/,'')+'M':n>=1000?(n/1000).toFixed(1).replace(/\\.0$/,'')+'K':String(n);}

  function computePaths(arr){
    var n=arr.length,lo=Math.min.apply(null,arr)*0.72,hi=Math.max.apply(null,arr)*1.08||1;
    var X=function(i){return n>1?(i/(n-1))*VW:0;};
    var Y=function(v){return padT+(1-(v-lo)/(hi-lo))*plotH;};
    var pts=arr.map(function(v,i){return{x:X(i),y:Y(v)};});
    var line='M'+pts.map(function(p){return p.x.toFixed(1)+','+p.y.toFixed(1);}).join(' L');
    var area=line+' L'+VW+','+(VH-padB)+' L0,'+(VH-padB)+' Z';
    return{pts:pts,line:line,area:area};
  }

  function render(){
    var arr=series.map(function(p){return metric==='visitors'?p.v:p.pv;});
    var r=computePaths(arr);
    document.getElementById('chart-line').setAttribute('d',r.line);
    document.getElementById('chart-area').setAttribute('d',r.area);
    document.getElementById('btn-visitors').style.color=metric==='visitors'?'#fff':'#9aa1b2';
    document.getElementById('btn-visitors').style.background=metric==='visitors'?'#4d86ff':'#1a1f2a';
    document.getElementById('btn-pageviews').style.color=metric==='pageviews'?'#fff':'#9aa1b2';
    document.getElementById('btn-pageviews').style.background=metric==='pageviews'?'#4d86ff':'#1a1f2a';

    // rebuild overlay cells
    var wrap=document.getElementById('overlay-cells');
    wrap.innerHTML='';
    arr.forEach(function(_,i){
      var cell=document.createElement('div');
      cell.style.flex='1';cell.style.height='100%';cell.style.cursor='crosshair';
      cell.addEventListener('mouseenter',function(){showHover(i,r.pts,arr);});
      wrap.appendChild(cell);
    });
  }

  function showHover(i,pts,arr){
    var p=pts[i],pct=(p.x/VW*100);
    var line=document.getElementById('hover-line');
    var dot=document.getElementById('hover-dot');
    var tip=document.getElementById('hover-tip');
    line.style.display='block';line.style.left=pct+'%';
    dot.style.display='block';dot.style.left=pct+'%';dot.style.top=(p.y/VH*100)+'%';
    var tx=pct>78?'-92%':pct<14?'-8%':'-50%';
    tip.style.display='block';tip.style.left=pct+'%';tip.style.top=(p.y/VH*100)+'%';
    tip.style.transform='translate('+tx+', calc(-100% - 16px))';
    document.getElementById('tip-date').textContent=series[i].day;
    document.getElementById('tip-visitors').textContent=fmt(series[i].v);
    document.getElementById('tip-pageviews').textContent=fmt(series[i].pv);
  }

  function clearHover(){
    document.getElementById('hover-line').style.display='none';
    document.getElementById('hover-dot').style.display='none';
    document.getElementById('hover-tip').style.display='none';
  }

  function setMetric(m){metric=m;render();}

  // Wire handlers via addEventListener: the strict CSP (no script-src-attr)
  // blocks inline onclick/onmouseleave, which silently killed the metric toggle.
  document.getElementById('btn-visitors').addEventListener('click',function(){setMetric('visitors');});
  document.getElementById('btn-pageviews').addEventListener('click',function(){setMetric('pageviews');});
  document.getElementById('chart-wrap').addEventListener('mouseleave',clearHover);

  render();
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Breakdown bar-list HTML (top pages, sources, countries)
// ---------------------------------------------------------------------------

function breakdownCard(title: string, rows: BreakdownRow[], barColor: string): string {
  if (rows.length === 0) {
    return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">${esc(title)}</div>
      <div style="color:#6a7184;font-size:13px;">No data.</div>
    </div>`;
  }
  const rowsHtml = rows
    .map(
      (r) =>
        `<div style="display:flex;align-items:center;gap:11px;">
      <span style="flex:none;width:124px;font-size:12.5px;color:#cfd4e0;font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.label)}">${esc(r.label)}</span>
      <div style="flex:1;height:6px;border-radius:4px;background:#1c212c;">
        <div style="width:${Math.round(r.share * 100)}%;height:100%;border-radius:4px;background:${barColor};"></div>
      </div>
      <span style="flex:none;font-size:12px;color:#9aa1b2;width:48px;text-align:right;">${esc(fmtNum(r.visitors))}</span>
    </div>`,
    )
    .join("\n");
  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
    <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">${esc(title)}</div>
    <div style="display:flex;flex-direction:column;gap:13px;">${rowsHtml}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Full breakdown table (Pages / Sources views)
// ---------------------------------------------------------------------------

function breakdownTable(
  columns: { label: string; key: keyof BreakdownRow; mono?: boolean }[],
  rows: BreakdownRow[],
): string {
  const headerCells = columns
    .map((c) => {
      // Visitors here is the same daily-summed figure as the Overview stat
      // card — carry the same honest caveat as a native tooltip.
      const titleAttr = c.key === "visitors" ? ` title="${esc(VISITORS_TOOLTIP)}"` : "";
      return `<span style="flex:none;width:${c.key === "label" ? "auto" : "120px"};${c.key === "label" ? "flex:1;" : ""}text-align:${c.key === "label" ? "left" : "right"};"${titleAttr}>${esc(c.label)}</span>`;
    })
    .join("");

  const rowsHtml = rows
    .map((r) => {
      const cells = columns
        .map((c) => {
          const raw = r[c.key];
          const val =
            c.key === "share"
              ? fmtPct(r.share)
              : c.key === "pageviews" || c.key === "visitors"
                ? fmtNum(raw as number)
                : esc(String(raw));
          // Surface the per-row sampled flag on the Visitors cell — a row
          // built from sampled event data is not an exact count.
          const badge = c.key === "visitors" ? sampledBadge(r.sampled) : "";
          const mono = c.mono ? "font-family:'JetBrains Mono',monospace;" : "";
          return `<span style="${mono}flex:none;width:${c.key === "label" ? "auto" : "120px"};${c.key === "label" ? "flex:1;" : ""}text-align:${c.key === "label" ? "left" : "right"};color:${c.key === "label" ? "#cfd4e0" : c.key === "visitors" ? "#fff" : "#9aa1b2"};">${val}${badge}</span>`;
        })
        .join("");
      return `<div style="display:flex;align-items:center;padding:15px 24px;border-bottom:1px solid #161a22;font-size:13.5px;">${cells}</div>`;
    })
    .join("");

  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:8px 0;overflow:hidden;">
    <div style="display:flex;padding:14px 24px;border-bottom:1px solid #20252f;font-family:'JetBrains Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#6a7184;">${headerCells}</div>
    ${rowsHtml}
  </div>`;
}

// ---------------------------------------------------------------------------
// Live WebSocket client script (inserted into auth'd app pages)
// ---------------------------------------------------------------------------

function liveScript(siteId: string, nonce: string): string {
  return `<script nonce="${nonce}">
(function(){
  var siteId=${JSON.stringify(siteId)};
  function connect(){
    var proto=location.protocol==='https:'?'wss':'ws';
    var ws=new WebSocket(proto+'://'+location.host+'/live?site='+encodeURIComponent(siteId));
    // Drive liveness refresh from the client: eviction is lazy server-side
    // (site-live.ts currentSnapshot()), so absent new site-wide traffic a
    // connected dashboard would otherwise show a stale count forever once a
    // visitor leaves. A periodic ping costs no DO storage write.
    var pingTimer=setInterval(function(){
      if(ws.readyState===WebSocket.OPEN) ws.send('ping');
    },15000);
    ws.onmessage=function(e){
      try{
        var d=JSON.parse(e.data);
        var el=document.getElementById('live-count');
        if(el) el.textContent=d.visitors;
        var list=document.getElementById('live-pages-list');
        if(list&&Array.isArray(d.topPages)){
          list.textContent='';
          if(d.topPages.length===0){
            var empty=document.createElement('span');
            empty.style.cssText='color:#6a7184;font-size:13px;';
            empty.textContent='No one online right now.';
            list.appendChild(empty);
          }
          d.topPages.forEach(function(p){
            var row=document.createElement('div');
            row.style.cssText='display:flex;align-items:center;gap:11px;';
            var label=document.createElement('span');
            label.style.cssText="flex:1;font-size:12.5px;color:#cfd4e0;font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            label.textContent=p.label;
            var count=document.createElement('span');
            count.style.cssText='flex:none;font-size:12px;color:#9aa1b2;';
            count.textContent=p.visitors;
            row.appendChild(label);
            row.appendChild(count);
            list.appendChild(row);
          });
        }
      }catch(err){}
    };
    ws.onclose=function(){clearInterval(pingTimer);setTimeout(connect,3000);};
  }
  connect();
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Login / setup pages
// ---------------------------------------------------------------------------

function loginPage(nonce: string, error?: string): string {
  const errorHtml = error
    ? `<div style="color:#e08571;font-size:13px;margin-bottom:16px;">${esc(error)}</div>`
    : "";
  return htmlDoc(
    "Login",
    "",
    `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
    <div style="width:360px;">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:32px;justify-content:center;">
        ${skopiaLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#fff;">Skopia</span>
      </div>
      <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:24px;">Sign in</div>
        ${errorHtml}
        <form method="post" action="/login">
          <div style="margin-bottom:16px;">
            <label style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Email</label>
            <input name="email" type="email" autocomplete="email" required style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;outline:none;">
          </div>
          <div style="margin-bottom:24px;">
            <label style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Password</label>
            <input name="password" type="password" autocomplete="current-password" required style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;outline:none;">
          </div>
          <button type="submit" style="width:100%;background:#4d86ff;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;">Sign in</button>
        </form>
      </div>
    </div>
  </div>`,
    nonce,
  );
}

/**
 * Fail-closed "not configured" page (HTTP 500). Shown when a required deploy
 * secret is unset, instead of signing a cookie with `undefined`.
 */
function notConfiguredPage(nonce: string, missing: string[]): string {
  const names = missing
    .map(
      (m) => `<code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">${esc(m)}</code>`,
    )
    .join(", ");
  return htmlDoc(
    "Not configured",
    "",
    `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
    <div style="width:440px;background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:12px;">Not configured</div>
      <div style="font-size:13.5px;color:#cfd4e0;line-height:1.6;margin-bottom:14px;">
        This Skopia instance is missing required secret${missing.length > 1 ? "s" : ""}: ${names}.
        Sessions cannot be signed safely until ${missing.length > 1 ? "they are" : "it is"} set.
      </div>
      <div style="font-size:13px;color:#9aa1b2;line-height:1.6;">
        Generate a key with <code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">openssl rand -hex 32</code>
        and set it as an encrypted secret, then redeploy. See the deploy docs (README).
      </div>
    </div>
  </div>`,
    nonce,
  );
}

function setupPage(nonce: string, error?: string): string {
  const errorHtml = error
    ? `<div style="color:#e08571;font-size:13px;margin-bottom:16px;">${esc(error)}</div>`
    : "";
  return htmlDoc(
    "Setup",
    "",
    `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
    <div style="width:400px;">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:32px;justify-content:center;">
        ${skopiaLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#fff;">Skopia</span>
      </div>
      <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:8px;">Welcome to Skopia</div>
        <div style="font-size:13px;color:#9aa1b2;margin-bottom:24px;">Create your owner account to get started.</div>
        ${errorHtml}
        <form method="post" action="/setup">
          <div style="margin-bottom:16px;">
            <label style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Email</label>
            <input name="email" type="email" autocomplete="email" required style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;outline:none;">
          </div>
          <div style="margin-bottom:16px;">
            <label style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Password</label>
            <input name="password" type="password" autocomplete="new-password" minlength="8" required style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;outline:none;">
          </div>
          <div style="margin-bottom:24px;">
            <label style="display:block;font-size:13px;color:#9aa1b2;margin-bottom:6px;">Confirm Password</label>
            <input name="confirm" type="password" autocomplete="new-password" required style="width:100%;background:#0d1016;border:1px solid #262b38;border-radius:8px;padding:10px 12px;font-size:14px;color:#e8eaef;outline:none;">
          </div>
          <button type="submit" style="width:100%;background:#4d86ff;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;">Create account</button>
        </form>
      </div>
    </div>
  </div>`,
    nonce,
  );
}

// ---------------------------------------------------------------------------
// Helper: the full site list + the active site (for the switcher)
// ---------------------------------------------------------------------------

async function resolveSites(
  db: D1Database,
  siteParam: string | undefined,
): Promise<{ sites: SiteRow[]; site: SiteRow | null }> {
  const sites = await listSites(db);
  const site = (siteParam ? sites.find((s) => s.id === siteParam) : sites[0]) ?? null;
  return { sites, site };
}

// ---------------------------------------------------------------------------
// Routes: first-run setup
// ---------------------------------------------------------------------------

dashboard.get("/setup", async (c) => {
  // If owner already exists, redirect to /login
  const owner = await getOwner(c.env.DB);
  if (owner) return c.redirect("/login");
  return c.html(setupPage(c.get("nonce")));
});

dashboard.post("/setup", async (c) => {
  const owner = await getOwner(c.env.DB);
  if (owner) return c.redirect("/login");

  const form = await c.req.formData();
  const email = (form.get("email") as string | null)?.trim() ?? "";
  const password = (form.get("password") as string | null) ?? "";
  const confirm = (form.get("confirm") as string | null) ?? "";

  const nonce = c.get("nonce");
  if (!email || !password) {
    return c.html(setupPage(nonce, "Email and password are required."), 400);
  }
  if (password.length < 8) {
    return c.html(setupPage(nonce, "Password must be at least 8 characters."), 400);
  }
  if (password !== confirm) {
    return c.html(setupPage(nonce, "Passwords do not match."), 400);
  }

  const pwHash = await hashPassword(password);
  await c.env.DB.prepare(
    "INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, 'owner', unixepoch())",
  )
    .bind(email, pwHash)
    .run();

  return c.redirect("/login");
});

// ---------------------------------------------------------------------------
// Routes: login / logout
// ---------------------------------------------------------------------------

dashboard.get("/login", async (c) => {
  // Fail closed: an unset AUTH_COOKIE_SECRET on a cold deploy would make the
  // cookie check below throw (undefined/"" HMAC key) and surface a 500 instead
  // of the login page. Guard before verifyCookie.
  try {
    requireSecrets(c.env, ["AUTH_COOKIE_SECRET"]);
  } catch (err) {
    if (err instanceof SecretsMissingError) {
      return c.html(notConfiguredPage(c.get("nonce"), err.missing), 500);
    }
    throw err;
  }

  // Already authed?
  const cookies = parseCookies(c.req.header("cookie") ?? null);
  const cookieVal = cookies[COOKIE_NAME];
  if (cookieVal) {
    const userId = await verifyCookie(cookieVal, c.env.AUTH_COOKIE_SECRET);
    if (userId !== null) return c.redirect("/app");
  }

  // No owner yet?
  const owner = await getOwner(c.env.DB);
  if (!owner) return c.redirect("/setup");

  return c.html(loginPage(c.get("nonce")));
});

dashboard.post("/login", async (c) => {
  const owner = await getOwner(c.env.DB);
  if (!owner) return c.redirect("/setup");

  const nonce = c.get("nonce");

  // Fail closed: never sign a session cookie with an unset key (forgeable
  // sessions). Surface a clear "not configured" page instead of a 500.
  try {
    requireSecrets(c.env, ["AUTH_COOKIE_SECRET"]);
  } catch (err) {
    if (err instanceof SecretsMissingError) {
      return c.html(notConfiguredPage(nonce, err.missing), 500);
    }
    throw err;
  }

  const form = await c.req.formData();
  const email = (form.get("email") as string | null)?.trim() ?? "";
  const password = (form.get("password") as string | null) ?? "";

  // Always pay the PBKDF2 cost, even on an email mismatch — checking
  // `emailMatches && verifyPassword(...)` would short-circuit on mismatch,
  // making the response time an oracle for whether an email is the owner's.
  const emailMatches = email.toLowerCase() === owner.email.toLowerCase();
  const passwordOk = await verifyPassword(password, emailMatches ? owner.pw_hash : DUMMY_PW_HASH);
  const valid = emailMatches && passwordOk;

  if (!valid) {
    return c.html(loginPage(nonce, "Invalid email or password."), 401);
  }

  const expiry = Date.now() + COOKIE_MAX_AGE * 1000;
  const cookieVal = await signCookie(owner.id, expiry, c.env.AUTH_COOKIE_SECRET);

  c.header(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(cookieVal)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
  );
  return c.redirect("/app");
});

dashboard.get("/logout", (c) => {
  c.header("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return c.redirect("/login");
});

// ---------------------------------------------------------------------------
// Public share-link surface: /share/:token — read-only, single-site, no auth
// (launch-readiness Task 1, ADR-0012). Excluded from the root securityHeaders
// middleware (src/index.ts) — this surface mints its own nonce and sets its
// own complete hardening header set via publicSecurityHeaders below, so the
// header and the nonce baked into the body always come from the same request.
// ---------------------------------------------------------------------------

// Token shape pre-filter (Global Constraint 5): reject anything that isn't a
// well-formed share token before it ever reaches D1. "shr_" + 43 URL-safe
// chars matches the 32-byte CSPRNG token operators mint per docs/install.md.
const SHARE_TOKEN_SHAPE = /^shr_[A-Za-z0-9_-]{43}$/;

// Fully static — no nonce or token interpolation — so unknown, malformed, and
// revoked tokens all produce byte-identical bodies (Global Constraint 5).
const SHARE_NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found — Skopia</title></head>
<body style="margin:0;height:100%;background:#0a0c11;font-family:sans-serif;">
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:#6a7184;">Dashboard not found.</div>
</body>
</html>`;

/**
 * Complete hardening header set for /share/* responses: the same strict CSP
 * (nonce + strict-dynamic, no unsafe-inline) and header set the root
 * securityHeaders middleware applies to authed pages, plus X-Robots-Tag —
 * duplicated locally rather than imported because /share/* mints its own
 * nonce independent of the root middleware it is excluded from.
 */
function publicSecurityHeaders(nonce: string): Record<string, string> {
  const csp = [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `default-src 'self'`,
    `font-src 'self'`,
    `img-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

// Same views as the app sidebar minus Geography (not implemented until
// launch-readiness Task 3) — filtered from NAV_ITEMS so the label/id source
// never drifts from the authed sidebar.
const PUBLIC_NAV_ITEMS = NAV_ITEMS.filter((item) => item.id !== "geography");

function publicNav(activeView: string, token: string, rangeKey: string): string {
  const navHtml = PUBLIC_NAV_ITEMS.map(({ id, label, href }) => {
    const active = activeView === id;
    const style = [
      "display:flex;align-items:center;gap:11px;padding:10px 11px;border-radius:8px;",
      "cursor:pointer;font-size:13.5px;",
      active
        ? "font-weight:500;color:#9fb4ff;background:rgba(77,134,255,.12);"
        : "font-weight:400;color:#8b92a4;",
    ].join("");
    const dotStyle = active
      ? "width:14px;height:14px;border-radius:3px;background:#4d86ff;"
      : "width:14px;height:14px;border-radius:3px;border:1.5px solid #3a4150;";
    // /app/pages → /share/:token/pages; /app (overview) → /share/:token.
    const publicHref = href.replace(/^\/app/, `/share/${esc(token)}`);
    const fullHref = `${publicHref}?range=${esc(rangeKey)}`;
    return `<a href="${fullHref}" style="${style}"><span style="${dotStyle}"></span>${esc(label)}</a>`;
  }).join("\n");

  return `<div style="flex:none;width:224px;background:#0d1016;border-right:1px solid #1b1f29;padding:24px 16px;display:flex;flex-direction:column;height:100vh;position:sticky;top:0;">
    <div style="display:flex;align-items:center;gap:9px;padding:0 8px;margin-bottom:30px;">
      ${skopiaLogo()}
      <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">Skopia</span>
    </div>
    ${navHtml}
    <a href="https://skopia.dev" style="margin-top:auto;font-size:12px;color:#6a7184;padding:10px 11px;">Powered by Skopia</a>
  </div>`;
}

/**
 * Layout for the public /share/:token surface. Mirrors appLayout's shape
 * (sidebar + topbar + content) but strips everything that leaks the authed
 * app: no site switcher, no /app or /login hrefs, no live WebSocket client.
 * `onlineCount` renders the "online now" badge only when non-null — this
 * task always passes null; launch-readiness Task 2 wires the real count via
 * a server-side SITE_LIVE snapshot() read, never a public WebSocket.
 */
function publicLayout(
  activeView: string,
  token: string,
  site: SiteRow,
  headerRight: string,
  content: string,
  nonce: string,
  rangeKey: string,
  onlineCount: number | null,
): string {
  const onlineBadge =
    onlineCount === null
      ? ""
      : `<div style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#2bd888;background:rgba(43,216,136,.1);padding:8px 13px;border-radius:8px;font-weight:500;">
      <span style="width:7px;height:7px;border-radius:50%;background:#2bd888;"></span>
      <span>${esc(String(onlineCount))} online now</span>
    </div>`;

  // Wires the range <select> to auto-submit its form on change — the strict
  // CSP (no script-src-attr) blocks an inline onchange handler, same reason
  // appLayout's navScript exists.
  const rangeScript = `<script nonce="${nonce}">(function(){
    var r=document.querySelector('select[name="range"]');
    if(r&&r.form){r.addEventListener('change',function(){r.form.submit();});}
  })();</script>`;

  return `<div style="display:flex;min-height:100vh;background:#0a0c11;">
  ${publicNav(activeView, token, rangeKey)}
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
    <div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:20px 32px;border-bottom:1px solid #1b1f29;">
      <div style="display:flex;align-items:center;gap:9px;">
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">${esc(site.name)}</span>
        <span style="font-size:12px;color:#6a7184;background:#161a23;padding:3px 8px;border-radius:5px;">read-only</span>
      </div>
      <div style="display:flex;align-items:center;gap:14px;">
        ${onlineBadge}
        ${headerRight}
      </div>
    </div>
    <div style="flex:1;overflow:auto;padding:28px 32px 40px;">
      ${content}
    </div>
  </div>
  ${rangeScript}
</div>`;
}

// Read-through cache TTL for the public share surface (Global Constraint 6):
// KV key lifetime, Cache-API freshness, and the response's s-maxage all use it.
const SHARE_CACHE_TTL_SECONDS = 60;

// A fully-rendered public page: the HTML plus the nonce baked into both its CSP
// header and its inline scripts. Stored together so a cache replay keeps them in
// lockstep (a page's header nonce always matches its body nonce).
interface CachedPublicPage {
  html: string;
  nonce: string;
}

/** Rebuild the exact public Response from a rendered page: same headers a fresh
 *  render would emit, so a KV-tier replay is indistinguishable from the origin. */
function buildPublicResponse(page: CachedPublicPage): Response {
  return new Response(page.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, s-maxage=${SHARE_CACHE_TTL_SECONDS}`,
      ...publicSecurityHeaders(page.nonce),
    },
  });
}

/**
 * Read-through cache for the public /share/* surface (ADR-0012 §4). Two tiers:
 * the per-isolate Cache API (`caches.default`, keyed by a synthetic in-zone URL)
 * fronts the cross-isolate `CACHE` KV namespace. A hit at either tier replays a
 * previously rendered page verbatim — HTML and the nonce in both the CSP header
 * and the inline scripts — so cached pages never desync header/body nonces and
 * never re-run D1.
 *
 * On a full miss it reads the live-visitor count once (a single `SITE_LIVE`
 * `snapshot()` RPC, best-effort: a DO failure degrades to no badge, never a
 * 500), renders, then writes both tiers via `waitUntil` so the response is not
 * held on the cache write.
 *
 * `cacheKey` is keyed by site id, never by token (Global Constraint 6): a
 * rotated/revoked token can't bust another token's cache, and two tokens for one
 * site share a single entry. `siteId` is read back from the key (segment 2 of
 * `share:v1:{site_id}:{view}:{range}:{day}`) to address the DO.
 */
async function cachedPublicResponse(
  c: Context<DashEnv>,
  cacheKey: string,
  ttl: number,
  render: (onlineCount: number | null) => Promise<CachedPublicPage>,
): Promise<Response> {
  const cache = caches.default;
  const cacheReq = new Request(`https://cache.local/${cacheKey}`);

  const edgeHit = await cache.match(cacheReq);
  if (edgeHit) return edgeHit;

  const kvHit = await c.env.CACHE.get<CachedPublicPage>(cacheKey, {
    type: "json",
    cacheTtl: ttl,
  });
  if (kvHit) {
    const res = buildPublicResponse(kvHit);
    // Warm the near tier so the next request skips the KV round-trip.
    c.executionCtx.waitUntil(cache.put(cacheReq, res.clone()));
    return res;
  }

  // Full miss: read the live count once, best-effort. A DO failure must degrade
  // to no badge, never a 500 — the count is a nicety, the page is the product.
  let onlineCount: number | null = null;
  // Segment 2 of share:v1:{site_id}:{view}:{range}:{day}.
  // ponytail: assumes site ids carry no ':' (the WAE-index slug convention);
  // pass the site id as its own arg if that ever stops holding.
  const siteId = cacheKey.split(":")[2];
  if (siteId) {
    try {
      const ns = c.env.SITE_LIVE;
      const stub = ns.get(ns.idFromName(siteId)) as unknown as {
        snapshot(): Promise<LiveSnapshot>;
      };
      onlineCount = (await stub.snapshot()).visitors;
    } catch {
      onlineCount = null;
    }
  }

  const page = await render(onlineCount);
  const res = buildPublicResponse(page);

  c.executionCtx.waitUntil(c.env.CACHE.put(cacheKey, JSON.stringify(page), { expirationTtl: ttl }));
  c.executionCtx.waitUntil(cache.put(cacheReq, res.clone()));

  return res;
}

// Overview
dashboard.get("/share/:token", async (c) => {
  const token = c.req.param("token");

  if (!SHARE_TOKEN_SHAPE.test(token)) {
    return c.html(
      SHARE_NOT_FOUND_HTML,
      404,
      publicSecurityHeaders(crypto.randomUUID().replace(/-/g, "")),
    );
  }

  const site = await getSiteByPublicToken(c.env.DB, token);
  if (!site) {
    return c.html(
      SHARE_NOT_FOUND_HTML,
      404,
      publicSecurityHeaders(crypto.randomUUID().replace(/-/g, "")),
    );
  }

  const range = parseRange(c.req.query("range"));
  const cacheKey = `share:v1:${site.id}:overview:${range.key}:${todayUtc()}`;

  return cachedPublicResponse(c, cacheKey, SHARE_CACHE_TTL_SECONDS, async (onlineCount) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");

    const [cards, series, topPages, topSources, topCountries] = await Promise.all([
      getStatCards(c.env.DB, site.id, range),
      getTimeSeries(c.env.DB, site.id, range),
      getTopPages(c.env.DB, site.id, range, 5),
      getTopSources(c.env.DB, site.id, range, 5),
      getTopCountries(c.env.DB, site.id, range, 5),
    ]);

    const content = `
    ${statCardsHtml(cards, cards.sampled)}
    ${timeSeriesChartHtml(series, range.label, site.id, range.key, nonce)}
    <div class="breakdown-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
      ${breakdownCard("Top pages", topPages, "#4d86ff")}
      ${breakdownCard("Top sources", topSources, "#7a5cff")}
    </div>
    ${breakdownCard("Top countries", topCountries, "#2bd888")}
  `;

    const headerRight = rangePicker(range.key, "");

    const html = htmlDoc(
      site.name,
      "",
      publicLayout("overview", token, site, headerRight, content, nonce, range.key, onlineCount),
      nonce,
    );

    return { html, nonce };
  });
});

// ---------------------------------------------------------------------------
// Route: /live — WebSocket proxy to SiteLive DO (auth-gated)
// ---------------------------------------------------------------------------

// Middleware for /live — same auth gate as /app routes.
// WebSocket upgrades are plain GETs so the middleware runs before the handshake.
dashboard.use("/live", requireAuth);

dashboard.get("/live", async (c) => {
  const siteId = c.req.query("site") ?? "";
  if (!siteId) return new Response("Missing site param", { status: 400 });

  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const id = c.env.SITE_LIVE.idFromName(siteId);
  const stub = c.env.SITE_LIVE.get(id);

  // Proxy the upgrade to the DO. Build a fresh Request with the WS headers.
  const doUrl = new URL(c.req.url);
  doUrl.pathname = "/live";
  const proxyReq = new Request(doUrl.toString(), {
    headers: c.req.raw.headers,
  });

  return stub.fetch(proxyReq);
});

// ---------------------------------------------------------------------------
// Auth-gated /app routes
// ---------------------------------------------------------------------------

// Middleware for all /app routes
dashboard.use("/app", requireAuth);
dashboard.use("/app/*", requireAuth);

// Overview
dashboard.get("/app", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) {
    return c.html(
      htmlDoc(
        "No sites",
        "",
        "<div style='padding:60px;text-align:center;color:#6a7184;line-height:1.6;'>No sites tracked yet.<br>Register one with <code style='color:#9fb4ff;'>wrangler d1 execute skopia --remote --command \"INSERT INTO sites (id,name,domain) VALUES ('my-site','My Site','example.com')\"</code>, then reload.</div>",
        nonce,
      ),
    );
  }

  const [cards, series, topPages, topSources, topCountries] = await Promise.all([
    getStatCards(c.env.DB, site.id, range),
    getTimeSeries(c.env.DB, site.id, range),
    getTopPages(c.env.DB, site.id, range, 5),
    getTopSources(c.env.DB, site.id, range, 5),
    getTopCountries(c.env.DB, site.id, range, 5),
  ]);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content = `
    ${statCardsHtml(cards, cards.sampled)}
    ${timeSeriesChartHtml(series, range.label, site.id, range.key, nonce)}
    <div class="breakdown-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
      ${breakdownCard("Top pages", topPages, "#4d86ff")}
      ${breakdownCard("Top sources", topSources, "#7a5cff")}
    </div>
    ${breakdownCard("Top countries", topCountries, "#2bd888")}
    <div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;margin-top:14px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
        <span style="width:7px;height:7px;border-radius:50%;background:#2bd888;animation:skopiaPulse 1.6s infinite;"></span>
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;">Active pages right now</span>
      </div>
      <div id="live-pages-list" style="display:flex;flex-direction:column;gap:13px;">
        <span style="color:#6a7184;font-size:13px;">Waiting for live data&hellip;</span>
      </div>
    </div>
    ${liveScript(site.id, nonce)}
  `;

  return c.html(
    htmlDoc(
      site.name,
      "",
      appLayout("overview", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

// Pages
dashboard.get("/app/pages", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const rows = await getTopPages(c.env.DB, site.id, range, 50);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content =
    breakdownTable(
      [
        { label: "Page", key: "label", mono: true },
        { label: "Visitors", key: "visitors" },
        { label: "Pageviews", key: "pageviews" },
      ],
      rows,
    ) + liveScript(site.id, nonce);

  return c.html(
    htmlDoc(
      `Pages — ${site.name}`,
      "",
      appLayout("pages", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

// Sources
dashboard.get("/app/sources", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const rows = await getTopSources(c.env.DB, site.id, range, 50);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content =
    breakdownTable(
      [
        { label: "Source", key: "label" },
        { label: "Visitors", key: "visitors" },
        { label: "Share", key: "share" },
      ],
      rows,
    ) + liveScript(site.id, nonce);

  return c.html(
    htmlDoc(
      `Sources — ${site.name}`,
      "",
      appLayout("sources", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

// Geography
dashboard.get("/app/geography", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const rows = await getTopCountries(c.env.DB, site.id, range, 20);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  // Country rows for the list panel
  const countryListHtml = rows
    .map(
      (r) =>
        `<div style="display:flex;align-items:center;gap:11px;">
      <span style="flex:none;width:138px;font-size:13px;color:#cfd4e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.label)}</span>
      <div style="flex:1;height:6px;border-radius:4px;background:#1c212c;">
        <div style="width:${Math.round(r.share * 100)}%;height:100%;border-radius:4px;background:#2bd888;"></div>
      </div>
      <span style="flex:none;font-size:12px;color:#9aa1b2;width:48px;text-align:right;">${esc(fmtNum(r.visitors))}</span>
    </div>`,
    )
    .join("\n");

  // Build jsVectorMap values JSON for the map
  // jsonForScript, not JSON.stringify: a country label lands inline in a
  // <script> block, and JSON.stringify does not neutralize "</script>".
  const mapValues = jsonForScript(Object.fromEntries(rows.map((r) => [r.label, r.visitors])));

  const content = `
    <link rel="stylesheet" href="/vendor/jsvectormap@1.6.0/jsvectormap.min.css">
    <div class="geo-layout" style="display:flex;gap:14px;align-items:stretch;">
      <div style="flex:1.7;min-width:0;background:#12151d;border:1px solid #20252f;border-radius:12px;padding:22px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;color:#fff;">Visitors by country</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#6a7184;font-family:'JetBrains Mono',monospace;">
            low <span style="width:60px;height:7px;border-radius:4px;background:linear-gradient(90deg,#202634,#4d86ff);"></span> high
          </div>
        </div>
        <div id="skopia-map" style="width:100%;height:430px;"></div>
      </div>
      <div style="flex:1;min-width:0;background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">Top countries</div>
        <div style="display:flex;flex-direction:column;gap:14px;">${countryListHtml}</div>
      </div>
    </div>
    <script nonce="${nonce}">
    (function(){
      var vals=${mapValues};
      function fmt(n){return n>=1000000?(n/1000000).toFixed(1).replace(/\\.0$/,'')+'M':n>=1000?(n/1000).toFixed(1).replace(/\\.0$/,'')+'K':String(n);}
      function loadMap(){
        if(!window.jsVectorMap||!document.getElementById('skopia-map')) return;
        new window.jsVectorMap({
          selector:'#skopia-map',map:'world',
          backgroundColor:'transparent',zoomButtons:false,zoomOnScroll:false,
          regionStyle:{initial:{fill:'#1c212c',stroke:'#0d1016',strokeWidth:0.5},hover:{fill:'#6a9bff'}},
          series:{regions:[{attribute:'fill',scale:['#202634','#4d86ff'],normalizeFunction:'polynomial',values:vals}]},
          onRegionTooltipShow:function(event,tooltip,code){
            var v=vals[code];
            tooltip.text(tooltip.text()+(v?' · '+fmt(v)+' visitors':' · no data'),false);
          },
        });
      }
      var NONCE=${JSON.stringify(nonce)};
      var s1=document.createElement('script');
      s1.src='/vendor/jsvectormap@1.6.0/jsvectormap.min.js';
      s1.nonce=NONCE;
      s1.onload=function(){
        var s2=document.createElement('script');
        s2.src='/vendor/jsvectormap@1.6.0/world.js';
        s2.nonce=NONCE;
        s2.onload=loadMap;
        document.head.appendChild(s2);
      };
      document.head.appendChild(s1);
    })();
    </script>
    ${liveScript(site.id, nonce)}
  `;

  return c.html(
    htmlDoc(
      `Geography — ${site.name}`,
      "",
      appLayout("geography", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

// Devices
dashboard.get("/app/devices", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const [devices, browsers, oses] = await Promise.all([
    getTopDevices(c.env.DB, site.id, range, 10),
    getTopBrowsers(c.env.DB, site.id, range, 10),
    getTopOperatingSystems(c.env.DB, site.id, range, 10),
  ]);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content = `<div class="breakdown-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
      ${breakdownCard("Device type", devices, "#4d86ff")}
      ${breakdownCard("Browser", browsers, "#7a5cff")}
      ${breakdownCard("Operating system", oses, "#2bd888")}
    </div>${liveScript(site.id, nonce)}`;

  return c.html(
    htmlDoc(
      `Devices — ${site.name}`,
      "",
      appLayout("devices", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

// Campaigns (UTM)
dashboard.get("/app/campaigns", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const [utmSources, utmMediums, utmCampaigns] = await Promise.all([
    getTopUtmSources(c.env.DB, site.id, range, 10),
    getTopUtmMediums(c.env.DB, site.id, range, 10),
    getTopUtmCampaigns(c.env.DB, site.id, range, 10),
  ]);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content = `<div class="breakdown-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
      ${breakdownCard("UTM source", utmSources, "#4d86ff")}
      ${breakdownCard("UTM medium", utmMediums, "#7a5cff")}
      ${breakdownCard("UTM campaign", utmCampaigns, "#2bd888")}
    </div>${liveScript(site.id, nonce)}`;

  return c.html(
    htmlDoc(
      `Campaigns — ${site.name}`,
      "",
      appLayout("campaigns", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

// Custom events
dashboard.get("/app/events", async (c) => {
  const nonce = c.get("nonce");
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const { sites, site } = await resolveSites(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const rows = await getTopEvents(c.env.DB, site.id, range, 50);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  // dimension='event' counts one "pageview" per fire (event-dimensions.ts),
  // so the column is labeled Count — Pageviews would be a lie here.
  const table =
    rows.length === 0
      ? `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:60px 24px;text-align:center;">
      <div style="color:#cfd4e0;font-size:14px;margin-bottom:8px;">No custom events in this period.</div>
      <div style="color:#6a7184;font-size:13px;line-height:1.6;">Fire one from your site with <code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">${esc("skopia('event', 'signup')")}</code> or <code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">${esc("skopia.track('signup')")}</code> — see docs/install.md.</div>
    </div>`
      : breakdownTable(
          [
            { label: "Event", key: "label", mono: true },
            { label: "Count", key: "pageviews" },
            { label: "Visitors", key: "visitors" },
          ],
          rows,
        );

  const content = table + liveScript(site.id, nonce);

  return c.html(
    htmlDoc(
      `Events — ${site.name}`,
      "",
      appLayout("events", sites, site, headerRight, content, nonce, range.key),
      nonce,
    ),
  );
});

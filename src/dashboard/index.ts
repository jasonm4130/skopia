/**
 * Stratus — dashboard Worker surface (SSR + auth + realtime proxy).
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
 *   /public/:token    — read-only per-site view (no auth)
 *   /live             — WebSocket proxy → SiteLive DO
 *
 * Auth (spec §7.2): HMAC-SHA256 signed HttpOnly cookie, Web Crypto only.
 * Never registers a bare "/" route — marketing pillar owns that.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Env, BreakdownRow, DateRange, TimeSeriesPoint, StatCards, SiteRow } from "../shared/types";
import {
  getOwner,
  listSites,
  getSite,
  getSiteByPublicToken,
  getStatCards,
  getTimeSeries,
  getTopPages,
  getTopSources,
  getTopCountries,
} from "../db/queries";

export { SiteLive } from "./site-live";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variables = {
  userId: number;
};

// ---------------------------------------------------------------------------
// Hono sub-app
// ---------------------------------------------------------------------------

export const dashboard = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = "stratus_session";
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
  if (isNaN(userId) || isNaN(expiry)) return null;
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
      return eq === -1 ? [c.trim(), ""] : [c.slice(0, eq).trim(), decodeURIComponent(c.slice(eq + 1).trim())];
    }),
  );
}

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
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2:")) return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  // After length check, indices 1 and 2 exist; cast away undefined.
  const saltHex = parts[1] as string;
  const expectedHex = parts[2] as string;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
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

function parseRange(param: string | null | undefined): DateRange & { label: string; key: string } {
  const ranges: Record<string, { from: () => string; label: string }> = {
    "7d": { from: () => daysAgo(7), label: "Last 7 days" },
    "30d": { from: () => daysAgo(30), label: "Last 30 days" },
    "90d": { from: () => daysAgo(90), label: "Last 90 days" },
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
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtPct(r: number): string {
  return Math.round(r * 100) + "%";
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function requireAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
): Promise<Response | void> {
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

const FONTS = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
`.trim();

const BASE_CSS = `
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;background:#0a0c11;}
  body{font-family:'Hanken Grotesk',sans-serif;color:#e8eaef;}
  a{color:inherit;text-decoration:none;}
  input,button,select,textarea{font-family:inherit;}
  ::-webkit-scrollbar{width:10px;height:10px;}
  ::-webkit-scrollbar-thumb{background:#232838;border-radius:6px;}
  ::-webkit-scrollbar-track{background:transparent;}
  @keyframes stratusPulse{0%,100%{opacity:1;}50%{opacity:.3;}}
`.trim();

function htmlDoc(title: string, head: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Stratus</title>
${FONTS}
<style>${BASE_CSS}</style>
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

function stratusLogo(): string {
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
] as const;

function sidebar(activeView: string, siteName: string, siteId: string): string {
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
    const fullHref = siteId ? `${href}?site=${esc(siteId)}` : href;
    return `<a href="${fullHref}" style="${style}"><span style="${dotStyle}"></span>${esc(label)}</a>`;
  }).join("\n");

  return `<div style="flex:none;width:224px;background:#0d1016;border-right:1px solid #1b1f29;padding:24px 16px;display:flex;flex-direction:column;height:100vh;position:sticky;top:0;">
    <div style="display:flex;align-items:center;gap:9px;padding:0 8px;margin-bottom:30px;">
      ${stratusLogo()}
      <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">Stratus</span>
    </div>
    <div style="display:flex;align-items:center;gap:9px;background:#161a23;border:1px solid #232838;border-radius:9px;padding:10px 11px;margin-bottom:24px;">
      <span style="width:8px;height:8px;border-radius:2px;background:#4d86ff;"></span>
      <span style="font-size:13px;color:#e8eaef;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(siteName)}</span>
    </div>
    ${navHtml}
    <div style="margin-top:auto;background:#161a23;border:1px solid #232838;border-radius:10px;padding:14px;">
      <div style="font-size:12px;color:#9aa1b2;line-height:1.5;margin-bottom:10px;">Running on your Worker. <span style="color:#2bd888;">Healthy.</span></div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;">stratus · d1 ok</div>
    </div>
  </div>`;
}

function appLayout(
  activeView: string,
  siteName: string,
  siteId: string,
  headerRight: string,
  content: string,
): string {
  return `<div style="display:flex;min-height:100vh;background:#0a0c11;">
  ${sidebar(activeView, siteName, siteId)}
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
    <div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:20px 32px;border-bottom:1px solid #1b1f29;">
      <div id="live-badge" style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#2bd888;background:rgba(43,216,136,.1);padding:8px 13px;border-radius:8px;font-weight:500;">
        <span style="width:7px;height:7px;border-radius:50%;background:#2bd888;animation:stratusPulse 1.6s infinite;"></span>
        <span id="live-count">—</span> online now
      </div>
      ${headerRight}
    </div>
    <div style="flex:1;overflow:auto;padding:28px 32px 40px;">
      ${content}
    </div>
  </div>
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
    <select name="range" onchange="this.form.submit()" style="cursor:pointer;font-size:13px;color:#cfd4e0;background:#12151d;border:1px solid #262b38;padding:8px 15px;border-radius:8px;appearance:none;-webkit-appearance:none;">
      ${optHtml}
    </select>
  </form>`;
}

// ---------------------------------------------------------------------------
// Stat cards HTML
// ---------------------------------------------------------------------------

function statCardsHtml(cards: StatCards, sampled: boolean): string {
  const items = [
    { label: "Visitors", value: fmtNum(cards.visitors) },
    { label: "Pageviews", value: fmtNum(cards.pageviews) },
    { label: "Views / Visitor", value: cards.viewsPerVisitor.toFixed(1) },
    { label: "Bounce Rate", value: fmtPct(cards.bounceRate) },
  ];
  const badge = sampled
    ? `<span title="Estimated from sampled data" style="font-size:10px;color:#9aa1b2;background:#1a1f2a;padding:2px 6px;border-radius:4px;margin-left:6px;">~est</span>`
    : "";
  const cardsHtml = items
    .map(
      ({ label, value }) =>
        `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:18px 20px;">
      <div style="font-size:12.5px;color:#8b92a4;margin-bottom:10px;">${esc(label)}</div>
      <div style="display:flex;align-items:baseline;gap:8px;">
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;color:#fff;letter-spacing:-.01em;">${esc(value)}${badge}</span>
      </div>
    </div>`,
    )
    .join("\n");
  return `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;">${cardsHtml}</div>`;
}

// ---------------------------------------------------------------------------
// Time-series chart HTML (SVG area chart, server-rendered paths + client hover)
// ---------------------------------------------------------------------------

function timeSeriesChartHtml(
  series: TimeSeriesPoint[],
  rangeLabel: string,
  _siteId: string,
  _rangeKey: string,
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
  const VW = 1000, VH = 260, padT = 18, padB = 30;
  const plotH = VH - padT - padB;

  function computePaths(arr: number[]): { linePath: string; areaPath: string } {
    const n = arr.length;
    const lo = Math.min(...arr) * 0.72;
    const hi = Math.max(...arr) * 1.08 || 1;
    const X = (i: number) => (n > 1 ? (i / (n - 1)) * VW : 0);
    const Y = (val: number) => padT + (1 - (val - lo) / (hi - lo)) * plotH;
    const pts = arr.map((val, i) => ({ x: X(i), y: Y(val) }));
    const linePath = "M" + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L");
    const areaPath =
      linePath + ` L${VW},${VH - padB} L0,${VH - padB} Z`;
    return { linePath, areaPath };
  }

  const visitorsArr = series.map((p) => p.visitors);
  const { linePath, areaPath } = computePaths(visitorsArr);

  // Axis labels: up to 5 evenly spaced day labels
  const axisIndices = series.length <= 5
    ? series.map((_, i) => i)
    : [0, Math.floor(series.length / 4), Math.floor(series.length / 2), Math.floor((3 * series.length) / 4), series.length - 1];
  const axisLabels = axisIndices
    .map((i) => `<span>${esc(series[i]?.day.slice(5) ?? "")}</span>`)
    .join("");

  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:22px 24px;margin-bottom:20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
    <div style="display:flex;gap:7px;">
      <button id="btn-visitors" onclick="setMetric('visitors')" style="cursor:pointer;font-size:12.5px;font-weight:600;color:#fff;background:#4d86ff;padding:7px 14px;border-radius:7px;border:none;">Visitors</button>
      <button id="btn-pageviews" onclick="setMetric('pageviews')" style="cursor:pointer;font-size:12.5px;font-weight:500;color:#9aa1b2;background:#1a1f2a;padding:7px 14px;border-radius:7px;border:none;">Pageviews</button>
    </div>
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;">${esc(rangeLabel)}</span>
  </div>
  <div style="position:relative;height:250px;" id="chart-wrap" onmouseleave="clearHover()">
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
<script>
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

  window.clearHover=function(){
    document.getElementById('hover-line').style.display='none';
    document.getElementById('hover-dot').style.display='none';
    document.getElementById('hover-tip').style.display='none';
  };

  window.setMetric=function(m){metric=m;render();};

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
    .map(
      (c) =>
        `<span style="flex:none;width:${c.key === "label" ? "auto" : "120px"};${c.key === "label" ? "flex:1;" : ""}text-align:${c.key === "label" ? "left" : "right"};">${esc(c.label)}</span>`,
    )
    .join("");

  const rowsHtml = rows
    .map((r) => {
      const cells = columns
        .map((c) => {
          const raw = r[c.key];
          const val = c.key === "share" ? fmtPct(r.share) : c.key === "pageviews" || c.key === "visitors" ? fmtNum(raw as number) : esc(String(raw));
          const mono = c.mono ? "font-family:'JetBrains Mono',monospace;" : "";
          return `<span style="${mono}flex:none;width:${c.key === "label" ? "auto" : "120px"};${c.key === "label" ? "flex:1;" : ""}text-align:${c.key === "label" ? "left" : "right"};color:${c.key === "label" ? "#cfd4e0" : c.key === "visitors" ? "#fff" : "#9aa1b2"};">${val}</span>`;
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

function liveScript(siteId: string): string {
  return `<script>
(function(){
  var siteId=${JSON.stringify(siteId)};
  function connect(){
    var proto=location.protocol==='https:'?'wss':'ws';
    var ws=new WebSocket(proto+'://'+location.host+'/live?site='+encodeURIComponent(siteId));
    ws.onmessage=function(e){
      try{
        var d=JSON.parse(e.data);
        var el=document.getElementById('live-count');
        if(el) el.textContent=d.visitors;
      }catch(err){}
    };
    ws.onclose=function(){setTimeout(connect,3000);};
  }
  connect();
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Login / setup pages
// ---------------------------------------------------------------------------

function loginPage(error?: string): string {
  const errorHtml = error
    ? `<div style="color:#e08571;font-size:13px;margin-bottom:16px;">${esc(error)}</div>`
    : "";
  return htmlDoc(
    "Login",
    "",
    `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
    <div style="width:360px;">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:32px;justify-content:center;">
        ${stratusLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#fff;">Stratus</span>
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
  );
}

function setupPage(error?: string): string {
  const errorHtml = error
    ? `<div style="color:#e08571;font-size:13px;margin-bottom:16px;">${esc(error)}</div>`
    : "";
  return htmlDoc(
    "Setup",
    "",
    `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
    <div style="width:400px;">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:32px;justify-content:center;">
        ${stratusLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#fff;">Stratus</span>
      </div>
      <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:32px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:8px;">Welcome to Stratus</div>
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
  );
}

// ---------------------------------------------------------------------------
// Helper: get the first site or 404
// ---------------------------------------------------------------------------

async function resolveQuerySite(
  db: D1Database,
  siteParam: string | undefined,
): Promise<SiteRow | null> {
  if (siteParam) {
    return getSite(db, siteParam);
  }
  const sites = await listSites(db);
  return sites[0] ?? null;
}

// ---------------------------------------------------------------------------
// Routes: first-run setup
// ---------------------------------------------------------------------------

dashboard.get("/setup", async (c) => {
  // If owner already exists, redirect to /login
  const owner = await getOwner(c.env.DB);
  if (owner) return c.redirect("/login");
  return c.html(setupPage());
});

dashboard.post("/setup", async (c) => {
  const owner = await getOwner(c.env.DB);
  if (owner) return c.redirect("/login");

  const form = await c.req.formData();
  const email = (form.get("email") as string | null)?.trim() ?? "";
  const password = (form.get("password") as string | null) ?? "";
  const confirm = (form.get("confirm") as string | null) ?? "";

  if (!email || !password) {
    return c.html(setupPage("Email and password are required."), 400);
  }
  if (password.length < 8) {
    return c.html(setupPage("Password must be at least 8 characters."), 400);
  }
  if (password !== confirm) {
    return c.html(setupPage("Passwords do not match."), 400);
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

  return c.html(loginPage());
});

dashboard.post("/login", async (c) => {
  const owner = await getOwner(c.env.DB);
  if (!owner) return c.redirect("/setup");

  const form = await c.req.formData();
  const email = (form.get("email") as string | null)?.trim() ?? "";
  const password = (form.get("password") as string | null) ?? "";

  const valid =
    email.toLowerCase() === owner.email.toLowerCase() &&
    (await verifyPassword(password, owner.pw_hash));

  if (!valid) {
    return c.html(loginPage("Invalid email or password."), 401);
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
  c.header(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
  return c.redirect("/login");
});

// ---------------------------------------------------------------------------
// Route: /public/:token — read-only view (no auth required)
// ---------------------------------------------------------------------------

dashboard.get("/public/:token", async (c) => {
  const token = c.req.param("token");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const site = await getSiteByPublicToken(c.env.DB, token);
  if (!site) return c.html(htmlDoc("Not Found", "", "<div style='padding:60px;text-align:center;color:#6a7184;'>Dashboard not found.</div>"), 404);

  const [cards, series, topPages, topSources, topCountries] = await Promise.all([
    getStatCards(c.env.DB, site.id, range),
    getTimeSeries(c.env.DB, site.id, range),
    getTopPages(c.env.DB, site.id, range, 5),
    getTopSources(c.env.DB, site.id, range, 5),
    getTopCountries(c.env.DB, site.id, range, 5),
  ]);

  const content = `
    ${statCardsHtml(cards, cards.sampled)}
    ${timeSeriesChartHtml(series, range.label, site.id, range.key)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
      ${breakdownCard("Top pages", topPages, "#4d86ff")}
      ${breakdownCard("Top sources", topSources, "#7a5cff")}
    </div>
    ${breakdownCard("Top countries", topCountries, "#2bd888")}
  `;

  const body = `<div style="max-width:1280px;margin:0 auto;padding:32px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;">
      <div style="display:flex;align-items:center;gap:9px;">
        ${stratusLogo()}
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:18px;color:#fff;">${esc(site.name)}</span>
        <span style="font-size:12px;color:#6a7184;background:#161a23;padding:3px 8px;border-radius:5px;">read-only</span>
      </div>
      ${rangePicker(range.key, "")}
    </div>
    ${content}
  </div>`;

  return c.html(htmlDoc(site.name, "", body));
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
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
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
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const site = await resolveQuerySite(c.env.DB, siteParam);
  if (!site) {
    return c.html(
      htmlDoc("No sites", "", "<div style='padding:60px;text-align:center;color:#6a7184;'>No sites tracked yet. <a href='/setup' style='color:#4d86ff;'>Add a site</a></div>"),
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
    ${timeSeriesChartHtml(series, range.label, site.id, range.key)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
      ${breakdownCard("Top pages", topPages, "#4d86ff")}
      ${breakdownCard("Top sources", topSources, "#7a5cff")}
    </div>
    ${breakdownCard("Top countries", topCountries, "#2bd888")}
    ${liveScript(site.id)}
  `;

  return c.html(
    htmlDoc(
      site.name,
      "",
      appLayout("overview", site.name, site.id, headerRight, content),
    ),
  );
});

// Pages
dashboard.get("/app/pages", async (c) => {
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const site = await resolveQuerySite(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const rows = await getTopPages(c.env.DB, site.id, range, 50);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content = breakdownTable(
    [
      { label: "Page", key: "label", mono: true },
      { label: "Visitors", key: "visitors" },
      { label: "Pageviews", key: "pageviews" },
    ],
    rows,
  ) + liveScript(site.id);

  return c.html(
    htmlDoc(
      `Pages — ${site.name}`,
      "",
      appLayout("pages", site.name, site.id, headerRight, content),
    ),
  );
});

// Sources
dashboard.get("/app/sources", async (c) => {
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const site = await resolveQuerySite(c.env.DB, siteParam);
  if (!site) return c.redirect("/app");

  const rows = await getTopSources(c.env.DB, site.id, range, 50);

  const siteHiddenInput = `<input type="hidden" name="site" value="${esc(site.id)}">`;
  const headerRight = rangePicker(range.key, siteHiddenInput);

  const content = breakdownTable(
    [
      { label: "Source", key: "label" },
      { label: "Visitors", key: "visitors" },
      { label: "Share", key: "share" },
    ],
    rows,
  ) + liveScript(site.id);

  return c.html(
    htmlDoc(
      `Sources — ${site.name}`,
      "",
      appLayout("sources", site.name, site.id, headerRight, content),
    ),
  );
});

// Geography
dashboard.get("/app/geography", async (c) => {
  const siteParam = c.req.query("site");
  const rangeParam = c.req.query("range");
  const range = parseRange(rangeParam);

  const site = await resolveQuerySite(c.env.DB, siteParam);
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
  const mapValues = JSON.stringify(
    Object.fromEntries(rows.map((r) => [r.label, r.visitors])),
  );

  const content = `
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/jsvectormap@1.6.0/dist/jsvectormap.min.css">
    <div style="display:flex;gap:14px;align-items:stretch;">
      <div style="flex:1.7;min-width:0;background:#12151d;border:1px solid #20252f;border-radius:12px;padding:22px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;color:#fff;">Visitors by country</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#6a7184;font-family:'JetBrains Mono',monospace;">
            low <span style="width:60px;height:7px;border-radius:4px;background:linear-gradient(90deg,#202634,#4d86ff);"></span> high
          </div>
        </div>
        <div id="stratus-map" style="width:100%;height:430px;"></div>
      </div>
      <div style="flex:1;min-width:0;background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">Top countries</div>
        <div style="display:flex;flex-direction:column;gap:14px;">${countryListHtml}</div>
      </div>
    </div>
    <script>
    (function(){
      var vals=${mapValues};
      function fmt(n){return n>=1000000?(n/1000000).toFixed(1).replace(/\\.0$/,'')+'M':n>=1000?(n/1000).toFixed(1).replace(/\\.0$/,'')+'K':String(n);}
      function loadMap(){
        if(!window.jsVectorMap||!document.getElementById('stratus-map')) return;
        new window.jsVectorMap({
          selector:'#stratus-map',map:'world',
          backgroundColor:'transparent',zoomButtons:false,zoomOnScroll:false,
          regionStyle:{initial:{fill:'#1c212c',stroke:'#0d1016',strokeWidth:0.5},hover:{fill:'#6a9bff'}},
          series:{regions:[{attribute:'fill',scale:['#202634','#4d86ff'],normalizeFunction:'polynomial',values:vals}]},
          onRegionTooltipShow:function(event,tooltip,code){
            var v=vals[code];
            tooltip.text(tooltip.text()+(v?' · '+fmt(v)+' visitors':' · no data'),false);
          },
        });
      }
      var s1=document.createElement('script');
      s1.src='https://cdn.jsdelivr.net/npm/jsvectormap@1.6.0/dist/jsvectormap.min.js';
      s1.onload=function(){
        var s2=document.createElement('script');
        s2.src='https://cdn.jsdelivr.net/npm/jsvectormap@1.6.0/dist/maps/world.js';
        s2.onload=loadMap;
        document.head.appendChild(s2);
      };
      document.head.appendChild(s1);
    })();
    </script>
    ${liveScript(site.id)}
  `;

  return c.html(
    htmlDoc(
      `Geography — ${site.name}`,
      "",
      appLayout("geography", site.name, site.id, headerRight, content),
    ),
  );
});

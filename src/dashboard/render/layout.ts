/**
 * Skopia — page shell: fonts + base CSS, the document wrapper, the authed
 * sidebar/topbar/tab bar, the public /share layout, and the range picker.
 */

import type { SiteRow } from "../../shared/types";
import { esc } from "./html";

// ---------------------------------------------------------------------------
// Layout / shared HTML
// ---------------------------------------------------------------------------

// Self-hosted @font-face — vendored woff2 served from /fonts by the Workers
// Static Assets layer (Task 3). Zero third-party requests: no Google Fonts.
// One @font-face per weight/subset; unicode-range lets the browser fetch only
// the latin or latin-ext file it needs. font-display:swap avoids FOIT.
export const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
export const LATIN_EXT =
  "U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

export function fontFace(family: string, file: string, weight: number, range: string): string {
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('/fonts/${file}.woff2') format('woff2');unicode-range:${range};}`;
}

export function fontFaces(family: string, prefix: string, weights: number[]): string {
  return weights
    .flatMap((w) => [
      fontFace(family, `${prefix}-${w}-latin`, w, LATIN),
      fontFace(family, `${prefix}-${w}-latin-ext`, w, LATIN_EXT),
    ])
    .join("");
}

export const FONT_FACES = [
  fontFaces("Space Grotesk", "space-grotesk", [400, 500, 600, 700]),
  fontFaces("Hanken Grotesk", "hanken-grotesk", [400, 500, 600, 700]),
  fontFaces("JetBrains Mono", "jetbrains-mono", [400, 500]),
].join("");

export const BASE_CSS = `
  ${FONT_FACES}
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;background:#0a0c11;}
  body{font-family:'Hanken Grotesk',sans-serif;color:#e8eaef;}
  a{color:inherit;text-decoration:none;}
  input,button,select,textarea{font-family:inherit;}
  /* Default-margin resets so promoting divs to headings/lists/tables (a11y
     semantics) doesn't regress the existing inline-styled spacing. */
  h1,h2,h3,h4,h5,h6{margin:0;font-size:inherit;font-weight:inherit;}
  ul,ol{margin:0;padding:0;list-style:none;}
  table{border-collapse:collapse;}
  /* Visually-hidden but AT-exposed (chart data table, table captions). */
  .sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
  /* Keyboard focus visibility (WCAG 2.4.7): a strong app-wide ring plus a
     denser ring on form controls. Inputs must NOT set outline:none. */
  :focus-visible{outline:2px solid #9fb4ff;outline-offset:2px;}
  input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{border-color:#4d86ff;box-shadow:0 0 0 3px rgba(77,134,255,.35);}
  ::-webkit-scrollbar{width:10px;height:10px;}
  ::-webkit-scrollbar-thumb{background:#232838;border-radius:6px;}
  ::-webkit-scrollbar-track{background:transparent;}
  @keyframes skopiaPulse{0%,100%{opacity:1;}50%{opacity:.3;}}
  /* Live-status dot: animate only when the user hasn't asked to reduce motion
     (WCAG 2.3.3). Inline animation can't be overridden by a media query, so the
     dots opt in via this class instead of an inline animation declaration. */
  .live-dot{opacity:1;}
  @media (prefers-reduced-motion: no-preference){.live-dot{animation:skopiaPulse 1.6s infinite;}}
  /* Mobile layout hooks — hidden on desktop; enabled in the @media block below. */
  .mobile-tabbar{display:none;}
  .mobile-only{display:none;}
  .mobile-more summary::-webkit-details-marker{display:none;}
  @media (max-width:768px){
    /* Keep focused controls clear of the fixed bottom tab bar (WCAG 2.4.11). */
    html{scroll-padding-bottom:84px;}
    .dash-sidebar{display:none!important;}
    .mobile-only{display:flex!important;}
    .mobile-tabbar{display:flex!important;position:fixed;left:0;right:0;bottom:0;z-index:50;align-items:stretch;justify-content:space-around;background:rgba(13,16,22,.85);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid #1b1f29;padding:6px 4px calc(env(safe-area-inset-bottom,0px) + 8px);}
    .dash-topbar{padding:14px 16px!important;flex-wrap:wrap!important;gap:12px!important;}
    .dash-content{padding:16px 16px 84px!important;scroll-padding-bottom:84px;}
    .stat-grid{grid-template-columns:repeat(2,1fr)!important;}
    .breakdown-grid{grid-template-columns:1fr!important;}
    .geo-layout{flex-direction:column!important;}
    .geo-layout>div{flex:none!important;}
  }
`.trim();

export function htmlDoc(title: string, head: string, body: string, nonce: string): string {
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

export function skopiaLogo(): string {
  return `<div style="display:flex;flex-direction:column;gap:2px;">
    <div style="width:15px;height:2px;border-radius:2px;background:#4d86ff;"></div>
    <div style="width:11px;height:2px;border-radius:2px;background:#4d86ff;opacity:.7;"></div>
    <div style="width:13px;height:2px;border-radius:2px;background:#4d86ff;opacity:.45;"></div>
  </div>`;
}

export const NAV_ITEMS = [
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
export const MOBILE_TAB_COUNT = 4;

// Site switcher <select>. Shared by the desktop sidebar and the mobile top bar.
// Change events are wired by class (`.js-site-switcher`) from the nonced script
// in appLayout, so every instance works regardless of where it renders.
export function siteSwitcher(
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
export function healthStatus(extraStyle = ""): string {
  return `<div style="${extraStyle}background:#161a23;border:1px solid #232838;border-radius:10px;padding:14px;">
      <div style="font-size:12px;color:#9aa1b2;line-height:1.5;margin-bottom:10px;">Running on your Worker. <span style="color:#2bd888;">Healthy.</span></div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b92a4;">skopia · d1 ok</div>
    </div>`;
}

// Fixed bottom tab bar — the mobile replacement for the sidebar. Hidden on
// desktop via `.mobile-tabbar{display:none}` in BASE_CSS; shown by the
// max-width:768px media query. First four items link the existing routes; the
// "More" <details> sheet (no JS) surfaces the sidebar footer (health status).
export function mobileTabbar(activeView: string, siteId: string, rangeKey: string): string {
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
      const current = active ? ' aria-current="page"' : "";
      return `<li style="flex:1;display:flex;"><a href="${fullHref}"${current} style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 2px;font-size:11px;color:${color};"><span style="width:16px;height:16px;border-radius:4px;${dot}"></span>${esc(shortLabels[id] ?? label)}</a></li>`;
    })
    .join("\n");

  // Views past MOBILE_TAB_COUNT render as full-label links in the More sheet.
  const moreLinks = NAV_ITEMS.slice(MOBILE_TAB_COUNT)
    .map(({ id, label, href }) => {
      const active = activeView === id;
      const fullHref = siteId
        ? `${href}?site=${esc(siteId)}&range=${esc(rangeKey)}`
        : `${href}?range=${esc(rangeKey)}`;
      const current = active ? ' aria-current="page"' : "";
      return `<li><a href="${fullHref}"${current} style="display:block;padding:12px 4px;font-size:14px;color:${active ? "#9fb4ff" : "#cfd4e0"};border-bottom:1px solid #161a22;">${esc(label)}</a></li>`;
    })
    .join("\n");

  return `<nav class="mobile-tabbar" aria-label="Mobile primary">
    <ul style="display:flex;flex:1;align-items:stretch;justify-content:space-around;width:100%;">
    ${tabs}
    <li style="flex:1;display:flex;"><details class="mobile-more" style="flex:1;">
      <summary style="list-style:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 2px;font-size:11px;color:#8b92a4;cursor:pointer;height:100%;"><span style="width:16px;height:16px;border-radius:4px;border:1.5px solid #3a4150;"></span>More</summary>
      <div style="position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 58px);background:#0d1016;border-top:1px solid #1b1f29;padding:18px 16px calc(env(safe-area-inset-bottom,0px) + 18px);box-shadow:0 -14px 34px rgba(0,0,0,.5);">
        ${moreLinks ? `<ul style="margin-bottom:14px;">${moreLinks}</ul>` : ""}
        ${healthStatus()}
      </div>
    </details></li>
    </ul>
  </nav>`;
}

export function sidebar(
  activeView: string,
  sites: SiteRow[],
  siteId: string,
  rangeKey: string,
): string {
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
    const current = active ? ' aria-current="page"' : "";
    return `<li><a href="${fullHref}"${current} style="${style}"><span style="${dotStyle}"></span>${esc(label)}</a></li>`;
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
    <nav aria-label="Primary"><ul>${navHtml}</ul></nav>
    ${healthStatus("margin-top:auto;")}
  </div>`;
}

export function appLayout(
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
    // Escape closes the mobile "More" sheet and returns focus to its summary
    // (WCAG 2.1.2 — no keyboard trap; a native <details> has no Escape default).
    var more=document.querySelector('.mobile-more');
    if(more){document.addEventListener('keydown',function(e){if(e.key==='Escape'&&more.open){more.open=false;var sm=more.querySelector('summary');if(sm)sm.focus();}});}
  })();</script>`;
  // The visible topbar shows only the brand mark, and the desktop-vs-mobile
  // brand elements are display:none per breakpoint — so neither can be the
  // accessible <h1>. A single always-present sr-only <h1> per view carries the
  // document title for assistive tech at every breakpoint (WCAG 2.4.6).
  const viewLabel = NAV_ITEMS.find((n) => n.id === activeView)?.label ?? "Overview";
  return `<div style="display:flex;min-height:100vh;background:#0a0c11;">
  ${sidebar(activeView, sites, site.id, rangeKey)}
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
    <header class="dash-topbar" style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:20px 32px;border-bottom:1px solid #1b1f29;">
      <div class="mobile-only" style="flex-basis:100%;align-items:center;gap:10px;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex:none;">${skopiaLogo()}<span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#fff;">Skopia</span></div>
        <div style="flex:1;min-width:0;">${siteSwitcher(sites, site.id, rangeKey)}</div>
      </div>
      <div id="live-badge" role="status" aria-live="polite" style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#2bd888;background:rgba(43,216,136,.1);padding:8px 13px;border-radius:8px;font-weight:500;">
        <span class="live-dot" style="width:7px;height:7px;border-radius:50%;background:#2bd888;"></span>
        <span id="live-count">—</span> online now
      </div>
      ${headerRight}
    </header>
    <main class="dash-content" style="flex:1;overflow:auto;padding:28px 32px 40px;"><h1 class="sr-only">${esc(site.name)} — ${esc(viewLabel)}</h1>
      ${content}
    </main>
  </div>
  ${mobileTabbar(activeView, site.id, rangeKey)}
  ${navScript}
</div>`;
}

// ---------------------------------------------------------------------------
// Range picker HTML (inline form)
// ---------------------------------------------------------------------------

export function rangePicker(currentKey: string, extraParams: string): string {
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

// Same views as the app sidebar minus Geography (not implemented until
// launch-readiness Task 3) — filtered from NAV_ITEMS so the label/id source
// never drifts from the authed sidebar.
export const PUBLIC_NAV_ITEMS = NAV_ITEMS.filter((item) => item.id !== "geography");

export function publicNav(activeView: string, token: string, rangeKey: string): string {
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
    const current = active ? ' aria-current="page"' : "";
    return `<li><a href="${fullHref}"${current} style="${style}"><span style="${dotStyle}"></span>${esc(label)}</a></li>`;
  }).join("\n");

  return `<div class="dash-sidebar" style="flex:none;width:224px;background:#0d1016;border-right:1px solid #1b1f29;padding:24px 16px;display:flex;flex-direction:column;height:100vh;position:sticky;top:0;">
    <div style="display:flex;align-items:center;gap:9px;padding:0 8px;margin-bottom:30px;">
      ${skopiaLogo()}
      <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">Skopia</span>
    </div>
    <nav aria-label="Primary"><ul>${navHtml}</ul></nav>
    <a href="https://skopia.dev" style="margin-top:auto;font-size:12px;color:#8b92a4;padding:10px 11px;">Powered by Skopia</a>
  </div>`;
}

// Public-surface bottom tab bar — the /share mirror of mobileTabbar(). Same
// fixed-bar UX and breakpoint behavior, but every href targets the /share/:token
// routes and the "More" sheet carries a "Powered by Skopia" link in place of the
// authed health-status block. Hidden on desktop, shown by the max-width:768px
// media query, exactly like the authed bar.
export function publicMobileTabbar(activeView: string, token: string, rangeKey: string): string {
  const link = (item: (typeof PUBLIC_NAV_ITEMS)[number], inMore: boolean): string => {
    const active = activeView === item.id;
    const publicHref = item.href.replace(/^\/app/, `/share/${esc(token)}`);
    const fullHref = `${publicHref}?range=${esc(rangeKey)}`;
    const current = active ? ' aria-current="page"' : "";
    if (inMore) {
      return `<li><a href="${fullHref}"${current} style="display:block;padding:12px 4px;font-size:14px;color:${active ? "#9fb4ff" : "#cfd4e0"};border-bottom:1px solid #161a22;">${esc(item.label)}</a></li>`;
    }
    const color = active ? "#9fb4ff" : "#8b92a4";
    const dot = active ? "background:#4d86ff;" : "border:1.5px solid #3a4150;";
    return `<li style="flex:1;display:flex;"><a href="${fullHref}"${current} style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 2px;font-size:11px;color:${color};"><span style="width:16px;height:16px;border-radius:4px;${dot}"></span>${esc(item.label)}</a></li>`;
  };

  const tabs = PUBLIC_NAV_ITEMS.slice(0, MOBILE_TAB_COUNT)
    .map((i) => link(i, false))
    .join("\n");
  const moreLinks = PUBLIC_NAV_ITEMS.slice(MOBILE_TAB_COUNT)
    .map((i) => link(i, true))
    .join("\n");

  return `<nav class="mobile-tabbar" aria-label="Mobile primary">
    <ul style="display:flex;flex:1;align-items:stretch;justify-content:space-around;width:100%;">
    ${tabs}
    <li style="flex:1;display:flex;"><details class="mobile-more" style="flex:1;">
      <summary style="list-style:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 2px;font-size:11px;color:#8b92a4;cursor:pointer;height:100%;"><span style="width:16px;height:16px;border-radius:4px;border:1.5px solid #3a4150;"></span>More</summary>
      <div style="position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 58px);background:#0d1016;border-top:1px solid #1b1f29;padding:18px 16px calc(env(safe-area-inset-bottom,0px) + 18px);box-shadow:0 -14px 34px rgba(0,0,0,.5);">
        ${moreLinks ? `<ul style="margin-bottom:14px;">${moreLinks}</ul>` : ""}
        <a href="https://skopia.dev" style="display:block;font-size:12px;color:#8b92a4;padding:4px 0;">Powered by Skopia</a>
      </div>
    </details></li>
    </ul>
  </nav>`;
}

/**
 * Layout for the public /share/:token surface. Mirrors appLayout's shape
 * (sidebar + topbar + content) but strips everything that leaks the authed
 * app: no site switcher, no /app or /login hrefs, no live WebSocket client.
 * `onlineCount` renders the "online now" badge only when non-null. It is now
 * a real best-effort count from a server-side `SITE_LIVE.snapshot()` read
 * (never a public WebSocket), cached alongside the rendered page for up to
 * `SHARE_CACHE_TTL_SECONDS` — a DO failure degrades to `null` (no badge),
 * never a 500.
 */
export function publicLayout(
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
    // Escape closes the mobile "More" sheet and restores focus to its summary
    // (WCAG 2.1.2 — same handling as appLayout's navScript).
    var more=document.querySelector('.mobile-more');
    if(more){document.addEventListener('keydown',function(e){if(e.key==='Escape'&&more.open){more.open=false;var sm=more.querySelector('summary');if(sm)sm.focus();}});}
  })();</script>`;

  return `<div style="display:flex;min-height:100vh;background:#0a0c11;">
  ${publicNav(activeView, token, rangeKey)}
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
    <header class="dash-topbar" style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:20px 32px;border-bottom:1px solid #1b1f29;">
      <div style="display:flex;align-items:center;gap:9px;">
        <h1 style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">${esc(site.name)}</h1>
        <span style="font-size:12px;color:#8b92a4;background:#161a23;padding:3px 8px;border-radius:5px;">read-only</span>
      </div>
      <div style="display:flex;align-items:center;gap:14px;">
        ${onlineBadge}
        ${headerRight}
      </div>
    </header>
    <main class="dash-content" style="flex:1;overflow:auto;padding:28px 32px 40px;">
      ${content}
    </main>
  </div>
  ${publicMobileTabbar(activeView, token, rangeKey)}
  ${rangeScript}
</div>`;
}

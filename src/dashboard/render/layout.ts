/**
 * Skopia — page shell: the document wrapper, the enamel casing bar (brand,
 * site switcher or share plate), the views row (tabs + range keys), the mobile
 * tab bar, and the footer plate. One shell serves both surfaces; `Chrome.surface`
 * decides every href so the /share surface never links into /app or /login
 * (ADR-0012).
 */

import type { SiteRow } from "../../shared/types";
import { esc, periodLine } from "./html";
import { DASH_CSS } from "./styles";

export const INSTALL_GUIDE_URL = "https://github.com/jasonm4130/skopia/blob/main/docs/install.md";

export const NAV_ITEMS = [
  { id: "overview", label: "Overview", short: "Overview", seg: "" },
  { id: "pages", label: "Pages", short: "Pages", seg: "/pages" },
  { id: "sources", label: "Sources", short: "Sources", seg: "/sources" },
  { id: "geography", label: "Geography", short: "Geo", seg: "/geography" },
  { id: "devices", label: "Devices", short: "Devices", seg: "/devices" },
  { id: "campaigns", label: "Campaigns", short: "Campaigns", seg: "/campaigns" },
  { id: "events", label: "Events", short: "Events", seg: "/events" },
] as const;

// Only what parseRange serves. No "Today" (the Overview's readout already has
// a today-so-far figure) and no custom range (not supported server-side).
export const RANGE_KEYS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
] as const;

// Views not served on the public surface (ADR-0012).
const SHARE_HIDDEN = new Set(["geography"]);

// The mobile bottom bar fits 4 tabs + "More"; the rest live in the More sheet.
const MOBILE_TAB_COUNT = 4;

/** Everything the shell needs to know about the current request. */
export interface Chrome {
  surface: "app" | "share";
  /** Active nav id ("overview", "pages", …). */
  view: string;
  site: SiteRow;
  /** Every site, for the switcher (app only; empty on /share). */
  sites: SiteRow[];
  /** The share token (share only; "" on /app). */
  token: string;
  rangeKey: string;
  /** First run: hide the view tabs and range keys — there is nothing to switch yet. */
  bare?: boolean;
}

/** The nav items this surface serves. */
export function navItems(ch: Chrome): (typeof NAV_ITEMS)[number][] {
  return NAV_ITEMS.filter((i) => ch.surface === "app" || !SHARE_HIDDEN.has(i.id));
}

/** Href for view `id`, preserving site (app) and range. */
export function viewHref(
  ch: Chrome,
  id: string,
  rangeKey = ch.rangeKey,
  siteId = ch.site.id,
): string {
  const seg = NAV_ITEMS.find((i) => i.id === id)?.seg ?? "";
  return ch.surface === "share"
    ? `/share/${esc(ch.token)}${seg}?range=${esc(rangeKey)}`
    : `/app${seg}?site=${esc(siteId)}&range=${esc(rangeKey)}`;
}

/**
 * The document. CSS ships inline under the request nonce (see styles.ts);
 * behaviour ships as static assets from ./public. `strict-dynamic` makes the
 * CSP ignore 'self', so every <script src> carries the nonce too.
 */
export function htmlDoc(
  title: string,
  body: string,
  nonce: string,
  opts: { bodyAttrs?: string; live?: boolean } = {},
): string {
  const live = opts.live
    ? `\n<script src="/assets/dash-live.js" nonce="${nonce}" defer></script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Skopia</title>
<link rel="preload" href="/fonts/hanken-grotesk-500-latin.woff2" as="font" type="font/woff2" crossorigin>
<style nonce="${nonce}">${DASH_CSS}</style>
<script src="/assets/dash.js" nonce="${nonce}" defer></script>${live}
</head>
<body${opts.bodyAttrs ?? ""}>
${body}
</body>
</html>`;
}

export const MARK = `<span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>`;

function bar(ch: Chrome): string {
  const home = viewHref(ch, "overview");
  if (ch.surface === "share") {
    return `<header class="bar"><div class="wrap bar-in">
    <a class="brand" href="${home}">${MARK}Skopia</a>
    <span class="bar-sep" aria-hidden="true"></span><span class="site-nm">${esc(ch.site.name)}</span>
    <span class="plate"><span class="lock" aria-hidden="true"></span>Shared view<span class="hide-s">, read-only</span></span>
    <div class="bar-end"><a href="https://skopia.dev">Counted by Skopia<span class="hide-s">, without cookies</span></a></div>
  </div></header>`;
  }
  // Site switcher: a <details> of plain links (works with no JS, no inline
  // handlers). Each link keeps the current view and range.
  const links = ch.sites
    .map(
      (s) =>
        `<li><a href="${viewHref(ch, ch.view, ch.rangeKey, s.id)}"${s.id === ch.site.id ? ' aria-current="true"' : ""}><span>${esc(s.name)}</span>${s.domain ? `<span class="dom">${esc(s.domain)}</span>` : ""}</a></li>`,
    )
    .join("");
  return `<header class="bar"><div class="wrap bar-in">
    <a class="brand" href="${home}">${MARK}Skopia</a>
    <span class="bar-sep" aria-hidden="true"></span>
    <details class="switch" id="site-switcher">
      <summary aria-label="Site: ${esc(ch.site.name)}. Switch site"><span class="nm">${esc(ch.site.name)}</span>${ch.site.domain ? ` <span class="dom">${esc(ch.site.domain)}</span>` : ""}<span class="chev" aria-hidden="true"></span></summary>
      <div class="menu">
        <ul>${links}</ul>
        <p class="menu-note">Sites are added with <code>wrangler d1 execute</code>. See the install guide.</p>
      </div>
    </details>
    <div class="bar-end"><a class="hide-s" href="${INSTALL_GUIDE_URL}">Install guide</a><a href="/logout">Sign out</a></div>
  </div></header>`;
}

function views(ch: Chrome): string {
  if (ch.bare) return "";
  const tabs = navItems(ch)
    .map(
      (i) =>
        `<li><a href="${viewHref(ch, i.id)}"${i.id === ch.view ? ' aria-current="page"' : ""}>${esc(i.label)}</a></li>`,
    )
    .join("");
  const keys = RANGE_KEYS.map(
    (k) =>
      `<a href="${viewHref(ch, ch.view, k.key)}"${k.key === ch.rangeKey ? ' aria-current="true"' : ""}>${esc(k.label)}</a>`,
  ).join("");
  return `<nav class="views" aria-label="Primary"><div class="wrap views-in">
    <ul class="tabs">${tabs}</ul>
    <div class="keys" role="group" aria-label="Date range">${keys}</div>
  </div></nav>`;
}

// Fixed bottom tab bar — the phone replacement for the top tabs (shown by the
// max-width:640px query). The "More" sheet is a <details> (no JS needed);
// dash.js adds Escape/outside-click closing.
function tabbar(ch: Chrome): string {
  if (ch.bare) return "";
  const items = navItems(ch);
  const link = (i: (typeof NAV_ITEMS)[number], label: string): string =>
    `<a href="${viewHref(ch, i.id)}"${i.id === ch.view ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const tabs = items
    .slice(0, MOBILE_TAB_COUNT)
    .map((i) => `<li>${link(i, i.short)}</li>`)
    .join("");
  const more = items
    .slice(MOBILE_TAB_COUNT)
    .map((i) => `<li>${link(i, i.label)}</li>`)
    .join("");
  return `<nav class="tabbar" aria-label="Mobile primary"><ul>${tabs}<li><details class="tab-more"><summary>More</summary><ul class="sheet">${more}</ul></details></li></ul></nav>`;
}

function footer(ch: Chrome): string {
  const [l, r] =
    ch.surface === "share"
      ? [
          `<b>A read-only view</b> shared by this site&rsquo;s owner. It shows counts only; no visitor can be singled out.`,
          `Times are UTC. Counted by <a href="https://skopia.dev">Skopia</a>, without cookies.`,
        ]
      : [
          `<b>Running on your Worker.</b> Your data stays in your Cloudflare account.`,
          `Times are UTC. No cookies were set to count any of this.`,
        ];
  return `<footer class="foot"><div class="wrap foot-in"><span>${l}</span><span>${r}</span></div></footer>`;
}

/** The whole page body: skip link, casing bar, views row, main, footer, tab bar. */
export function shell(ch: Chrome, main: string, opts: { full?: boolean } = {}): string {
  return `<a class="skip" href="#main">Skip to content</a>
${bar(ch)}
${views(ch)}
<main id="main" class="wrap${opts.full ? " full" : ""}">
${main}
</main>
${footer(ch)}
${tabbar(ch)}`;
}

/** Breakdown-page head: the h1, the period line, and one computed sentence. */
export function pageHead(
  title: string,
  range: { from: string; to: string; label: string },
  say: string,
): string {
  return `<section class="page-h" aria-labelledby="page-h">
    <div><h1 id="page-h">${esc(title)}</h1><p class="period">${periodLine(range)}</p></div>
    ${say ? `<p class="say">${say}</p>` : ""}
  </section>`;
}

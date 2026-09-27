/**
 * Skopia — the Overview's instruments: the headline sentence, the readout row,
 * the daily-traffic scope (SVG bars + a visible "every day as a table"
 * fallback), the online-now compartment, and the footnotes.
 */

import type { BreakdownRow, StatCards, TimeSeriesPoint } from "../../shared/types";
import { countryName } from "./atlas";
import { est, fn } from "./breakdown";
import { compact, dlong, dshort, esc, n, pct, periodLine } from "./html";

/** Server-side snapshot of the SiteLive DO: count + active pages. */
export interface LiveView {
  visitors: number;
  topPages: BreakdownRow[];
}

const word = (x: number, one: string, many: string): string => (x === 1 ? one : many);

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

/**
 * ONE computed sentence, from data the page already fetched: which source
 * brought the largest share of pageviews and which country sent the most
 * visitors — each with a tie check, so a tie is never reported as a lead.
 */
export function headlineSentence(
  cards: StatCards,
  topSources: BreakdownRow[],
  topCountries: BreakdownRow[],
): string {
  if (cards.pageviews === 0) return "No pageviews in this range yet.";
  const parts: string[] = [];

  const s0 = topSources[0];
  if (s0) {
    const ties = topSources.filter((r) => r.pageviews === s0.pageviews);
    const share = pct(s0.share);
    parts.push(
      ties.length === 1
        ? `<b>${esc(s0.label)}</b> brought ${share} of pageviews`
        : ties.length === 2
          ? `<b>${esc(s0.label)}</b> and <b>${esc(ties[1]?.label)}</b> tie at ${share} of pageviews each`
          : `${ties.length} sources tie at ${share} of pageviews each`,
    );
  }

  const c0 = topCountries[0];
  if (c0) {
    const ties = topCountries.filter((r) => r.visitors === c0.visitors);
    parts.push(
      ties.length === 1
        ? `<b>${esc(countryName(c0.label))}</b> sent the most visitors`
        : ties.length === 2
          ? `<b>${esc(countryName(c0.label))}</b> and <b>${esc(countryName(ties[1]?.label ?? ""))}</b> tie for the most visitors`
          : `${ties.length} countries tie for the most visitors`,
    );
  }

  if (!parts.length) return `${n(cards.pageviews)} pageviews in this range.`;
  const s = `${parts.join("; ")}.`;
  // Sentence case even when the first part is a figure or a lower-case host.
  return /^[a-z]/.test(s) ? s[0]?.toUpperCase() + s.slice(1) : s;
}

export function headline(
  title: string,
  range: { from: string; to: string; label: string },
  say: string,
  live: LiveView | null,
): string {
  // Phones get a compact live chip that jumps to the compartment below.
  const chip = live
    ? `<a class="live-chip${live.visitors ? "" : " zero"}" href="#live"><span class="ldot${live.visitors ? "" : " zero"}" aria-hidden="true"></span><b data-live-n>${n(live.visitors)}</b> online now</a>`
    : "";
  return `<section class="head" aria-labelledby="page-h">
      <div><h1 id="page-h">${esc(title)}</h1><p class="period">${periodLine(range)}</p></div>
      <p class="say">${say}</p>
      ${chip}
    </section>`;
}

// ---------------------------------------------------------------------------
// Readout row
// ---------------------------------------------------------------------------

/**
 * Visitors, Pageviews (+ views per visitor), and Today so far. No
 * single-page-visit figure: the rollup's estimate clamps to 0% on almost every
 * real site, and a wrong number shown confidently is worse than none.
 */
export function readout(cards: StatCards, series: TimeSeriesPoint[]): string {
  const today = series.at(-1) ?? { pageviews: 0, visitors: 0 };
  const e = est(cards.sampled);
  const big = (x: number): string => (n(x).length > 6 ? " long" : "");
  const vpv =
    cards.visitors > 0
      ? `<dd class="ro-sub"><b>${cards.viewsPerVisitor.toFixed(1)}</b> views per visitor</dd>`
      : "";
  return `<dl class="readout">
      <div class="ro"><dt>Visitors${fn(1)}</dt><dd class="num${big(cards.visitors)}">${e}${n(cards.visitors)}</dd></div>
      <div class="ro"><dt>Pageviews</dt><dd class="num${big(cards.pageviews)}">${e}${n(cards.pageviews)}</dd>${vpv}</div>
      <div class="ro ro-t"><dt><i class="hx" aria-hidden="true"></i>Today so far</dt><dd class="num">${n(today.pageviews)}<span class="u"> ${word(today.pageviews, "pageview", "pageviews")}</span></dd><dd class="ro-sub"><b>${n(today.visitors)}</b> ${word(today.visitors, "visitor", "visitors")} &middot; the day closes at 00:00 UTC</dd></div>
    </dl>`;
}

// ---------------------------------------------------------------------------
// Daily-traffic scope
// ---------------------------------------------------------------------------

/** Round an axis maximum up to 1, 2, 2.5, 4, 5 or 10 × a power of ten. */
function niceMax(m: number): number {
  if (m <= 0) return 4;
  const k = 10 ** Math.floor(Math.log10(m));
  for (const s of [1, 2, 2.5, 4, 5, 10]) if (s * k >= m) return s * k;
  return 10 * k;
}

function peakOf(arr: number[]): number {
  let k = 0;
  arr.forEach((x, i) => {
    if (x > (arr[k] ?? 0)) k = i;
  });
  return k;
}

function chart(series: TimeSeriesPoint[], rangeLabel: string): { broken: boolean; html: string } {
  const N = series.length;
  const today = N - 1;
  const P = series.map((p) => p.pageviews);
  const V = series.map((p) => p.visitors);
  const sorted = [...P].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted.find((x) => x < top) ?? 0;
  // One outlier day flattens everything else to the baseline. Cut it to fit
  // instead, and say so with a visible break and its real value on top.
  const broken = second > 0 && top > 4 * second;
  const max = broken ? niceMax(second * 2.2) : niceMax(Math.max(top, ...V));
  const sparse = P.filter(Boolean).length <= 12;
  const pk = peakOf(P);
  const H = (x: number): number => Math.min(100, Math.max(3, (x / max) * 100));

  const cols = P.map((p, i) => {
    if (!p) return "";
    const h = H(p);
    const cut = broken && p > max;
    const v = V[i] ?? 0;
    const hv = v ? Math.min(h, Math.max(2.4, (v / max) * 100)) : 0;
    return (
      `<rect class="col${i === today ? " today" : ""}" data-i="${i}" x="${i * 10 + 1}" y="${(100 - h).toFixed(2)}" width="8" height="${h.toFixed(2)}"/>` +
      (hv
        ? `<rect class="vis" x="${i * 10 + 3.5}" y="${(100 - hv).toFixed(2)}" width="3" height="${hv.toFixed(2)}"/>`
        : "") +
      (cut
        ? `<rect class="brk" x="${i * 10}" y="16" width="10" height="3.2"/><rect class="brk" x="${i * 10}" y="22" width="10" height="1.6"/>`
        : "")
    );
  }).join("");

  // Sparse data: every bar carries its value, so gridlines would repeat it.
  // Dense data: gridlines, and only the peak and today labelled.
  const vls = P.map((p, i) => ({ p, i }))
    .filter(({ p, i }) => p && (sparse || i === pk || i === today))
    .map(
      ({ p, i }) =>
        `<span class="vl${i === pk ? " pk" : ""}" style="left:${(((i + 0.5) / N) * 100).toFixed(3)}%;bottom:calc(${H(p).toFixed(2)}% + 6px)">${sparse ? n(p) : compact(p)}</span>`,
    )
    .join("");
  const grid = sparse
    ? `<div class="gl base" style="bottom:0"></div>`
    : [0, max / 2, max]
        .map(
          (t) =>
            `<div class="gl${t === 0 ? " base" : ""}" style="bottom:${(t / max) * 100}%"><span>${compact(t)}</span></div>`,
        )
        .join("");

  const step = N > 45 ? 14 : 7;
  const xl = series
    .map((d, i) => {
      const show = (i % step === 0 || i === today) && !(i !== today && today - i < 4);
      if (!show) return "";
      const cls = i === today ? "now" : i === 0 ? "x0" : "opt";
      return `<span class="${cls}" style="left:${(((i + (i === 0 ? 0 : 0.5)) / N) * 100).toFixed(3)}%">${i === today ? "Today" : dshort(d.day)}</span>`;
    })
    .join("");

  // The visible, keyboard-reachable fallback for the SVG (WCAG 1.1.1): every
  // day as a table, newest first, behind a disclosure.
  const rows = [...series]
    .reverse()
    .map(
      (d, j) =>
        `<tr><th scope="row">${dlong(d.day)}${j === 0 ? ", today so far" : ""}</th><td>${n(d.pageviews)}</td><td>${n(d.visitors)}</td></tr>`,
    )
    .join("");
  const table = `<details class="days"><summary>Every day as a table</summary>
        <div class="days-wrap" tabindex="0"><table>
          <caption class="sr-only">Daily pageviews and visitors, ${esc(rangeLabel)}</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">Pageviews</th><th scope="col">Visitors</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </details>`;

  const html = `<div class="plot${sparse ? " sparse" : ""}" tabindex="0" role="group" aria-label="Daily traffic chart. Arrow keys read one day at a time; every day is also in the table below." data-days="${series.map((d) => d.day).join(",")}" data-p="${P.join(",")}" data-v="${V.join(",")}">
        ${grid}
        <svg viewBox="0 0 ${N * 10} 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="3" fill="#434c45"/><rect width="1.1" height="3" fill="#99a297"/></pattern>
            <pattern id="hatch-on" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="3" fill="#5b665d"/><rect width="1.1" height="3" fill="#b9c2b6"/></pattern>
          </defs>
          ${cols}
        </svg>
        ${vls}
        <span class="guide" aria-hidden="true"></span>
      </div>
      <div class="xax" aria-hidden="true">${xl}</div>
      <p class="sr-only" id="plot-say" aria-live="polite"></p>
      ${table}`;
  return { broken, html };
}

export function scope(series: TimeSeriesPoint[], rangeLabel: string): string {
  const t = series.at(-1);
  const c = chart(series, rangeLabel);
  const def = t
    ? `<span class="rd">${dlong(t.day)}, today so far</span> <b>${n(t.pageviews)}</b> ${word(t.pageviews, "pageview", "pageviews")} <b>${n(t.visitors)}</b> ${word(t.visitors, "visitor", "visitors")}`
    : "";
  return `<div class="scope">
      <div class="scope-top">
        <h2 id="traffic-h">Daily traffic</h2>
        <p class="key" aria-hidden="true"><span><i class="sw-col"></i>Pageviews</span><span><i class="sw-vis"></i>Visitors</span><span><i class="sw-today"></i>Today, incomplete</span>${c.broken ? `<span><i class="sw-brk"></i>Cut to fit</span>` : ""}</p>
      </div>
      <p class="readline">${def}</p>
      ${c.html}
    </div>`;
}

// ---------------------------------------------------------------------------
// Online now
// ---------------------------------------------------------------------------

/** One active-page row. The bar is scaled to the busiest page (transform only). */
export function activePageRow(p: BreakdownRow, max: number): string {
  return `<li data-path="${esc(p.label)}"><span class="p">${esc(p.label)}</span><span class="c">${n(p.visitors)}</span><i class="bar-l" aria-hidden="true" style="--s:${(p.visitors / Math.max(1, max)).toFixed(3)}"></i></li>`;
}

const NOBODY = `<li class="none">Nobody is on the site right now. Pages show up here as visitors arrive.</li>`;

/**
 * The online-now compartment. At zero it collapses to a one-line glass strip
 * (grey figure, hollow dot); above zero it is the full compartment with the
 * lime count and — on the authed surface — the active pages. The server picks
 * the initial state; dash-live.js toggles it as snapshots arrive.
 */
export function livePanel(live: LiveView, opts: { share: boolean }): string {
  const v = live.visitors;
  const zero = v === 0;
  const dot = `<span class="ldot${zero ? " zero" : ""}" aria-hidden="true"></span>`;
  const max = Math.max(1, ...live.topPages.map((p) => p.visitors));
  const pages = opts.share
    ? ""
    : `<h3><span>Active pages</span><span>Visitors</span></h3>
        <ul class="apages" id="live-pages">${live.topPages.length ? live.topPages.map((p) => activePageRow(p, max)).join("") : NOBODY}</ul>`;
  const foot = opts.share
    ? `Counted when this page was built. Shared pages are cached for up to a minute.`
    : `<b class="js-status">Count at page load.</b> A visitor stays online for 5 minutes after their last pageview.`;
  return `<section class="live${zero ? " is-zero" : ""}" id="live" aria-labelledby="live-h">
      <div class="live-full${opts.share ? " solo" : ""}">
        <h2 id="live-h">${dot}Online now</h2>
        <p class="live-n"><span class="odo${zero ? " zero" : ""}" data-odo aria-hidden="true">${v}</span><small data-live-unit>${word(v, "visitor", "visitors")} in the last 5&nbsp;minutes</small></p>
        ${pages}
        <p class="live-foot">${foot}</p>
      </div>
      <p class="live-strip" aria-hidden="true">${dot}<span class="odo${zero ? " zero" : ""}" data-odo>${v}</span> online now <span class="sep">&middot;</span> last 5 minutes${opts.share ? "" : ` <span class="st js-status">Count at page load.</span>`}</p>
      <p class="sr-only" role="status" id="live-say">${n(v)} ${word(v, "visitor", "visitors")} online now</p>
    </section>`;
}

/** The display console: scope + (optionally) the online-now compartment. */
export function trafficConsole(
  series: TimeSeriesPoint[],
  rangeLabel: string,
  live: LiveView | null,
  opts: { share: boolean },
): string {
  const cls = live === null ? " nolive" : live.visitors === 0 ? " idle" : "";
  return `<section class="glass console${cls}" aria-labelledby="traffic-h">
    ${scope(series, rangeLabel)}
    ${live ? livePanel(live, opts) : ""}
  </section>`;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function visitorsNote(rangeLabel: string): string {
  const span = rangeLabel.toLowerCase().replace("last ", "").replace(" days", "-day");
  return `<ol class="notes">
      <li id="fn-1"><span>1</span><span>Visitors is the sum of each day&rsquo;s unique visitors, so someone who returns on another day counts again and a ${esc(span)} total runs above the number of people. In the tables, a visitor counts once in every row they touch, which is why rows can add up to more than the <i>Whole site</i> line.</span></li>
    </ol>`;
}

export function sampledNotice(sampled: boolean): string {
  return sampled
    ? `<p class="notice" role="note"><span class="hatch" aria-hidden="true"></span><span><strong>Some of this range is estimated.</strong> Part of it was built from sampled events, so figures marked &asymp; are estimates rather than exact counts.</span></p>`
    : "";
}

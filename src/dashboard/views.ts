/**
 * Skopia — the dashboard's view table. Each breakdown view (Pages, Sources,
 * Geography, Devices, Campaigns, Events) is defined ONCE here: its queries and
 * its content builder. The authed /app/* routes and the public /share/:token/*
 * routes both register from this table, so a view's columns can't drift
 * between the two surfaces.
 */

import {
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
} from "../db/queries";
import type { BreakdownRow, SiteRow } from "../shared/types";
import type { parseRange } from "./range";
import { atlas, countryName } from "./render/atlas";
import { bdTable, isDevHost, miniTable, SORT_MARK } from "./render/breakdown";
import { esc, n, pct, plural } from "./render/html";
import { type Chrome, INSTALL_GUIDE_URL, pageHead, viewHref } from "./render/layout";
import {
  headline,
  headlineSentence,
  type LiveView,
  readout,
  sampledNotice,
  trafficConsole,
  visitorsNote,
} from "./render/overview";

export type RangeInfo = ReturnType<typeof parseRange>;

/** Everything a view's content builder needs for one request. */
export interface ViewCtx {
  db: D1Database;
  site: SiteRow;
  range: RangeInfo;
  nonce: string;
  /** The page shell's view of this request (surface, hrefs). */
  ch: Chrome;
  /** Server-side online-now snapshot; null when it could not be read. */
  live: LiveView | null;
}

export interface BreakdownView {
  /** Nav id and URL segment: /app/{id}, /share/:token/{id}. */
  id: string;
  /** Document-title prefix, e.g. "Pages — {site}". */
  title: string;
  /** Served on the public /share surface (ADR-0012). */
  shared: boolean;
  /** A wide ruled table: taller rows, stacked cells on a phone. */
  full?: boolean;
  /** The head's computed sentence and the page body. */
  content(ctx: ViewCtx): Promise<{ say: string; body: string }>;
}

/**
 * Overview body shared by /app and /share/:token. Both show the online-now
 * count from the server-side snapshot; only the authed surface lists active
 * pages and connects the live socket (ADR-0012: no public WebSocket, no
 * per-page live detail in public).
 */
export async function overviewContent(ctx: ViewCtx, opts: { share: boolean }): Promise<string> {
  const { db, site, range, ch, live } = ctx;
  const [cards, series, topPages, topSources, topCountries, devices, browsers, oses] =
    await Promise.all([
      getStatCards(db, site.id, range),
      getTimeSeries(db, site.id, range),
      getTopPages(db, site.id, range, 6),
      getTopSources(db, site.id, range, 6),
      getTopCountries(db, site.id, range, 8),
      opts.share ? [] : getTopDevices(db, site.id, range, 5),
      opts.share ? [] : getTopBrowsers(db, site.id, range, 5),
      opts.share ? [] : getTopOperatingSystems(db, site.id, range, 5),
    ]);

  const siteTotals = {
    visitors: cards.visitors,
    pageviews: cards.pageviews,
    sampled: cards.sampled,
  };
  const compact = (caption: string, labelHead: string, rows: BreakdownRow[], mono = false) =>
    bdTable({
      caption,
      labelHead,
      rows,
      mono,
      columns: [
        { key: "visitors", label: "Visitors" },
        { key: "pageviews", label: "Pageviews" },
      ],
      orderBy: "pageviews",
      site: siteTotals,
      foot: "whole",
    });
  const more = (id: string, label: string) =>
    `<a class="more" href="${viewHref(ch, id)}">${label} <span aria-hidden="true">&rarr;</span></a>`;

  const devicesSec = opts.share
    ? ""
    : `<section class="sec devs" aria-labelledby="dev-h">
      <div class="sec-h"><h2 id="dev-h">Devices</h2>${more("devices", "Details")}</div>
      <div class="dgrid">${miniTable("Device type", devices, cards.sampled)}${miniTable("Browser", browsers, cards.sampled)}${miniTable("Operating system", oses, cards.sampled)}</div>
    </section>`;

  return `
    ${sampledNotice(cards.sampled)}
    ${headline("Overview", range, headlineSentence(cards, topSources, topCountries), live)}
    ${readout(cards, series)}
    ${trafficConsole(series, range.label, live, opts)}
    ${visitorsNote(range.label)}
    <div class="pair sec">
      <section aria-labelledby="pages-h">
        <div class="sec-h"><h2 id="pages-h">Top pages</h2>${more("pages", "All pages")}</div>
        ${compact("Top pages", "Page", topPages, true)}
      </section>
      <section aria-labelledby="src-h">
        <div class="sec-h"><h2 id="src-h">Top sources</h2>${more("sources", "All sources")}</div>
        ${compact("Top sources", "Source", topSources)}
      </section>
    </div>
    <div class="sec">${atlas(topCountries, { sampled: cards.sampled, more: opts.share ? undefined : viewHref(ch, "geography") })}</div>
    ${devicesSec}
  `;
}

// ---------------------------------------------------------------------------
// Breakdown views
// ---------------------------------------------------------------------------

const LEGEND = `<p class="legend">${SORT_MARK} marks the column each list is ordered by. Bars are scaled to that column&rsquo;s largest row.</p>`;

/** "4 sources" — or "The top 50 sources" when the query hit its row limit. */
function counted(rows: BreakdownRow[], limit: number, one: string, many: string): string {
  return rows.length >= limit ? `The top ${n(limit)} ${many}` : plural(rows.length, one, many);
}

/**
 * The leader of a list ordered by `key`, phrased with a tie check:
 * "<b>/</b> drew the most", "<b>a</b> and <b>b</b> tie", "3 pages tie".
 */
function leader(
  rows: BreakdownRow[],
  key: "visitors" | "pageviews",
  label: (r: BreakdownRow) => string,
  many: string,
): { text: string; tie: boolean } | null {
  const r0 = rows[0];
  if (!r0) return null;
  const ties = rows.filter((r) => r[key] === r0[key]);
  if (ties.length === 1) return { text: `<b>${esc(label(r0))}</b>`, tie: false };
  if (ties.length === 2)
    return { text: `<b>${esc(label(r0))}</b> and <b>${esc(label(ties[1] ?? r0))}</b>`, tie: true };
  return { text: `${ties.length} ${many}`, tie: true };
}

/** Footnotes under a full table: what each figure is counted from. */
function basis(notes: [number, string, string][]): string {
  return `<div class="basis">${notes.map(([k, h, body]) => `<p id="fn-${k}"><strong>${k} &middot; ${h}</strong>${body}</p>`).join("")}</div>`;
}

const VISITORS_BASIS = (sum: number, site: number, what: string): string =>
  `A visitor counts once per day in each ${what}. ${
    sum > site
      ? `These rows add up to ${n(sum)} against ${n(site)} for the whole site, so this column doesn&rsquo;t sum.`
      : "Rows can add up to more than the site total when visitors touch several of them."
  }`;

const SITE_BASIS = `Visitors and pageviews for the whole site, from the same daily counts as the Overview. Not the sum of the rows above.`;

// dimension='event' counts one "pageview" per fire (event-dimensions.ts),
// so the column is labeled Count — Pageviews would be a lie here.
const NO_EVENTS = `<p class="bd-none">No custom events in this range. Fire one from your site with <code>${esc("skopia('event', 'signup')")}</code> or <code>${esc("skopia.track('signup')")}</code>; the <a href="${INSTALL_GUIDE_URL}">install guide</a> has the details.</p>`;

const NO_CAMPAIGNS = `<p class="bd-none">No campaign-tagged visits in this range. Add <code>?utm_source=&hellip;&amp;utm_campaign=&hellip;</code> to the links you share and they show up here.</p>`;

/**
 * A breakdown view's full page body: its head and one computed sentence, then
 * its content. Wide tables get the `.full` treatment (taller rows, stacked
 * cells on a phone).
 */
export async function breakdownPage(view: BreakdownView, ctx: ViewCtx): Promise<string> {
  const { say, body } = await view.content(ctx);
  const html = pageHead(view.title, ctx.range, say) + body;
  return view.full ? `<div class="full">${html}</div>` : html;
}

export const BREAKDOWN_VIEWS: BreakdownView[] = [
  {
    id: "pages",
    title: "Pages",
    shared: true,
    full: true,
    async content({ db, site, range }) {
      const [cards, rows] = await Promise.all([
        getStatCards(db, site.id, range),
        getTopPages(db, site.id, range, 50),
      ]);
      const top = leader(rows, "pageviews", (r) => r.label, "pages");
      const sum = rows.reduce((a, r) => a + r.visitors, 0);
      const say =
        cards.pageviews === 0 || !top
          ? "No pageviews in this range yet."
          : `${counted(rows, 50, "page", "pages")} drew ${plural(cards.pageviews, "pageview", "pageviews")}. ${top.text} ${top.tie ? "tie for" : "drew"} the most: ${pct(rows[0]?.share ?? 0)} of them${top.tie ? " each" : ""}.`;
      return {
        say,
        body: `${sampledNotice(cards.sampled)}
      ${bdTable({
        caption: `Pages, ${range.label}`,
        labelHead: "Page",
        rows,
        mono: true,
        columns: [
          { key: "visitors", label: "Visitors", note: 1 },
          { key: "pageviews", label: "Pageviews" },
        ],
        orderBy: "pageviews",
        site: cards,
        foot: "sum",
      })}
      ${rows.length ? LEGEND : ""}
      ${
        rows.length
          ? basis([
              [1, "Visitors per page", VISITORS_BASIS(sum, cards.visitors, "page they view")],
              [2, "Site total", SITE_BASIS],
            ])
          : ""
      }`,
      };
    },
  },
  {
    id: "sources",
    title: "Sources",
    shared: true,
    full: true,
    async content({ db, site, range }) {
      const [cards, rows] = await Promise.all([
        getStatCards(db, site.id, range),
        getTopSources(db, site.id, range, 50),
      ]);
      const top = leader(rows, "pageviews", (r) => r.label, "sources");
      const sum = rows.reduce((a, r) => a + r.visitors, 0);
      const say =
        cards.pageviews === 0 || !top
          ? "No pageviews in this range yet."
          : `${counted(rows, 50, "source", "sources")} sent ${plural(cards.pageviews, "pageview", "pageviews")}. ${top.text} ${top.tie ? "tie for" : "brought"} the most: ${pct(rows[0]?.share ?? 0)} of them${top.tie ? " each" : ""}.`;

      // The collector folds same-site referrers into (direct) only when the
      // site has a domain set (src/collector/index.ts); without one, clicks
      // between your own pages arrive under your own hostname.
      const direct = rows.some((r) => r.label === "(direct)")
        ? site.domain
          ? `<code>(direct)</code> is every pageview without an outside referrer: a typed address, a bookmark, an app that withholds it, or a click between your own pages.`
          : `<code>(direct)</code> is every pageview without a referrer: a typed address, a bookmark, or an app that withholds it. Clicks between your own pages show up under your own hostname until this site has a domain set.`
        : "";
      const dev = rows.find((r) => isDevHost(r.label));
      const devNote = dev
        ? ` <code>${esc(dev.label)}</code> is most likely a page with the snippet opened from a dev server. It is counted like any other referrer; load the snippet only in production builds to keep it out.`
        : "";
      return {
        say,
        body: `${sampledNotice(cards.sampled)}
      ${bdTable({
        caption: `Sources, ${range.label}`,
        labelHead: "Source",
        rows,
        columns: [
          { key: "visitors", label: "Visitors", note: 1 },
          { key: "pageviews", label: "Pageviews" },
          { key: "share", label: "% of views", note: 2 },
        ],
        orderBy: "pageviews",
        site: cards,
        foot: "sum",
      })}
      ${rows.length ? LEGEND : ""}
      ${
        rows.length
          ? basis([
              [
                1,
                "Visitors per source",
                VISITORS_BASIS(sum, cards.visitors, "source they arrive from"),
              ],
              [
                2,
                "% of views",
                `Each row&rsquo;s pageviews divided by all ${n(cards.pageviews)} pageviews in the range.`,
              ],
              [3, "Site total", SITE_BASIS],
            ])
          : ""
      }
      ${direct || devNote ? `<p class="aside">${direct}${devNote}</p>` : ""}`,
      };
    },
  },
  {
    // Not on the public surface (ADR-0012): the heaviest view.
    id: "geography",
    title: "Geography",
    shared: false,
    async content({ db, site, range }) {
      const rows = await getTopCountries(db, site.id, range, 250);
      const top = leader(rows, "visitors", (r) => countryName(r.label), "countries");
      const sampled = rows.some((r) => r.sampled);
      const say = !top
        ? "No countries recorded in this range yet."
        : `Visitors came from ${plural(rows.length, "country", "countries")}. ${top.text} ${top.tie ? "tie for" : "sent"} the most: ${plural(rows[0]?.visitors ?? 0, "visitor", "visitors")}${top.tie ? " each" : ""}.`;
      return { say, body: atlas(rows, { sampled, headingId: "geo-h" }) };
    },
  },
  {
    id: "devices",
    title: "Devices",
    shared: true,
    async content({ db, site, range }) {
      const [devices, browsers, oses] = await Promise.all([
        getTopDevices(db, site.id, range, 10),
        getTopBrowsers(db, site.id, range, 10),
        getTopOperatingSystems(db, site.id, range, 10),
      ]);
      const lead = (rows: BreakdownRow[], what: string): string | null => {
        const t = leader(rows, "visitors", (r) => r.label, what);
        return t ? `${t.text} ${t.tie ? "tie in" : "leads"} ${what}` : null;
      };
      const parts = [
        lead(devices, "device types"),
        lead(browsers, "browsers"),
        lead(oses, "operating systems"),
      ].filter(Boolean);
      const sampled = [...devices, ...browsers, ...oses].some((r) => r.sampled);
      return {
        say: parts.length
          ? `By visitors, ${parts.join("; ")}.`
          : "No visits recorded in this range yet.",
        body: `<div class="dgrid">${miniTable("Device type", devices, sampled)}${miniTable("Browser", browsers, sampled)}${miniTable("Operating system", oses, sampled)}</div>
      ${LEGEND}`,
      };
    },
  },
  {
    id: "campaigns",
    title: "Campaigns",
    shared: true,
    async content({ db, site, range }) {
      const [utmSources, utmMediums, utmCampaigns] = await Promise.all([
        getTopUtmSources(db, site.id, range, 10),
        getTopUtmMediums(db, site.id, range, 10),
        getTopUtmCampaigns(db, site.id, range, 10),
      ]);
      const all = [utmSources, utmMediums, utmCampaigns];
      if (all.every((rows) => rows.length === 0))
        return { say: "No campaign-tagged visits in this range.", body: NO_CAMPAIGNS };
      const table = (title: string, rows: BreakdownRow[]) =>
        `<div class="dcol">${bdTable({
          caption: title,
          labelHead: title,
          rows,
          columns: [
            { key: "visitors", label: "Visitors" },
            { key: "pageviews", label: "Pageviews" },
          ],
          orderBy: "pageviews",
          sampled: rows.some((r) => r.sampled),
        })}</div>`;
      const top = leader(utmCampaigns, "pageviews", (r) => r.label, "campaigns");
      const say = top
        ? `${top.text} ${top.tie ? "tie as the top campaigns" : "is the top campaign"}: ${plural(utmCampaigns[0]?.pageviews ?? 0, "pageview", "pageviews")}${top.tie ? " each" : ""}.`
        : "Visits carry UTM tags, but none name a campaign.";
      return {
        say,
        body: `<div class="dgrid">${table("UTM source", utmSources)}${table("UTM medium", utmMediums)}${table("UTM campaign", utmCampaigns)}</div>
      ${LEGEND}`,
      };
    },
  },
  {
    id: "events",
    title: "Events",
    shared: true,
    full: true,
    async content({ db, site, range }) {
      const rows = await getTopEvents(db, site.id, range, 50);
      if (rows.length === 0) return { say: "No custom events in this range.", body: NO_EVENTS };
      const fired = rows.reduce((a, r) => a + r.pageviews, 0);
      const top = leader(rows, "pageviews", (r) => r.label, "events");
      const say = `${counted(rows, 50, "event", "events")} fired ${plural(fired, "time", "times")}. ${top?.text} ${top?.tie ? "tie for" : "fired"} the most: ${plural(rows[0]?.pageviews ?? 0, "time", "times")}${top?.tie ? " each" : ""}.`;
      return {
        say,
        body: `${bdTable({
          caption: `Events, ${range.label}`,
          labelHead: "Event",
          rows,
          mono: true,
          columns: [
            { key: "pageviews", label: "Count" },
            { key: "visitors", label: "Visitors" },
          ],
          orderBy: "pageviews",
          sampled: rows.some((r) => r.sampled),
        })}
      ${LEGEND}`,
      };
    },
  },
];

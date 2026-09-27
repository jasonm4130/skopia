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
import type { SiteRow } from "../shared/types";
import type { parseRange } from "./range";
import { statCardsHtml, timeSeriesChartHtml } from "./render/charts";
import { esc, fmtNum, jsonForScript } from "./render/html";
import { breakdownCard, breakdownTable } from "./render/tables";

export type RangeInfo = ReturnType<typeof parseRange>;

/** Everything a view's content builder needs for one request. */
export interface ViewCtx {
  db: D1Database;
  site: SiteRow;
  range: RangeInfo;
  nonce: string;
}

export interface BreakdownView {
  /** Nav id and URL segment: /app/{id}, /share/:token/{id}. */
  id: string;
  /** Document-title prefix, e.g. "Pages — {site}". */
  title: string;
  /** Served on the public /share surface (ADR-0012). */
  shared: boolean;
  content(ctx: ViewCtx): Promise<string>;
}

/**
 * Overview body shared by /app and /share/:token. The authed variant appends
 * the live active-pages panel (it has a WebSocket to fill it); the public one
 * never does (ADR-0012: no public WebSocket).
 */
export async function overviewContent(ctx: ViewCtx, opts: { share: boolean }): Promise<string> {
  const { db, site, range, nonce } = ctx;
  const [cards, series, topPages, topSources, topCountries] = await Promise.all([
    getStatCards(db, site.id, range),
    getTimeSeries(db, site.id, range),
    getTopPages(db, site.id, range, 5),
    getTopSources(db, site.id, range, 5),
    getTopCountries(db, site.id, range, 5),
  ]);

  const livePanel = opts.share
    ? ""
    : `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;margin-top:14px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
        <span class="live-dot" style="width:7px;height:7px;border-radius:50%;background:#2bd888;"></span>
        <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;">Active pages right now</h2>
      </div>
      <ul id="live-pages-list" aria-live="polite" style="display:flex;flex-direction:column;gap:13px;">
        <li style="color:#8b92a4;font-size:13px;">Waiting for live data&hellip;</li>
      </ul>
    </div>`;

  return `
    ${statCardsHtml(cards, cards.sampled)}
    ${timeSeriesChartHtml(series, range.label, site.id, range.key, nonce)}
    <div class="breakdown-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
      ${breakdownCard("Top pages", topPages, "#4d86ff")}
      ${breakdownCard("Top sources", topSources, "#7a5cff")}
    </div>
    ${breakdownCard("Top countries", topCountries, "#2bd888")}
    ${livePanel}
  `;
}

// dimension='event' counts one "pageview" per fire (event-dimensions.ts),
// so the column is labeled Count — Pageviews would be a lie here.
const NO_EVENTS_HTML = `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:60px 24px;text-align:center;">
      <div style="color:#cfd4e0;font-size:14px;margin-bottom:8px;">No custom events in this period.</div>
      <div style="color:#8b92a4;font-size:13px;line-height:1.6;">Fire one from your site with <code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">${esc("skopia('event', 'signup')")}</code> or <code style="font-family:'JetBrains Mono',monospace;color:#9fb4ff;">${esc("skopia.track('signup')")}</code> — see docs/install.md.</div>
    </div>`;

export const BREAKDOWN_VIEWS: BreakdownView[] = [
  {
    id: "pages",
    title: "Pages",
    shared: true,
    async content({ db, site, range }) {
      const rows = await getTopPages(db, site.id, range, 50);
      return breakdownTable(
        [
          { label: "Page", key: "label", mono: true },
          { label: "Visitors", key: "visitors" },
          { label: "Pageviews", key: "pageviews" },
        ],
        rows,
      );
    },
  },
  {
    id: "sources",
    title: "Sources",
    shared: true,
    async content({ db, site, range }) {
      const rows = await getTopSources(db, site.id, range, 50);
      return breakdownTable(
        [
          { label: "Source", key: "label" },
          { label: "Visitors", key: "visitors" },
          { label: "Pageviews", key: "pageviews" },
          { label: "% of views", key: "share" },
        ],
        rows,
      );
    },
  },
  {
    // Not on the public surface (ADR-0012): the heaviest view.
    id: "geography",
    title: "Geography",
    shared: false,
    async content({ db, site, range, nonce }) {
      const rows = await getTopCountries(db, site.id, range, 20);
      return geographyContent(rows, nonce);
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
      return `<div class="breakdown-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
      ${breakdownCard("Device type", devices, "#4d86ff")}
      ${breakdownCard("Browser", browsers, "#7a5cff")}
      ${breakdownCard("Operating system", oses, "#2bd888")}
    </div>`;
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
      return `<div class="breakdown-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
      ${breakdownCard("UTM source", utmSources, "#4d86ff")}
      ${breakdownCard("UTM medium", utmMediums, "#7a5cff")}
      ${breakdownCard("UTM campaign", utmCampaigns, "#2bd888")}
    </div>`;
    },
  },
  {
    id: "events",
    title: "Events",
    shared: true,
    async content({ db, site, range }) {
      const rows = await getTopEvents(db, site.id, range, 50);
      return rows.length === 0
        ? NO_EVENTS_HTML
        : breakdownTable(
            [
              { label: "Event", key: "label", mono: true },
              { label: "Count", key: "pageviews" },
              { label: "Visitors", key: "visitors" },
            ],
            rows,
          );
    },
  },
];

function geographyContent(
  rows: Awaited<ReturnType<typeof getTopCountries>>,
  nonce: string,
): string {
  // Country rows for the list panel
  const countryListHtml = rows
    .map(
      (r) =>
        `<li style="display:flex;align-items:center;gap:11px;">
      <span style="flex:none;width:138px;font-size:13px;color:#cfd4e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.label)}</span>
      <div style="flex:1;height:6px;border-radius:4px;background:#1c212c;">
        <div style="width:${Math.round(r.share * 100)}%;height:100%;border-radius:4px;background:#2bd888;"></div>
      </div>
      <span style="flex:none;font-size:12px;color:#9aa1b2;width:48px;text-align:right;">${esc(fmtNum(r.visitors))}</span>
    </li>`,
    )
    .join("\n");

  // Build jsVectorMap values JSON for the map
  // jsonForScript, not JSON.stringify: a country label lands inline in a
  // <script> block, and JSON.stringify does not neutralize "</script>".
  const mapValues = jsonForScript(Object.fromEntries(rows.map((r) => [r.label, r.visitors])));

  return `
    <link rel="stylesheet" href="/vendor/jsvectormap@1.6.0/jsvectormap.min.css">
    <div class="geo-layout" style="display:flex;gap:14px;align-items:stretch;">
      <div style="flex:1.7;min-width:0;background:#12151d;border:1px solid #20252f;border-radius:12px;padding:22px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;color:#fff;">Visitors by country</h2>
          <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#8b92a4;font-family:'JetBrains Mono',monospace;">
            low <span style="width:60px;height:7px;border-radius:4px;background:linear-gradient(90deg,#202634,#4d86ff);"></span> high
          </div>
        </div>
        <div id="skopia-map" style="width:100%;height:430px;"></div>
      </div>
      <div style="flex:1;min-width:0;background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
        <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">Top countries</h2>
        <ul style="display:flex;flex-direction:column;gap:14px;">${countryListHtml}</ul>
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
  `;
}

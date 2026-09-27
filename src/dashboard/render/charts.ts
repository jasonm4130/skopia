/** Skopia — headline stat cards and the daily time-series chart. */

import type { StatCards, TimeSeriesPoint } from "../../shared/types";
import { esc, fmtNum, fmtPct } from "./html";

// ---------------------------------------------------------------------------
// Stat cards HTML
// ---------------------------------------------------------------------------

// Shared with the breakdown table's Visitors column header — same caveat,
// same wording, wherever a "Visitors" figure is a sum of daily uniques.
export const VISITORS_TOOLTIP =
  "Sum of each day's unique visitors. Someone who visits on several days is counted once per day, so multi-day totals run higher than true unique visitors.";

/** The "~est" badge for a metric derived from sampled (not exact) data. */
export function sampledBadge(sampled: boolean): string {
  return sampled
    ? `<span title="Estimated from sampled data" style="font-size:10px;color:#9aa1b2;background:#1a1f2a;padding:2px 6px;border-radius:4px;margin-left:6px;">~est</span>`
    : "";
}

export function statCardsHtml(cards: StatCards, sampled: boolean): string {
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
      <h2 style="font-size:12.5px;font-weight:400;color:#8b92a4;margin-bottom:10px;">${esc(label)}${
        tip
          ? ` <span title="${esc(tip)}" style="cursor:help;color:#8b92a4;border-bottom:1px dotted #3a4150;">&#9432;</span>`
          : ""
      }</h2>
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

export function timeSeriesChartHtml(
  series: TimeSeriesPoint[],
  rangeLabel: string,
  _siteId: string,
  _rangeKey: string,
  nonce: string,
): string {
  if (series.length === 0) {
    return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:60px 24px;text-align:center;margin-bottom:20px;">
      <span style="color:#8b92a4;font-size:14px;">No data for this period.</span>
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

  // The SVG is decorative (aria-hidden); this visually-hidden table is the SINGLE
  // accessible representation of the series (WCAG 1.1.1). Carries BOTH metrics so
  // no data is hidden behind the visitors/pageviews toggle.
  const srRows = series
    .map(
      (p) =>
        `<tr><th scope="row">${esc(p.day)}</th><td>${esc(String(p.visitors))}</td><td>${esc(String(p.pageviews))}</td></tr>`,
    )
    .join("");
  const srTable = `<table class="sr-only"><caption>Daily visitors and pageviews, ${esc(rangeLabel)}</caption><thead><tr><th scope="col">Date</th><th scope="col">Visitors</th><th scope="col">Pageviews</th></tr></thead><tbody>${srRows}</tbody></table>`;

  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:22px 24px;margin-bottom:20px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
    <div style="display:flex;gap:7px;">
      <button id="btn-visitors" aria-pressed="true" style="cursor:pointer;font-size:12.5px;font-weight:600;color:#fff;background:#3568d6;padding:7px 14px;border-radius:7px;border:none;">Visitors</button>
      <button id="btn-pageviews" aria-pressed="false" style="cursor:pointer;font-size:12.5px;font-weight:500;color:#9aa1b2;background:#1a1f2a;padding:7px 14px;border-radius:7px;border:none;">Pageviews</button>
    </div>
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b92a4;">${esc(rangeLabel)}</span>
  </div>
  ${srTable}
  <div style="position:relative;height:250px;" id="chart-wrap">
    <svg id="chart-svg" aria-hidden="true" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">
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
      <div style="display:flex;align-items:center;gap:7px;font-size:13px;color:#cfd4e0;white-space:nowrap;margin-top:3px;"><span style="width:8px;height:8px;border-radius:2px;background:#8b92a4;"></span> <span id="tip-pageviews">0</span> views</div>
    </div>
    <div style="position:absolute;inset:0;display:flex;" id="overlay-cells"></div>
  </div>
  <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#8b92a4;margin-top:8px;">${axisLabels}</div>
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
    var bv=document.getElementById('btn-visitors'),bp=document.getElementById('btn-pageviews');
    bv.style.color=metric==='visitors'?'#fff':'#9aa1b2';
    bv.style.background=metric==='visitors'?'#3568d6':'#1a1f2a';
    bv.setAttribute('aria-pressed',metric==='visitors'?'true':'false');
    bp.style.color=metric==='pageviews'?'#fff':'#9aa1b2';
    bp.style.background=metric==='pageviews'?'#3568d6':'#1a1f2a';
    bp.setAttribute('aria-pressed',metric==='pageviews'?'true':'false');

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

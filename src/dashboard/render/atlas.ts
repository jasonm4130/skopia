/**
 * Skopia — the Countries display: a hex dot map on display glass beside a
 * Visitors list. The unlit dot grid is a static, cacheable file
 * (/assets/map-base.svg); only the lit countries are rendered inline, from the
 * committed map-data module — no client map library, no script.
 */

import type { BreakdownRow } from "../../shared/types";
import { est, SORT_MARK } from "./breakdown";
import { esc, n } from "./html";
import { COUNTRY_DOTS, MAP_H } from "./map-data";

let regionNames: Intl.DisplayNames | null = null;

/** "AU" → "Australia"; unknown or special codes (XX, T1) fall back to the code. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// Three brightness steps relative to the busiest country.
const bucket = (r: number): 1 | 2 | 3 => (r >= 0.66 ? 3 : r >= 0.33 ? 2 : 1);

function worldMap(rows: BreakdownRow[]): string {
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  const lit = rows
    .map((r) => {
      const d = COUNTRY_DOTS[r.label.toUpperCase()];
      return d ? `<path class="m-c m-${bucket(r.visitors / max)}" d="${d}"/>` : "";
    })
    .join("");
  const steps = ([1, 2, 3] as const)
    .map((b) => {
      const vs = rows.filter((r) => bucket(r.visitors / max) === b).map((r) => r.visitors);
      if (!vs.length) return "";
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      return `<span><i class="m-k m-k${b}"></i>${lo === hi ? n(lo) : `${n(lo)}&ndash;${n(hi)}`}</span>`;
    })
    .join("");
  const label = rows.length
    ? `Dot map of countries with visitors: ${rows.map((r) => `${countryName(r.label)} ${n(r.visitors)}`).join(", ")}.`
    : "Dot map. No countries recorded in this range.";
  return `<div class="mapbox" role="img" aria-label="${esc(label)}">
        <img src="/assets/map-base.svg" alt="" width="906" height="${MAP_H + 3}" loading="lazy">
        <svg viewBox="-3 -3 906 ${MAP_H + 3}" aria-hidden="true" focusable="false">${lit}</svg>
      </div>
      ${steps ? `<p class="m-legend" aria-hidden="true">Visitors ${steps}</p>` : ""}`;
}

/**
 * The atlas display. `rows` must already be ordered by visitors
 * (getTopCountries does that); `more` is the "All countries" href, if any.
 */
export function atlas(
  rows: BreakdownRow[],
  opts: { sampled: boolean; more?: string; headingId?: string; level?: 2 | 3 },
): string {
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  const h = opts.level ?? 2;
  const id = opts.headingId ?? "geo-h";
  const list = rows.length
    ? rows
        .map(
          (r) =>
            `<li style="--s:${(r.visitors / max).toFixed(3)}"><span class="cc">${esc(r.label.toUpperCase())}</span><span class="nm">${esc(countryName(r.label))}</span><span class="n">${est(opts.sampled || r.sampled)}${n(r.visitors)}</span></li>`,
        )
        .join("")
    : `<li class="none">No countries recorded in this range.</li>`;
  return `<section class="glass atlas" aria-labelledby="${id}">
      <div class="atlas-map">
        <div class="atlas-h"><h${h} id="${id}">Countries</h${h}><p>From Cloudflare&rsquo;s two-letter country code. Nothing finer is kept.</p></div>
        ${worldMap(rows)}
      </div>
      <div class="atlas-list">
        <h${h + 1} class="atlas-lh"><span>Country</span><span>${SORT_MARK}Visitors</span></h${h + 1}>
        <ul>${list}</ul>
        ${opts.more ? `<a class="more" href="${opts.more}">All countries <span aria-hidden="true">&rarr;</span></a>` : ""}
      </div>
    </section>`;
}

/**
 * Skopia — ruled breakdown tables on the casing.
 *
 * Rules every table follows:
 * - ▾ and aria-sort mark the column the rows are ordered by; the label bars are
 *   scaled to that column's largest row, so the visible order always explains
 *   itself.
 * - Visitors are summed daily uniques, so a visitor counts once in every row
 *   they touch. When a table's Visitors column adds up to more than the site's
 *   total, the table says so in a computed note linked to footnote 1.
 */

import type { BreakdownRow } from "../../shared/types";
import { esc, n, pct } from "./html";

/** "≈" before a figure built from sampled (estimated) data. */
export function est(sampled: boolean): string {
  return sampled ? `<span class="est" title="Estimated from sampled data">&asymp;</span>` : "";
}

/** A superscript link to footnote `k` on this page. */
export function fn(k: number | string): string {
  return `<sup class="fn"><a href="#fn-${k}" aria-label="Note ${k}">${k}</a></sup>`;
}

export const SORT_MARK = `<span class="srt" aria-hidden="true">&#9662;</span>`;

// A referrer that is almost certainly a developer's local server.
const DEV_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^.]+\.local|[^.]+\.test)(:\d+)?$/i;

function devTag(label: string): string {
  return DEV_RE.test(label) ? ` <span class="devtag">dev server?</span>` : "";
}

/** True when the label looks like a dev-server referrer (for page asides). */
export function isDevHost(label: string): boolean {
  return DEV_RE.test(label);
}

type Metric = "visitors" | "pageviews";

export interface Column {
  key: Metric | "share";
  label: string;
  /** Footnote number to attach to the header. */
  note?: number;
}

export interface TableSpec {
  caption: string;
  labelHead: string;
  rows: BreakdownRow[];
  columns: Column[];
  /** The column the rows are ordered by (gets ▾, aria-sort and the bars). */
  orderBy: Metric;
  /** Monospace labels (paths, event names). */
  mono?: boolean;
  /** Site totals for the footer and the visitor-sum check. */
  site?: { visitors: number; pageviews: number; sampled: boolean };
  /** Footer style: compact "Whole site" row, or "Rows added up" + "Site total". */
  foot?: "whole" | "sum";
  /** Mark figures as estimates when there is no `site` to carry the flag. */
  sampled?: boolean;
}

function cell(r: BreakdownRow, c: Column, sampled: boolean): string {
  if (c.key === "share") return `<td class="s">${pct(r.share)}</td>`;
  const cls = c.key === "visitors" ? "v" : "p";
  const mark = c.key === "visitors" ? est(sampled || r.sampled) : "";
  return `<td class="${cls}">${mark}${n(r[c.key])}</td>`;
}

/**
 * The computed "adds up to more than the site" note. Returns "" when the
 * column does not overshoot the total (or there is no Visitors column).
 */
export function visitorSumNote(spec: TableSpec): string {
  if (!spec.site || !spec.columns.some((c) => c.key === "visitors")) return "";
  const sum = spec.rows.reduce((a, r) => a + r.visitors, 0);
  if (sum <= spec.site.visitors) return "";
  return `<p class="bd-note">The visitor column adds up to ${n(sum)}, more than the site&rsquo;s ${n(spec.site.visitors)}: a visitor counts once in every row they touch.${fn(1)}</p>`;
}

/** A ruled breakdown table. */
export function bdTable(spec: TableSpec): string {
  if (spec.rows.length === 0) return `<p class="bd-none">Nothing recorded in this range.</p>`;
  const { rows, columns, orderBy, site } = spec;
  const max = Math.max(1, ...rows.map((r) => r[orderBy]));
  const sampled = site?.sampled ?? spec.sampled ?? false;

  const head = columns
    .map((c) => {
      const sorted = c.key === orderBy;
      return `<th scope="col"${sorted ? ' aria-sort="descending"' : ""}>${sorted ? SORT_MARK : ""}${esc(c.label)}${c.note ? fn(c.note) : ""}</th>`;
    })
    .join("");

  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row"><span class="lbl${spec.mono ? " path" : ""}" style="--s:${(r[orderBy] / max).toFixed(3)}" title="${esc(r.label)}">${esc(r.label)}${devTag(r.label)}</span></th>${columns.map((c) => cell(r, c, sampled)).join("")}</tr>`,
    )
    .join("");

  let foot = "";
  if (site && spec.foot) {
    const siteCell = (c: Column): string =>
      c.key === "share"
        ? "<td>100%</td>"
        : `<td class="${c.key === "visitors" ? "v" : "p"}">${c.key === "visitors" ? est(sampled) : ""}${n(site[c.key])}</td>`;
    if (spec.foot === "whole") {
      foot = `<tfoot><tr><th scope="row">Whole site</th>${columns.map(siteCell).join("")}</tr></tfoot>`;
    } else {
      const sumCell = (c: Column): string => {
        if (c.key === "share") return `<td>${pct(rows.reduce((a, r) => a + r.share, 0))}</td>`;
        const sum = rows.reduce((a, r) => a + r[c.key], 0);
        const over = c.key === "visitors" && sum > site.visitors;
        return `<td class="${c.key === "visitors" ? "v" : "p"}">${n(sum)}${over ? `<a href="#fn-1" class="ast" aria-label="Why this is more than the site total">*</a>` : ""}</td>`;
      };
      foot = `<tfoot><tr><th scope="row">Rows added up</th>${columns.map(sumCell).join("")}</tr><tr><th scope="row">Site total</th>${columns.map(siteCell).join("")}</tr></tfoot>`;
    }
  }

  // overflow-x:auto + tabindex="0": the table scrolls sideways on a narrow
  // screen and that scroller is keyboard-reachable (WCAG 1.4.10 / 2.1.1).
  return `<div class="tbl-wrap" style="overflow-x:auto" tabindex="0"><table class="bd" style="--nc:${columns.length}">
      <caption class="sr-only">${esc(spec.caption)}, ordered by ${orderBy}. Bars are scaled to the largest row.</caption>
      <thead><tr><th scope="col">${esc(spec.labelHead)}</th>${head}</tr></thead>
      <tbody>${body}</tbody>${foot}
    </table></div>${visitorSumNote(spec)}`;
}

/** A Visitors-only mini table (devices, browsers, OS): ordered by visitors. */
export function miniTable(title: string, rows: BreakdownRow[], sampled: boolean): string {
  return `<div class="dcol">${bdTable({
    caption: title,
    labelHead: title,
    rows,
    columns: [{ key: "visitors", label: "Visitors" }],
    orderBy: "visitors",
    sampled,
  })}</div>`;
}

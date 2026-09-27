/** Skopia — breakdown renderers: the compact bar-list card and the full table. */

import type { BreakdownRow } from "../../shared/types";
import { esc, fmtNum, fmtPct } from "./html";

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

// ---------------------------------------------------------------------------
// Breakdown bar-list HTML (top pages, sources, countries)
// ---------------------------------------------------------------------------

export function breakdownCard(title: string, rows: BreakdownRow[], barColor: string): string {
  if (rows.length === 0) {
    return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
      <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">${esc(title)}</h2>
      <div style="color:#8b92a4;font-size:13px;">No data.</div>
    </div>`;
  }
  const rowsHtml = rows
    .map(
      (r) =>
        `<li style="display:flex;align-items:center;gap:11px;">
      <span style="flex:none;width:124px;font-size:12.5px;color:#cfd4e0;font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.label)}">${esc(r.label)}</span>
      <div style="flex:1;height:6px;border-radius:4px;background:#1c212c;">
        <div style="width:${Math.round(r.share * 100)}%;height:100%;border-radius:4px;background:${barColor};"></div>
      </div>
      <span style="flex:none;font-size:12px;color:#9aa1b2;width:48px;text-align:right;">${esc(fmtNum(r.visitors))}</span>
    </li>`,
    )
    .join("\n");
  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:20px 22px;">
    <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14.5px;color:#fff;margin-bottom:18px;">${esc(title)}</h2>
    <ul style="display:flex;flex-direction:column;gap:13px;">${rowsHtml}</ul>
  </div>`;
}

// ---------------------------------------------------------------------------
// Full breakdown table (Pages / Sources views)
// ---------------------------------------------------------------------------

export function breakdownTable(
  columns: { label: string; key: keyof BreakdownRow; mono?: boolean }[],
  rows: BreakdownRow[],
): string {
  const headerCells = columns
    .map((c) => {
      // Visitors here is the same daily-summed figure as the Overview stat
      // card — carry the same honest caveat as a native tooltip.
      const titleAttr = c.key === "visitors" ? ` title="${esc(VISITORS_TOOLTIP)}"` : "";
      const align = c.key === "label" ? "left" : "right";
      const width = c.key === "label" ? "auto" : "120px";
      return `<th scope="col" style="width:${width};text-align:${align};padding:14px 24px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:400;text-transform:uppercase;letter-spacing:.1em;color:#8b92a4;border-bottom:1px solid #20252f;white-space:nowrap;"${titleAttr}>${esc(c.label)}</th>`;
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
          const align = c.key === "label" ? "left" : "right";
          const width = c.key === "label" ? "auto" : "120px";
          const nowrap = c.key === "label" ? "" : "white-space:nowrap;";
          const color = c.key === "label" ? "#cfd4e0" : c.key === "visitors" ? "#fff" : "#9aa1b2";
          return `<td style="${mono}width:${width};text-align:${align};color:${color};padding:15px 24px;border-bottom:1px solid #161a22;font-size:13.5px;${nowrap}">${val}${badge}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const caption = `${columns[0]?.label ?? "Breakdown"} breakdown`;

  // overflow-x:auto + tabindex="0" makes the wide table horizontally scrollable
  // AND keyboard-reachable on narrow screens (WCAG 1.4.10) instead of clipped by
  // the card's overflow:hidden.
  return `<div style="background:#12151d;border:1px solid #20252f;border-radius:12px;padding:8px 0;overflow:hidden;">
    <div style="overflow-x:auto;" tabindex="0">
      <table style="width:100%;border-collapse:collapse;">
        <caption class="sr-only">${esc(caption)}</caption>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
}

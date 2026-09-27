/** Skopia — HTML escaping + number formatting shared by every render module. */

/** Escape a string for safe insertion into HTML text content or attributes. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Instrument-panel formatting: full digits on readouts, dates as "Sat 26 Sep"
// ---------------------------------------------------------------------------

const NF = new Intl.NumberFormat("en-US");

/** A full count with thousands separators: 12,087. Readouts never abbreviate. */
export function n(x: number): string {
  return NF.format(x);
}

/** Compact axis label: 1.2k, 3M. Only where space is tight (chart gridlines). */
export function compact(x: number): string {
  if (x >= 1e6) return `${+(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${+(x / 1e3).toFixed(1)}k`;
  return String(x);
}

/** A share as a whole percent; a non-zero share under 0.5% reads "<1%", never "0%". */
export function pct(r: number): string {
  return r > 0 && r < 0.005 ? "<1%" : `${Math.round(r * 100)}%`;
}

/** "1 pageview" / "2 pageviews". */
export function plural(x: number, one: string, many: string): string {
  return `${n(x)} ${x === 1 ? one : many}`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dparts(iso: string): { dow: string; day: number; mon: string; y: number } {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    dow: DOW[d.getUTCDay()] ?? "",
    day: d.getUTCDate(),
    mon: MON[d.getUTCMonth()] ?? "",
    y: d.getUTCFullYear(),
  };
}

/** "26 Sep" */
export function dshort(iso: string): string {
  const p = dparts(iso);
  return `${p.day} ${p.mon}`;
}

/** "Sat 26 Sep" */
export function dlong(iso: string): string {
  const p = dparts(iso);
  return `${p.dow} ${p.day} ${p.mon}`;
}

/** "Last 30 days · 28 Aug – 26 Sep 2026, UTC" */
export function periodLine(range: { from: string; to: string; label: string }): string {
  return `${esc(range.label)} <span aria-hidden="true">&middot;</span> ${dshort(range.from)} &ndash; ${dshort(range.to)} ${dparts(range.to).y}, UTC`;
}

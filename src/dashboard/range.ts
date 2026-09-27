/** Skopia — dashboard date-range parsing (UTC days, inclusive on both ends). */

import type { DateRange } from "../shared/types";

// ---------------------------------------------------------------------------
// Date-range helpers
// ---------------------------------------------------------------------------

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function parseRange(
  param: string | null | undefined,
): DateRange & { label: string; key: string } {
  // `to` is today and the SQL window is inclusive on both ends, so "Last N days"
  // = today and the N-1 days before it. daysAgo(N) would span N+1 days.
  const ranges: Record<string, { from: () => string; label: string }> = {
    "7d": { from: () => daysAgo(6), label: "Last 7 days" },
    "30d": { from: () => daysAgo(29), label: "Last 30 days" },
    "90d": { from: () => daysAgo(89), label: "Last 90 days" },
  };
  // Object.hasOwn, not `ranges[param]` truthiness — a plain object inherits
  // from Object.prototype, so ?range=toString / constructor / __proto__ /
  // hasOwnProperty resolves to an inherited function (truthy) instead of
  // `undefined`, and `.from()` on it throws.
  const key = param && Object.hasOwn(ranges, param) ? param : "30d";
  const selected = ranges[key] ?? ranges["30d"]!;
  const to = todayUtc();
  const from = selected.from();
  return { from, to, label: selected.label, key };
}

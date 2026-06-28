/**
 * Tests for parseRange (src/dashboard/index.ts).
 *
 * The picker labels promise an exact window — "Last 7 days" must cover 7
 * calendar days, not 8. The SQL filter is inclusive on both ends
 * (day >= from AND day <= to), so `from` must be today-(n-1), not today-n.
 */

import { describe, expect, it } from "vitest";
import { parseRange } from "../src/dashboard/index";

/** Inclusive day count between the from/to YYYY-MM-DD bounds. */
function spanDays(r: { from: string; to: string }): number {
  const ms = Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`);
  return ms / 86_400_000 + 1;
}

describe("parseRange", () => {
  it("'7d' spans exactly 7 calendar days", () => {
    expect(spanDays(parseRange("7d"))).toBe(7);
  });

  it("'30d' spans exactly 30 calendar days", () => {
    expect(spanDays(parseRange("30d"))).toBe(30);
  });

  it("'90d' spans exactly 90 calendar days", () => {
    expect(spanDays(parseRange("90d"))).toBe(90);
  });

  it("defaults to 30d for unknown/empty input", () => {
    expect(parseRange(undefined).key).toBe("30d");
    expect(parseRange("nonsense").key).toBe("30d");
    expect(spanDays(parseRange(null))).toBe(30);
  });

  it("'to' is today (UTC)", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(parseRange("7d").to).toBe(today);
  });
});

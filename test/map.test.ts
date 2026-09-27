/**
 * The dot map (scripts/gen-map.mjs → src/dashboard/render/map-data.ts): every
 * country in the source outline must have at least one dot, so a site visited
 * mostly from a small country (BE, DK, LU…) or one with no outline (SG, HK…)
 * never shows a dark map.
 */

import { describe, expect, it } from "vitest";
import { worldMap } from "../src/dashboard/render/atlas";
import { COUNTRY_DOTS } from "../src/dashboard/render/map-data";
import type { BreakdownRow } from "../src/shared/types";
import OUTLINE_CODES from "./fixtures/map-outline-codes.json";

const row = (label: string, visitors: number): BreakdownRow => ({
  label,
  visitors,
  pageviews: visitors,
  share: 0,
  sampled: false,
});

describe("dot map coverage", () => {
  it("gives every country in the source outline at least one dot", () => {
    expect(OUTLINE_CODES.length).toBeGreaterThan(150);
    const dark = OUTLINE_CODES.filter((k) => !/M[\d.]+ [\d.]+h0/.test(COUNTRY_DOTS[k] ?? ""));
    expect(dark).toEqual([]);
  });

  it("covers small countries the grid used to miss, with or without an outline", () => {
    for (const k of ["BE", "DK", "IL", "TW", "LU", "LB", "SG", "HK", "MT", "BH"]) {
      expect(COUNTRY_DOTS[k], k).toMatch(/^(M[\d.]+ [\d.]+h0)+$/);
    }
  });

  it("lights SG and BE in worldMap()", () => {
    const svg = worldMap([row("SG", 5), row("BE", 2)]);
    expect(svg).toContain(`d="${COUNTRY_DOTS.SG}"`);
    expect(svg).toContain(`d="${COUNTRY_DOTS.BE}"`);
    expect(svg.match(/class="m-c m-\d"/g)).toHaveLength(2);
  });
});

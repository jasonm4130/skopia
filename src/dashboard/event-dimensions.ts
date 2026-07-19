/**
 * Pure dimension fan-out for the DO incremental rollup (spec §5).
 *
 * Mirrors the old cron's GROUP-BY semantics (the since-removed src/rollup/index.ts,
 * deleted in ADR-0011's shadow-drop follow-up — see git history) exactly so
 * rollup_daily stays byte-compatible:
 *   - 11 dimensions; `referrer` empty -> "(direct)"; other empty values skipped.
 *   - pageview metric is is_pageview for every dim EXCEPT `event`, which counts
 *     each fire (metric 1) so the events breakdown is non-empty.
 */
import type { RollupDimension } from "../shared/types";

export interface CountEvent {
  siteId: string;
  vid: string;
  isPageview: 0 | 1;
  path: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  eventName: string;
}

export interface DimContribution {
  dimension: RollupDimension;
  dimValue: string;
  /** Amount to add to this row's pageviews delta. */
  pv: number;
}

export function eventDimensions(e: CountEvent): DimContribution[] {
  const out: DimContribution[] = [];
  const pv = e.isPageview; // 0 or 1

  // total — always present; dim_value "" is its valid value.
  out.push({ dimension: "total", dimValue: "", pv });

  // page — skip only if path is empty (collector always sends at least "/").
  if (e.path) out.push({ dimension: "page", dimValue: e.path, pv });

  // referrer — empty becomes "(direct)" rather than being dropped.
  out.push({
    dimension: "referrer",
    dimValue: e.referrer === "" ? "(direct)" : e.referrer,
    pv,
  });

  // utm_* / geo / ua — single-value dims, skipped when empty.
  const singles: Array<[RollupDimension, string]> = [
    ["utm_source", e.utmSource],
    ["utm_medium", e.utmMedium],
    ["utm_campaign", e.utmCampaign],
    ["country", e.country],
    ["device", e.device],
    ["browser", e.browser],
    ["os", e.os],
  ];
  for (const [dimension, dimValue] of singles) {
    if (dimValue) out.push({ dimension, dimValue, pv });
  }

  // event — counts every fire (metric 1), keyed by event name; pageviews have none.
  if (e.eventName) out.push({ dimension: "event", dimValue: e.eventName, pv: 1 });

  return out;
}

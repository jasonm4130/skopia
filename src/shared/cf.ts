/**
 * Stratus — server-side enrichment helpers (foundation-owned signatures, FINAL).
 *
 * Everything the dashboard shows beyond what the browser sends (country, ASN,
 * device/browser/OS, bot class) is derived here from `request.cf` and the
 * User-Agent — ZERO client bytes (spec §2 / §3.4). Stubs throw until the
 * collector agent implements them.
 */

import type { DeviceClass } from "./types";

/** Geo + network facts pulled from `request.cf` (spec §3.4). */
export interface CfEnrichment {
  /** request.cf.country, e.g. "US"; "XX" when unknown. */
  country: string;
  /** request.cf.colo — the Cloudflare data center, e.g. "LHR". */
  colo: string;
  /** request.cf.asn — autonomous system number. */
  asn: number;
  /** request.cf.asOrganization — AS org name (datacenter-ASN bot heuristic). */
  asOrganization: string;
  /** request.cf.httpProtocol, e.g. "HTTP/3". */
  httpProtocol: string;
  /** request.cf.isEUCountry === "1". */
  isEUCountry: boolean;
}

/** Parsed device facts derived from the User-Agent (spec §3.4). */
export interface UaInfo {
  deviceClass: DeviceClass;
  /** Browser family, e.g. "Chrome", "Safari"; "" when unknown. */
  browser: string;
  /** OS family, e.g. "macOS", "Windows", "Android"; "" when unknown. */
  os: string;
}

/** The parsed UTM campaign parameters from a URL's query string. */
export interface UtmParams {
  source: string;
  medium: string;
  campaign: string;
}

/**
 * Extract geo/network enrichment from an incoming request's `cf` object.
 * Returns safe defaults ("XX"/0/"") for missing fields.
 */
export function enrichFromCf(request: Request): CfEnrichment {
  void request;
  throw new Error("not implemented");
}

/** Parse a User-Agent string into device class / browser / OS. */
export function parseUserAgent(ua: string): UaInfo {
  void ua;
  throw new Error("not implemented");
}

/**
 * Heuristic bot check (free-tier only — no Enterprise Bot Management, spec §3.3):
 * UA blocklist + datacenter-ASN/asOrganization + missing-header heuristics +
 * `cf.verifiedBot` where present. Returns true to DROP the request.
 */
export function isBot(request: Request, ua: string, cf: CfEnrichment): boolean {
  void request, void ua, void cf;
  throw new Error("not implemented");
}

/** Parse the host out of a referrer URL; '' if absent or malformed. */
export function parseReferrerHost(referrer: string | undefined): string {
  void referrer;
  throw new Error("not implemented");
}

/** Parse utm_source / utm_medium / utm_campaign from a pathname+query string. */
export function parseUtm(pathWithQuery: string): UtmParams {
  void pathWithQuery;
  throw new Error("not implemented");
}

/** Bucket a raw screen width into the device-class hint used as a fallback. */
export function bucketScreenWidth(width: number | undefined): DeviceClass {
  void width;
  throw new Error("not implemented");
}

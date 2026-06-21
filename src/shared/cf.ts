/**
 * Stratus — server-side enrichment helpers (foundation-owned signatures, FINAL).
 *
 * Everything the dashboard shows beyond what the browser sends (country, ASN,
 * device/browser/OS, bot class) is derived here from `request.cf` and the
 * User-Agent — ZERO client bytes (spec §2 / §3.4).
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
  // Cloudflare's `cf` object is attached to every incoming request; cast it.
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  return {
    country: typeof cf["country"] === "string" && cf["country"] ? cf["country"] : "XX",
    colo: typeof cf["colo"] === "string" ? cf["colo"] : "",
    asn: typeof cf["asn"] === "number" ? cf["asn"] : 0,
    asOrganization: typeof cf["asOrganization"] === "string" ? cf["asOrganization"] : "",
    httpProtocol: typeof cf["httpProtocol"] === "string" ? cf["httpProtocol"] : "",
    isEUCountry: cf["isEUCountry"] === "1",
  };
}

/**
 * Parse a User-Agent string into device class / browser / OS.
 *
 * Deliberately small — a lookup-table approach rather than a full UAParser
 * library, to stay within the Worker's module-size budget.
 */
export function parseUserAgent(ua: string): UaInfo {
  if (!ua) return { deviceClass: "desktop", browser: "", os: "" };

  // --- OS detection (order matters: mobile-specific patterns first) ---
  let os = "";
  if (/Android/i.test(ua)) {
    os = "Android";
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    os = "iOS";
  } else if (/Windows Phone/i.test(ua)) {
    os = "Windows Phone";
  } else if (/Windows/i.test(ua)) {
    os = "Windows";
  } else if (/Mac OS X|macOS/i.test(ua)) {
    os = "macOS";
  } else if (/Linux/i.test(ua)) {
    os = "Linux";
  } else if (/CrOS/i.test(ua)) {
    os = "ChromeOS";
  }

  // --- Device class (tablet > mobile > desktop) ---
  // Tablets first: iPad UAs include "Mobile/<build>", so the generic mobile
  // check below would otherwise misclassify them as mobile.
  let deviceClass: DeviceClass;
  if (/iPad|Tablet|PlayBook|Silk|(?:Android(?!.*Mobile))/i.test(ua)) {
    deviceClass = "tablet";
  } else if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua)) {
    deviceClass = "mobile";
  } else {
    deviceClass = "desktop";
  }

  // --- Browser detection (most specific first) ---
  let browser = "";
  if (/Edg\//i.test(ua)) {
    browser = "Edge";
  } else if (/OPR\/|Opera/i.test(ua)) {
    browser = "Opera";
  } else if (/SamsungBrowser/i.test(ua)) {
    browser = "Samsung Internet";
  } else if (/Chrome\/[0-9]/i.test(ua) && !/Chromium/i.test(ua)) {
    browser = "Chrome";
  } else if (/Chromium/i.test(ua)) {
    browser = "Chromium";
  } else if (/Firefox\/[0-9]/i.test(ua)) {
    browser = "Firefox";
  } else if (/Safari\/[0-9]/i.test(ua) && !/Chrome/i.test(ua)) {
    browser = "Safari";
  } else if (/MSIE |Trident\//i.test(ua)) {
    browser = "IE";
  }

  return { deviceClass, browser, os };
}

// Known bot UA substrings (case-insensitive). Keep this list minimal — it must
// run on every request, so a huge list is a latency cost.
const BOT_UA_PATTERNS = [
  "bot",
  "spider",
  "crawl",
  "slurp",
  "ia_archiver",
  "facebookexternalhit",
  "linkedinbot",
  "twitterbot",
  "telegrambot",
  "whatsapp",
  "bingpreview",
  "googlebot",
  "gptbot",
  "ccbot",
  "ahrefsbot",
  "semrushbot",
  "dotbot",
  "petalbot",
  "baiduspider",
  "duckduckbot",
  "yandexbot",
  "applebot",
  "bytespider",
  "claudebot",
  "anthropic-ai",
  "cohere-ai",
  "dataprovider",
  "mj12bot",
  "sogou",
  "exabot",
  "python-requests",
  "python-urllib",
  "java/",
  "go-http-client",
  "okhttp",
  "curl/",
  "wget/",
  "libwww",
  "scrapy",
  "phpunit",
  "headlesschrome",
  "phantomjs",
  "nightmarejs",
  "selenium",
  "puppeteer",
];

// Datacenter / cloud ASN org name patterns (lowercased)
const DATACENTER_ORG_PATTERNS = [
  "amazon",
  "google",
  "microsoft",
  "digitalocean",
  "linode",
  "hetzner",
  "ovh",
  "vultr",
  "cloudflare",
  "fastly",
  "akamai",
  "serverius",
  "leaseweb",
  "datacamp",
  "choopa",
  "constant contact",
];

/**
 * Heuristic bot check (free-tier only — no Enterprise Bot Management, spec §3.3):
 * UA blocklist + datacenter-ASN/asOrganization + missing-header heuristics +
 * `cf.verifiedBot` where present. Returns true to DROP the request.
 */
export function isBot(request: Request, ua: string, cf: CfEnrichment): boolean {
  // 1. `cf.verifiedBot` — Super Bot Fight Mode surfaces this
  const cfRaw = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  if (cfRaw["verifiedBot"] === true) return true;

  // 2. Empty UA
  if (!ua || ua.trim() === "") return true;

  // 3. UA blocklist (case-insensitive substring match)
  const uaLower = ua.toLowerCase();
  for (const pattern of BOT_UA_PATTERNS) {
    if (uaLower.includes(pattern)) return true;
  }

  // 4. Datacenter ASN org heuristic
  const orgLower = cf.asOrganization.toLowerCase();
  for (const pattern of DATACENTER_ORG_PATTERNS) {
    if (orgLower.includes(pattern)) return true;
  }

  // 5. Missing Accept-Language header (bots rarely send it; real browsers always do)
  if (!request.headers.get("accept-language")) return true;

  return false;
}

/** Parse the host out of a referrer URL; '' if absent or malformed. */
export function parseReferrerHost(referrer: string | undefined): string {
  if (!referrer) return "";
  try {
    return new URL(referrer).hostname;
  } catch {
    return "";
  }
}

/** Parse utm_source / utm_medium / utm_campaign from a pathname+query string. */
export function parseUtm(pathWithQuery: string): UtmParams {
  // The beacon's `p` field is just the pathname, but the client may include
  // the query string. We also accept a full URL as a safety net.
  let search = "";
  try {
    const url = new URL(pathWithQuery, "https://x");
    search = url.search;
  } catch {
    // Malformed — no UTM params
  }
  const params = new URLSearchParams(search);
  return {
    source: params.get("utm_source") ?? "",
    medium: params.get("utm_medium") ?? "",
    campaign: params.get("utm_campaign") ?? "",
  };
}

/** Bucket a raw screen width into the device-class hint used as a fallback. */
export function bucketScreenWidth(width: number | undefined): DeviceClass {
  if (width === undefined || width === 0) return "desktop";
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

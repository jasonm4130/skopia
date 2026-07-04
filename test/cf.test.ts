/**
 * Tests for src/shared/cf.ts
 *
 * Coverage:
 * - parseUserAgent: device class, browser, OS from real UA strings
 * - isBot: known bot UAs, datacenter ASNs, missing Accept-Language
 * - parseReferrerHost: normal, missing, malformed
 * - parseUtm: present params, missing, mixed
 * - bucketScreenWidth: mobile/tablet/desktop thresholds
 * - enrichFromCf: safe defaults for missing fields
 */

import { describe, expect, it } from "vitest";
import {
  bucketScreenWidth,
  type CfEnrichment,
  enrichFromCf,
  isBot,
  parseReferrerHost,
  parseUserAgent,
  parseUtm,
} from "../src/shared/cf";

// ---------------------------------------------------------------------------
// parseUserAgent
// ---------------------------------------------------------------------------
describe("parseUserAgent", () => {
  it("identifies Chrome on Windows as desktop", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
    const r = parseUserAgent(ua);
    expect(r.browser).toBe("Chrome");
    expect(r.os).toBe("Windows");
    expect(r.deviceClass).toBe("desktop");
  });

  it("identifies Safari on macOS as desktop", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    const r = parseUserAgent(ua);
    expect(r.browser).toBe("Safari");
    expect(r.os).toBe("macOS");
    expect(r.deviceClass).toBe("desktop");
  });

  it("identifies Firefox on Linux as desktop", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0";
    const r = parseUserAgent(ua);
    expect(r.browser).toBe("Firefox");
    expect(r.os).toBe("Linux");
    expect(r.deviceClass).toBe("desktop");
  });

  it("identifies Chrome on Android as mobile", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
    const r = parseUserAgent(ua);
    expect(r.os).toBe("Android");
    expect(r.deviceClass).toBe("mobile");
  });

  it("identifies Safari on iPhone as mobile", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    const r = parseUserAgent(ua);
    expect(r.os).toBe("iOS");
    expect(r.deviceClass).toBe("mobile");
  });

  it("identifies Edge browser", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0";
    const r = parseUserAgent(ua);
    expect(r.browser).toBe("Edge");
  });

  it("returns empty strings for empty UA", () => {
    const r = parseUserAgent("");
    expect(r.browser).toBe("");
    expect(r.os).toBe("");
    expect(r.deviceClass).toBe("desktop");
  });

  it("identifies iPad as tablet", () => {
    const ua =
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    const r = parseUserAgent(ua);
    expect(r.deviceClass).toBe("tablet");
  });
});

// ---------------------------------------------------------------------------
// isBot
// ---------------------------------------------------------------------------

function makeCf(overrides?: Partial<CfEnrichment>): CfEnrichment {
  return {
    country: "US",
    colo: "SJC",
    asn: 12345,
    asOrganization: "Example ISP",
    httpProtocol: "HTTP/2",
    isEUCountry: false,
    ...overrides,
  };
}

function makeRequest(
  ua: string,
  opts?: { acceptLanguage?: string; cf?: Record<string, unknown> },
): Request {
  const req = new Request("https://example.com/e", {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Accept-Language": opts?.acceptLanguage ?? "en-US,en;q=0.9",
      "Content-Type": "application/json",
    },
  });
  // Attach cf object (mimics Cloudflare's runtime addition)
  Object.defineProperty(req, "cf", {
    value: opts?.cf ?? {},
    writable: false,
  });
  return req;
}

describe("isBot", () => {
  it("drops Googlebot", () => {
    const ua = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(true);
  });

  it("drops GPTBot", () => {
    const ua = "GPTBot/1.0 (+https://openai.com/gptbot)";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(true);
  });

  it("drops CCBot", () => {
    const ua = "CCBot/2.0 (https://commoncrawl.org/faq/)";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(true);
  });

  it("drops curl", () => {
    const ua = "curl/8.1.2";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(true);
  });

  it("drops python-requests", () => {
    const ua = "python-requests/2.31.0";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(true);
  });

  it("drops empty UA", () => {
    expect(isBot(makeRequest(""), "", makeCf())).toBe(true);
  });

  it("drops requests without Accept-Language header", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    const req = new Request("https://example.com/e", {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/json",
        // intentionally no Accept-Language
      },
    });
    Object.defineProperty(req, "cf", { value: {}, writable: false });
    expect(isBot(req, ua, makeCf())).toBe(true);
  });

  it("drops datacenter ASN org (Amazon)", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0";
    expect(isBot(makeRequest(ua), ua, makeCf({ asOrganization: "Amazon.com, Inc." }))).toBe(true);
  });

  it("drops verifiedBotCategory when set to a non-empty string", () => {
    const ua = "Mozilla/5.0 Chrome/125.0";
    const req = makeRequest(ua, { cf: { verifiedBotCategory: "Search Engine Crawler" } });
    expect(isBot(req, ua, makeCf())).toBe(true);
  });

  it("drops MegaIndexBot (bare 'bot' substring still catches real crawlers)", () => {
    const ua = "MegaIndexBot/1.0 (+http://megaindex.com/crawler)";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(true);
  });

  it("passes CUBOT-brand Android phones (not a bot)", () => {
    const ua1 =
      "Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Mobile Safari/537.36";
    const ua2 =
      "Mozilla/5.0 (Linux; Android 11; CUBOT KINGKONG 5 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.101 Mobile Safari/537.36";
    expect(isBot(makeRequest(ua1), ua1, makeCf())).toBe(false);
    expect(isBot(makeRequest(ua2), ua2, makeCf())).toBe(false);
  });

  it("passes Private Relay / CDN egress asOrganization values (not a bot)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";
    expect(isBot(makeRequest(ua), ua, makeCf({ asOrganization: "Cloudflare Inc." }))).toBe(false);
    expect(isBot(makeRequest(ua), ua, makeCf({ asOrganization: "GOOGLE-FIBER" }))).toBe(false);
  });

  it("drops Google Cloud Platform asOrganization", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";
    expect(isBot(makeRequest(ua), ua, makeCf({ asOrganization: "Google Cloud Platform" }))).toBe(
      true,
    );
  });

  it("passes a real browser UA with Accept-Language", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(false);
  });

  it("passes mobile browser UA", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";
    expect(isBot(makeRequest(ua), ua, makeCf())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseReferrerHost
// ---------------------------------------------------------------------------
describe("parseReferrerHost", () => {
  it("parses host from a full URL", () => {
    expect(parseReferrerHost("https://www.google.com/search?q=test")).toBe("www.google.com");
  });

  it("returns empty string for undefined", () => {
    expect(parseReferrerHost(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(parseReferrerHost("")).toBe("");
  });

  it("returns empty string for malformed URL", () => {
    expect(parseReferrerHost("not a url")).toBe("");
  });

  it("handles URLs with no path", () => {
    expect(parseReferrerHost("https://twitter.com")).toBe("twitter.com");
  });
});

// ---------------------------------------------------------------------------
// parseUtm
// ---------------------------------------------------------------------------
describe("parseUtm", () => {
  it("extracts all three UTM params", () => {
    const r = parseUtm("/landing?utm_source=google&utm_medium=cpc&utm_campaign=brand");
    expect(r.source).toBe("google");
    expect(r.medium).toBe("cpc");
    expect(r.campaign).toBe("brand");
  });

  it("returns empty strings when no UTM params", () => {
    const r = parseUtm("/page");
    expect(r.source).toBe("");
    expect(r.medium).toBe("");
    expect(r.campaign).toBe("");
  });

  it("handles partial UTM params", () => {
    const r = parseUtm("/page?utm_source=newsletter");
    expect(r.source).toBe("newsletter");
    expect(r.medium).toBe("");
    expect(r.campaign).toBe("");
  });

  it("handles malformed path gracefully", () => {
    const r = parseUtm("");
    expect(r.source).toBe("");
    expect(r.medium).toBe("");
    expect(r.campaign).toBe("");
  });
});

// ---------------------------------------------------------------------------
// bucketScreenWidth
// ---------------------------------------------------------------------------
describe("bucketScreenWidth", () => {
  it("returns mobile for widths < 768", () => {
    expect(bucketScreenWidth(375)).toBe("mobile");
    expect(bucketScreenWidth(767)).toBe("mobile");
  });

  it("returns tablet for 768-1023", () => {
    expect(bucketScreenWidth(768)).toBe("tablet");
    expect(bucketScreenWidth(1023)).toBe("tablet");
  });

  it("returns desktop for >= 1024", () => {
    expect(bucketScreenWidth(1024)).toBe("desktop");
    expect(bucketScreenWidth(1920)).toBe("desktop");
  });

  it("returns desktop for undefined", () => {
    expect(bucketScreenWidth(undefined)).toBe("desktop");
  });

  it("returns desktop for 0", () => {
    expect(bucketScreenWidth(0)).toBe("desktop");
  });
});

// ---------------------------------------------------------------------------
// enrichFromCf
// ---------------------------------------------------------------------------
describe("enrichFromCf", () => {
  it("returns defaults when no cf object", () => {
    const req = new Request("https://example.com/");
    const r = enrichFromCf(req);
    expect(r.country).toBe("XX");
    expect(r.colo).toBe("");
    expect(r.asn).toBe(0);
    expect(r.asOrganization).toBe("");
    expect(r.httpProtocol).toBe("");
    expect(r.isEUCountry).toBe(false);
  });

  it("extracts values from cf object", () => {
    const req = new Request("https://example.com/");
    Object.defineProperty(req, "cf", {
      value: {
        country: "DE",
        colo: "FRA",
        asn: 3320,
        asOrganization: "Deutsche Telekom",
        httpProtocol: "HTTP/3",
        isEUCountry: "1",
      },
      writable: false,
    });
    const r = enrichFromCf(req);
    expect(r.country).toBe("DE");
    expect(r.colo).toBe("FRA");
    expect(r.asn).toBe(3320);
    expect(r.asOrganization).toBe("Deutsche Telekom");
    expect(r.httpProtocol).toBe("HTTP/3");
    expect(r.isEUCountry).toBe(true);
  });

  it("defaults country to XX when cf.country is missing", () => {
    const req = new Request("https://example.com/");
    Object.defineProperty(req, "cf", { value: { asn: 12345 }, writable: false });
    const r = enrichFromCf(req);
    expect(r.country).toBe("XX");
  });
});

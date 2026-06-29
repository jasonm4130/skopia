import { describe, expect, it } from "vitest";
import { type CountEvent, eventDimensions } from "../src/dashboard/event-dimensions";

function base(overrides: Partial<CountEvent> = {}): CountEvent {
  return {
    siteId: "s1",
    vid: "v1",
    isPageview: 1,
    path: "/blog",
    referrer: "google.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    country: "GB",
    device: "mobile",
    browser: "Firefox",
    os: "iOS",
    eventName: "",
    ...overrides,
  };
}

describe("eventDimensions", () => {
  it("fans a pageview across total + 6 single-value dims with pv=1, no utm/event", () => {
    const dims = eventDimensions(base());
    const map = Object.fromEntries(dims.map((d) => [`${d.dimension}:${d.dimValue}`, d.pv]));
    expect(map).toEqual({
      "total:": 1,
      "page:/blog": 1,
      "referrer:google.com": 1,
      "country:GB": 1,
      "device:mobile": 1,
      "browser:Firefox": 1,
      "os:iOS": 1,
    });
  });

  it("buckets empty referrer as (direct), never dropped", () => {
    const dims = eventDimensions(base({ referrer: "" }));
    expect(dims.find((d) => d.dimension === "referrer")).toEqual({
      dimension: "referrer",
      dimValue: "(direct)",
      pv: 1,
    });
  });

  it("skips empty utm/country/device/browser/os dims (but keeps total)", () => {
    const dims = eventDimensions(base({ country: "", device: "", browser: "", os: "" }));
    const present = new Set(dims.map((d) => d.dimension));
    expect(present.has("country")).toBe(false);
    expect(present.has("device")).toBe(false);
    expect(present.has("total")).toBe(true);
  });

  it("emits utm dims with pv=1 when present", () => {
    const dims = eventDimensions(base({ utmSource: "newsletter", utmMedium: "email" }));
    expect(dims.find((d) => d.dimension === "utm_source")).toEqual({
      dimension: "utm_source",
      dimValue: "newsletter",
      pv: 1,
    });
    expect(dims.find((d) => d.dimension === "utm_medium")).toEqual({
      dimension: "utm_medium",
      dimValue: "email",
      pv: 1,
    });
  });

  it("custom event: pv=0 for pageview dims, event dim gets pv=1 (count), eventName drives it", () => {
    const dims = eventDimensions(base({ isPageview: 0, eventName: "signup" }));
    // pageview-metric dims contribute 0 pageviews but still register (for seen)
    expect(dims.find((d) => d.dimension === "total")?.pv).toBe(0);
    expect(dims.find((d) => d.dimension === "page")?.pv).toBe(0);
    // event dimension counts the fire
    expect(dims.find((d) => d.dimension === "event")).toEqual({
      dimension: "event",
      dimValue: "signup",
      pv: 1,
    });
  });

  it("pageview has no event-dim contribution (empty eventName)", () => {
    const dims = eventDimensions(base());
    expect(dims.find((d) => d.dimension === "event")).toBeUndefined();
  });
});

/**
 * The online-now client (public/assets/dash-live.js). It is a static asset,
 * so these tests read its source: the /live protocol must stay as the SiteLive
 * DO expects it, and visitor-controlled paths must never reach innerHTML.
 */

import { describe, expect, it } from "vitest";
import src from "../public/assets/dash-live.js?raw";

describe("dash-live.js", () => {
  it("keeps the /live WebSocket protocol: site query and a 15 s 'ping'", () => {
    expect(src).toContain('"/live?site="');
    expect(src).toContain("encodeURIComponent(site)");
    expect(src).toContain('ws.send("ping")');
    expect(src).toContain("15000");
    // The ping loop is torn down on close so a reconnect never stacks a second one.
    expect(src).toContain("clearInterval(pingTimer)");
  });

  it("reads the snapshot shape {visitors, topPages:[{label, visitors}]}", () => {
    expect(src).toContain("s.visitors");
    expect(src).toContain("s.topPages");
    expect(src).toContain("p.label");
    expect(src).toContain("p.visitors");
  });

  it("builds rows with textContent, never innerHTML", () => {
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).toContain("a.textContent = p.label");
  });

  it("gives the odometer a blank glyph so 9 -> 10 rolls a new column in", () => {
    // Each strip is [blank, 0..9]; a spare blank column leads the number.
    expect(src).toContain('i < 0 ? "\\u00a0" : String(i)');
    expect(src).toContain("s.length + 1");
  });

  it("reorders active pages by path with a transform-only FLIP and scaleX bars", () => {
    expect(src).toContain('li.setAttribute("data-path", p.label)');
    expect(src).toContain("getBoundingClientRect().top");
    expect(src).toContain('"translateY(" + dy + "px)"');
    // Bars scale through the --s custom property (CSS: transform: scaleX(var(--s))).
    expect(src).toContain('setProperty("--s"');
    expect(src).not.toMatch(/style\.(top|height|width|left)\s*=/);
  });

  it("throttles repaints to 1/s and announcements to one summary per 30 s", () => {
    expect(src).toContain("lastPaint + 1000");
    expect(src).toContain("lastSay + 30000");
    expect(src).toContain('getElementById("live-say")');
  });

  it("toggles the zero (grey) and collapsed-strip states as the count changes", () => {
    expect(src).toContain('toggle("zero", zero)');
    expect(src).toContain('toggle("is-zero", zero)');
    expect(src).toContain('toggle("idle", zero)');
  });
});

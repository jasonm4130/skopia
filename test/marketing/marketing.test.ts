/**
 * Stratus — marketing page tests.
 *
 * Verifies GET "/" returns a well-formed landing page matching the design
 * spec (design/Stratus Marketing.dc.html):
 *   - correct status + content-type
 *   - hero headline present
 *   - AGPL-3.0 license copy (not "MIT licensed")
 *   - pricing section with the correct message
 *   - FAQ markup present
 *   - cost calculator slider + live update elements present
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";

async function fetchRoot(): Promise<{ res: Response; text: string }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://stratus.test/"),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { res, text };
}

describe("marketing landing page", () => {
  it("GET / returns 200 with HTML content-type", async () => {
    const { res } = await fetchRoot();
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/html/);
  });

  it("contains the hero headline 'Your analytics'", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("Your analytics");
  });

  it("contains 'AGPL-3.0' license copy", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("AGPL-3.0");
  });

  it("does NOT contain 'MIT licensed'", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("MIT licensed");
  });

  it("contains the pricing section headline", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("Stratus is free. You just pay Cloudflare.");
  });

  it("contains the FAQ section with 'Questions, answered'", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("Questions, answered");
  });

  it("contains FAQ accordion markup (faq-item, faq-btn, faq-body)", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("faq-item");
    expect(text).toContain("faq-btn");
    expect(text).toContain("faq-body");
  });

  it("contains the cost calculator slider (#calc-slider)", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain('id="calc-slider"');
  });

  it("contains the calculator output elements (#calc-pv, #calc-cost, #calc-note)", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain('id="calc-pv"');
    expect(text).toContain('id="calc-cost"');
    expect(text).toContain('id="calc-note"');
  });

  it("contains the inline client script with the calculator stops", async () => {
    const { text } = await fetchRoot();
    // The script encodes the stops array
    expect(text).toContain("10000000");
    // And the cost formula boundary
    expect(text).toContain("1000000");
  });

  it("'Deploy to Cloudflare' CTA links to /login", async () => {
    const { text } = await fetchRoot();
    // At least one deploy CTA must point at /login
    expect(text).toMatch(/href="\/login"[^>]*>Deploy to Cloudflare/);
  });

  it("'Live demo' links to /app", async () => {
    const { text } = await fetchRoot();
    expect(text).toMatch(/href="\/app"[^>]*>.*[Ll]ive demo/s);
  });

  it("does not contain 'not implemented' (stub is replaced)", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("not implemented");
  });
});

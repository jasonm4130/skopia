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
 *   - correct cost model per spec §9 (free ≤3M, $5 at 10M, ~$55 at 100M)
 *   - no fabricated social proof (no "4.2k" stars, no "3,400+")
 *   - first FAQ item expanded by default (faqOpen=0)
 *   - escHtml escapes single quotes
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

async function fetchRoot(): Promise<{ res: Response; text: string }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://stratus.test/"), env, ctx);
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

  it("contains the inline client script with the 100M stop", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("100000000");
  });

  it("cost formula uses the spec §9 free ceiling of 3M events/mo", async () => {
    const { text } = await fetchRoot();
    // The 3M free ceiling must appear in the stops array
    expect(text).toContain("3000000");
  });

  it("cost formula: free tier threshold is 3M (not 1M)", async () => {
    const { text } = await fetchRoot();
    // The old incorrect threshold was `pv<=1000000` → 0.
    // The correct one is `pv<=3000000` → 0.
    // Note: match the closing paren so `pv<=1000000` isn't matched as a
    // prefix of the legitimate `pv<=10000000)` (the $5 paid-tier band).
    expect(text).toContain("pv<=3000000)");
    expect(text).not.toContain("pv<=1000000)");
  });

  it("cost formula: $5 paid tier covers up to 10M events/mo", async () => {
    const { text } = await fetchRoot();
    // The $5 flat-rate band must reference pv<=10000000
    expect(text).toContain("pv<=10000000");
  });

  it("cost formula: overage rate is $0.55/M above 10M (WAE $0.25 + Workers $0.30)", async () => {
    const { text } = await fetchRoot();
    // The per-million overage multiplier must be 0.55
    expect(text).toContain("0.55");
    // The old incorrect $0.60/M rate must be gone
    expect(text).not.toContain("0.6)");
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

  // Fix 4: no fabricated social proof
  it("does NOT contain fabricated '4.2k' GitHub star count", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("4.2k");
  });

  it("does NOT contain fabricated '3,400+' user count", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("3,400+");
  });

  // Fix 3: slider tick labels match actual stop positions
  it("slider tick labels show 10K, 3M, 100M (matching actual stop positions)", async () => {
    const { text } = await fetchRoot();
    // Left label = first stop (10K), center = 3M (free ceiling), right = 100M
    expect(text).toContain("<span>10K</span><span>3M</span><span>100M</span>");
  });

  // Fix 2: corrected how-it-works and FAQ copy
  it("how-it-works step 3 does NOT claim $5 at one million views", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("five dollars a month at a million views");
  });

  it("how-it-works step 3 references correct free ceiling (~3M) and $5 at ~10M", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("~3M pageviews/mo");
    expect(text).toContain("~$5/mo around 10M");
  });

  it("FAQ cost answer does NOT claim $5 past one million pageviews", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("around $5/mo once you pass roughly a million pageviews");
  });

  it("FAQ cost answer references correct free ceiling (~3M) and $5 plan at ~10M", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("3M pageviews/mo");
    expect(text).toContain("~10M pageviews/mo");
  });

  // Fix 5: first FAQ item expanded by default
  it("first FAQ body is display:block (expanded by default)", async () => {
    const { text } = await fetchRoot();
    // The first faq-body must be display:block; subsequent ones display:none
    const firstBodyIdx = text.indexOf("faq-body");
    expect(text.substring(firstBodyIdx, firstBodyIdx + 120)).toContain("display:block");
  });

  it("first FAQ icon has accent color (open state)", async () => {
    const { text } = await fetchRoot();
    const firstIconIdx = text.indexOf("faq-icon");
    // The first faq-icon must carry the accent color, not the default muted color
    expect(text.substring(firstIconIdx, firstIconIdx + 120)).toContain("color:#4d86ff");
  });

  // Fix 6: escHtml escapes single quotes
  it("escHtml escapes single quotes (&#39; present in source)", async () => {
    const { text } = await fetchRoot();
    // The escHtml function must include the single-quote replacement;
    // this is verified by checking the script contains the &#39; replacement call.
    expect(text).toContain("&#39;");
  });

  // Task 5: honest label — "Single-Page Visits" replaces "Bounce"
  it("demo stat card shows 'Single-Page Visits' not 'Bounce'", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("Single-Page Visits");
    // Guard against false-positive: the standalone word "Bounce" (as a card label)
    // must not appear. We check for the exact label text wrapped in the card markup.
    // The old label was ">Bounce<" in the card's label div.
    expect(text).not.toMatch(/>Bounce</);
  });

  // Task 3 + 4: no Google Fonts external refs; self-hosted @font-face present
  it("does not contain Google Fonts links or preconnects", async () => {
    const { text } = await fetchRoot();
    expect(text).not.toContain("fonts.googleapis.com");
    expect(text).not.toContain("fonts.gstatic.com");
  });

  it("contains self-hosted @font-face rules pointing at /fonts/", async () => {
    const { text } = await fetchRoot();
    expect(text).toContain("@font-face");
    expect(text).toContain("/fonts/space-grotesk-");
    expect(text).toContain("/fonts/hanken-grotesk-");
    expect(text).toContain("/fonts/jetbrains-mono-");
    expect(text).toContain("font-display:swap");
  });

  // Task 4: CSP nonce on inline blocks
  it("inline <style> block carries a nonce attribute", async () => {
    const { text } = await fetchRoot();
    expect(text).toMatch(/<style nonce="[0-9a-f]+">/);
  });

  it("inline <script> block carries a nonce attribute", async () => {
    const { text } = await fetchRoot();
    expect(text).toMatch(/<script nonce="[0-9a-f]+">/);
  });

  it("style and script blocks share the same nonce value", async () => {
    const { text } = await fetchRoot();
    const styleMatch = text.match(/<style nonce="([0-9a-f]+)">/);
    const scriptMatch = text.match(/<script nonce="([0-9a-f]+)">/);
    expect(styleMatch).not.toBeNull();
    expect(scriptMatch).not.toBeNull();
    expect(styleMatch?.[1]).toBe(scriptMatch?.[1]);
  });
});

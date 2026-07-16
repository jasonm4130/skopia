/**
 * Skopia — root route.
 *
 * ADR-0007 moved marketing into its own repo + Worker (skopia.dev). The product
 * Worker no longer serves a landing page at "/"; ADR-0006's addendum requires a
 * `GET / → /app` redirect so a forker hitting the bare root gets the dashboard,
 * not a 404.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function fetchRoot(): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://skopia.test/", { redirect: "manual" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("root route", () => {
  it("GET / redirects to /app (ADR-0006 addendum / ADR-0007)", async () => {
    const res = await fetchRoot();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });

  it("GET / no longer serves the marketing landing page", async () => {
    const res = await fetchRoot();
    const text = await res.text();
    expect(text).not.toContain("Questions, answered");
    expect(text).not.toContain('id="calc-slider"');
  });
});

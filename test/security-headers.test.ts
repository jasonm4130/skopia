/**
 * Tests for src/shared/security-headers.ts
 *
 * Coverage:
 * - Response carries Content-Security-Policy header
 * - CSP contains: script-src 'self' 'nonce-  (nonced script-src)
 * - CSP contains: frame-ancestors 'none'
 * - X-Content-Type-Options: nosniff is set
 * - Two requests produce DIFFERENT nonces
 * - The nonce is accessible inside route handlers via c.get("nonce")
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AppEnv, securityHeaders } from "../src/shared/security-headers";

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", securityHeaders);
  app.get("/ping", (c) => {
    const nonce = c.get("nonce");
    return c.json({ nonce });
  });
  return app;
}

async function fetchApp(app: Hono<AppEnv>, path = "/ping"): Promise<Response> {
  return app.fetch(new Request(`https://test.local${path}`));
}

describe("securityHeaders middleware", () => {
  it("sets Content-Security-Policy header", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("CSP contains script-src 'self' 'nonce-", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
  });

  it("CSP contains frame-ancestors 'none'", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("produces a DIFFERENT nonce on two separate requests", async () => {
    const app = buildApp();
    const [res1, res2] = await Promise.all([fetchApp(app), fetchApp(app)]);
    const csp1 = res1.headers.get("Content-Security-Policy") ?? "";
    const csp2 = res2.headers.get("Content-Security-Policy") ?? "";

    // Extract nonces from CSP: 'nonce-<hex>'
    const nonceMatch1 = csp1.match(/'nonce-([^']+)'/);
    const nonceMatch2 = csp2.match(/'nonce-([^']+)'/);

    expect(nonceMatch1).not.toBeNull();
    expect(nonceMatch2).not.toBeNull();
    expect(nonceMatch1?.[1]).not.toBe(nonceMatch2?.[1]);
  });

  it("nonce is accessible inside the route handler via c.get('nonce')", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    const body = await res.json<{ nonce: string }>();
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    // The nonce in the body must appear in the CSP header
    expect(body.nonce).toBeTruthy();
    expect(csp).toContain(`'nonce-${body.nonce}'`);
  });

  it("sets X-Frame-Options: DENY", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets Referrer-Policy", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("CSP contains 'strict-dynamic' in script-src", async () => {
    const app = buildApp();
    const res = await fetchApp(app);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("'strict-dynamic'");
  });

  it("passes a 101 WebSocket upgrade through without throwing (immutable headers)", async () => {
    // The /live route proxies a 101 Switching Protocols response from the
    // SiteLive DO. Its headers are immutable; setting CSP/hardening headers on
    // it throws "Can't modify immutable headers" → 500. The middleware must
    // skip header mutation for 101 responses.
    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.get("/live", () => {
      const pair = new WebSocketPair();
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    const res = await app.fetch(
      new Request("https://test.local/live", { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(101);
    // CSP must NOT be forced onto the upgrade response.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});

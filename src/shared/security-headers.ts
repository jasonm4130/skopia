/**
 * Skopia — root security-headers middleware (foundation-owned).
 *
 * Mounted once at the app root (src/index.ts). Per request it mints a nonce,
 * exposes it via `c.set("nonce", …)` for SSR inline blocks to read with
 * `c.get("nonce")`, then attaches a strict CSP + the standard hardening headers.
 *
 * 'strict-dynamic': scripts loaded by a nonced inline script inherit trust, so
 * host allowlists in script-src are ignored. Consequence: ANY future
 * `<script src=…>` MUST carry `nonce="${c.get('nonce')}"` or it will be blocked.
 */

import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";

/** Hono app env: bindings + the per-request nonce variable. */
export type AppEnv = { Bindings: Env; Variables: { nonce: string } };

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  c.set("nonce", nonce);

  await next();

  // 101 Switching Protocols (the /live WebSocket upgrade, proxied from the
  // SiteLive DO) carries immutable headers — setting any header below throws
  // "Can't modify immutable headers" → 500. Security headers are meaningless on
  // a protocol-switch response anyway, so skip them.
  if (c.res.status === 101) return;

  const csp = [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // style-src governs <style>/<link> stylesheets — nonce only, no
    // 'unsafe-inline' (so the nonce is meaningful and CSS injection via an
    // injected <style> is blocked). Inline `style="…"` attributes are pervasive
    // in the SSR markup and cannot carry a nonce, so they are permitted via the
    // separate style-src-attr directive; this scopes the unavoidable inline-attr
    // allowance away from stylesheet elements.
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `default-src 'self'`,
    `font-src 'self'`,
    `img-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join("; ");

  const h = c.res.headers;
  h.set("Content-Security-Policy", csp);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
};

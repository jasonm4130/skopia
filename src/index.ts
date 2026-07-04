/**
 * Skopia — root Worker entry (single-Worker topology).
 *
 * One Worker hosts the collector route and the dashboard + marketing SSR.
 * Bindings are shared (wrangler.jsonc). Feature agents implement their own
 * modules (collector / dashboard / marketing) and do not edit this wiring
 * beyond what their surface requires. Phase 2 (ADR-0011): the DO is the sole
 * `rollup_daily` writer — the cron trigger and its export handler are retired.
 */

import { Hono } from "hono";
import { handleCollect, handlePreflight } from "./collector";
import { dashboard } from "./dashboard";
import { marketing } from "./marketing";
import { type AppEnv, securityHeaders } from "./shared/security-headers";
import { SKOPIA_JS } from "./shared/skopia-embed";
import type { Env } from "./shared/types";

// Re-export the Durable Object class so the wrangler migration (new_sqlite_classes:
// ["SiteLive"]) and the SITE_LIVE binding resolve against this entry point.
export { SiteLive } from "./dashboard";

const app = new Hono<AppEnv>();

// Per-request CSP nonce + hardening headers on every response EXCEPT the
// collector (dashboard, marketing still get it). Mounted before routes so all
// of them inherit it. Task 7: `/e` serves a body-less 204 to a <script>
// beacon, never a browser-rendered document — the nonce mint + CSP/hardening
// header pass is pure cost with no security benefit there.
app.use("*", (c, next) => (c.req.path === "/e" ? next() : securityHeaders(c, next)));

// Liveness probe (kept trivial so the walking-skeleton smoke test has a target).
app.get("/health", (c) => c.text("ok"));

// Collector hot path. Hono types `executionCtx` with its own (narrower)
// ExecutionContext; at runtime it IS the Workers one, so we widen at this seam
// to keep the shared handler signatures on the canonical workers-types type.
app.options("/e", (c) => handlePreflight(c.req.raw, c.env));
app.post("/e", (c) => handleCollect(c.req.raw, c.env, c.executionCtx as ExecutionContext));

// Serve the built, minified tracking script. SKOPIA_JS is generated at build
// time by `npm run build:script` (esbuild → scripts/build-embed.mjs) and
// embedded as a string constant so the Worker has zero FS/asset deps at runtime.
// The served bytes equal what scripts/check-script-size.mjs measures.
app.get("/skopia.js", (c) =>
  c.text(SKOPIA_JS, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  }),
);

// App + marketing surfaces. Dashboard owns auth-gated routes and the realtime
// proxy; marketing owns the public landing page. Order: dashboard first so its
// concrete routes win, marketing as the catch-all for the public root.
app.route("/", dashboard);
app.route("/", marketing);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

/**
 * Stratus — root Worker entry (single-Worker topology).
 *
 * One Worker hosts the collector route, the dashboard + marketing SSR, and the
 * cron `scheduled()` rollup. Bindings are shared (wrangler.jsonc). Feature agents
 * implement their own modules (collector / dashboard / marketing / rollup) and do
 * not edit this wiring beyond what their surface requires.
 */

import { Hono } from "hono";
import type { Env } from "./shared/types";
import { securityHeaders, type AppEnv } from "./shared/security-headers";
import { handleCollect, handlePreflight } from "./collector";
import { handleScheduled } from "./rollup";
import { dashboard } from "./dashboard";
import { marketing } from "./marketing";
import { STRATUS_JS } from "./shared/stratus-embed";

// Re-export the Durable Object class so the wrangler migration (new_sqlite_classes:
// ["SiteLive"]) and the SITE_LIVE binding resolve against this entry point.
export { SiteLive } from "./dashboard";

const app = new Hono<AppEnv>();

// Per-request CSP nonce + hardening headers on EVERY response (collector,
// dashboard, marketing). Mounted before routes so all of them inherit it.
app.use("*", securityHeaders);

// Liveness probe (kept trivial so the walking-skeleton smoke test has a target).
app.get("/health", (c) => c.text("ok"));

// Collector hot path. Hono types `executionCtx` with its own (narrower)
// ExecutionContext; at runtime it IS the Workers one, so we widen at this seam
// to keep the shared handler signatures on the canonical workers-types type.
app.options("/e", (c) => handlePreflight(c.req.raw, c.env));
app.post("/e", (c) =>
  handleCollect(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);

// Serve the built, minified tracking script. STRATUS_JS is generated at build
// time by `npm run build:script` (esbuild → scripts/build-embed.mjs) and
// embedded as a string constant so the Worker has zero FS/asset deps at runtime.
// The served bytes equal what scripts/check-script-size.mjs measures.
app.get("/stratus.js", (c) =>
  c.text(STRATUS_JS, 200, {
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
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(controller, env, ctx));
  },
} satisfies ExportedHandler<Env>;

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
import { handleCollect, handlePreflight } from "./collector";
import { handleScheduled } from "./rollup";
import { dashboard } from "./dashboard";
import { marketing } from "./marketing";

// Re-export the Durable Object class so the wrangler migration (new_sqlite_classes:
// ["SiteLive"]) and the SITE_LIVE binding resolve against this entry point.
export { SiteLive } from "./dashboard";

const app = new Hono<{ Bindings: Env }>();

// Liveness probe (kept trivial so the walking-skeleton smoke test has a target).
app.get("/health", (c) => c.text("ok"));

// Collector hot path. Hono types `executionCtx` with its own (narrower)
// ExecutionContext; at runtime it IS the Workers one, so we widen at this seam
// to keep the shared handler signatures on the canonical workers-types type.
app.options("/e", (c) => handlePreflight(c.req.raw, c.env));
app.post("/e", (c) =>
  handleCollect(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);

// Serve the built tracking script (the SCRIPT agent wires asset delivery).
app.get("/stratus.js", (c) => {
  void c;
  throw new Error("not implemented");
});

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

/**
 * Skopia — dashboard Worker surface (SSR + auth + realtime proxy).
 *
 * Hono sub-app mounted at "/" by src/index.ts. Owns:
 *   /setup            — first-run owner account creation
 *   /login            — password login → signed-cookie session
 *   /logout           — clear session
 *   /app              — auth-gated Overview (redirects to /login when not authed)
 *   /app/{view}       — auth-gated breakdown views (views.ts BREAKDOWN_VIEWS)
 *   /share/:token     — public read-only single-site overview (no auth; ADR-0012)
 *   /share/:token/{view} — public breakdown views (the `shared` subset)
 *   /live             — WebSocket proxy → SiteLive DO
 *
 * Module map: auth.ts (cookie + password + requireAuth), range.ts, views.ts
 * (the per-view config table), render/* (pure string builders), routes/*.
 *
 * Auth (spec §7.2): HMAC-SHA256 signed HttpOnly cookie, Web Crypto only.
 * Never registers a bare "/" route — the root Worker redirects "/" → "/app" (ADR-0007).
 */

import { Hono } from "hono";
import { ensureSchema } from "../shared/schema";
import type { DashEnv } from "./env";
import { registerAppRoutes } from "./routes/app";
import { registerAuthRoutes } from "./routes/auth";
import { registerShareRoutes } from "./routes/share";

export { parseRange } from "./range";
export { SiteLive } from "./site-live";

export const dashboard = new Hono<DashEnv>();

// Cold-account D1 bootstrap. Registered first so it runs before any route
// handler (and before requireAuth) reads D1 — on a fresh account the migration
// has never run, so getOwner()'s SELECT would 500. ensureSchema is idempotent
// and cached per isolate, so this is cheap on warm requests.
dashboard.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

registerAuthRoutes(dashboard);
registerShareRoutes(dashboard);
registerAppRoutes(dashboard);

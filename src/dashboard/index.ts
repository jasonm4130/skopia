/**
 * Stratus — dashboard Worker surface (SSR + auth + realtime proxy).
 *
 * A Hono sub-app: first-run owner setup + signed-cookie login (spec §7.2), the
 * SSR Overview/Pages/Sources/Geography views reading D1 via src/db/queries.ts
 * (design/Stratus Dashboard.dc.html is the behavioral spec), the per-site
 * `/public/<token>` read-only views (spec §7.1), and the `/live` WebSocket proxy
 * to the SiteLive DO (spec §6).
 *
 * Foundation provides the typed entry + the SiteLive DO class export; the
 * DASHBOARD agent implements the routes and the DO's live-count logic.
 */

import { Hono } from "hono";
import type { Env } from "../shared/types";

export { SiteLive } from "./site-live";

/** The dashboard sub-app, mounted at `/` by the root Worker (src/index.ts). */
export const dashboard = new Hono<{ Bindings: Env }>();

dashboard.all("*", (c) => {
  void c;
  throw new Error("not implemented");
});

/**
 * Stratus — marketing / landing surface.
 *
 * The public landing page: hero, how-it-works, features, comparison, pricing +
 * live cost calculator, FAQ, CTA, footer (design/Stratus Marketing.dc.html is
 * the visual + behavioral spec; Phase 5 / launch). Served from the same Worker
 * at the site root for unauthenticated visitors who are not hitting the app.
 *
 * Foundation provides the typed entry; the MARKETING agent implements the routes.
 */

import { Hono } from "hono";
import type { Env } from "../shared/types";

/** The marketing sub-app (landing page + static marketing assets). */
export const marketing = new Hono<{ Bindings: Env }>();

marketing.all("*", (c) => {
  void c;
  throw new Error("not implemented");
});

/** Skopia — auth-gated /app/* views and the /live WebSocket proxy. */

import type { Context, Hono } from "hono";
import { listSites } from "../../db/queries";
import type { SiteRow } from "../../shared/types";
import { requireAuth } from "../auth";
import type { DashEnv } from "../env";
import { readLiveSnapshot } from "../live-snapshot";
import { parseRange } from "../range";
import { type Chrome, htmlDoc, shell } from "../render/layout";
import { liveScript } from "../render/live";
import { noSitesPage } from "../render/pages";
import { BREAKDOWN_VIEWS, breakdownPage, overviewContent, type ViewCtx } from "../views";

// ---------------------------------------------------------------------------
// Helper: the full site list + the active site (for the switcher)
// ---------------------------------------------------------------------------

async function resolveSites(
  db: D1Database,
  siteParam: string | undefined,
): Promise<{ sites: SiteRow[]; site: SiteRow | null }> {
  const sites = await listSites(db);
  const site = (siteParam ? sites.find((s) => s.id === siteParam) : sites[0]) ?? null;
  return { sites, site };
}

export function registerAppRoutes(dashboard: Hono<DashEnv>): void {
  // -------------------------------------------------------------------------
  // Route: /live — WebSocket proxy to SiteLive DO (auth-gated)
  // -------------------------------------------------------------------------

  // Middleware for /live — same auth gate as /app routes.
  // WebSocket upgrades are plain GETs so the middleware runs before the handshake.
  dashboard.use("/live", requireAuth);

  dashboard.get("/live", async (c) => {
    const siteId = c.req.query("site") ?? "";
    if (!siteId) return new Response("Missing site param", { status: 400 });

    const upgradeHeader = c.req.header("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // CSRF/cross-site-WebSocket guard: the session cookie alone authorizes this
    // upgrade (cookies ride along with any cross-site request), so a page on
    // another origin could otherwise open this socket using the dashboard
    // owner's browser. Require a same-origin `Origin` header, same as a
    // same-site cookie policy would enforce for a regular request.
    const originHeader = c.req.header("Origin");
    if (!originHeader) {
      return new Response("Missing Origin", { status: 403 });
    }
    try {
      if (new URL(originHeader).host !== new URL(c.req.url).host) {
        return new Response("Cross-origin WebSocket rejected", { status: 403 });
      }
    } catch {
      return new Response("Invalid Origin", { status: 403 });
    }

    const id = c.env.SITE_LIVE.idFromName(siteId);
    const stub = c.env.SITE_LIVE.get(id);

    // Proxy the upgrade to the DO. Build a fresh Request with the WS headers.
    const doUrl = new URL(c.req.url);
    doUrl.pathname = "/live";
    const proxyReq = new Request(doUrl.toString(), {
      headers: c.req.raw.headers,
    });

    return stub.fetch(proxyReq);
  });

  // -------------------------------------------------------------------------
  // Auth-gated /app routes
  // -------------------------------------------------------------------------

  // Middleware for all /app routes
  dashboard.use("/app", requireAuth);
  dashboard.use("/app/*", requireAuth);

  /**
   * Render one authed view: resolve the site from ?site=, then wrap `content`
   * in the app layout with the live client appended. `onNoSite` decides what a
   * request with no resolvable site gets (the Overview shows the empty state).
   */
  const serveApp = async (
    c: Context<DashEnv>,
    view: string,
    title: (site: SiteRow) => string,
    content: (ctx: ViewCtx) => Promise<string>,
    onNoSite: (sites: SiteRow[]) => Response,
  ): Promise<Response> => {
    const nonce = c.get("nonce");
    const range = parseRange(c.req.query("range"));
    const { sites, site } = await resolveSites(c.env.DB, c.req.query("site"));
    if (!site) return onNoSite(sites);

    const ch: Chrome = { surface: "app", view, site, sites, token: "", rangeKey: range.key };
    // Only the Overview shows online-now, so only it pays for the DO read. A failed
    // read still renders the (zero) compartment: the /live socket fills it in.
    const live =
      view === "overview"
        ? ((await readLiveSnapshot(c.env, site.id)) ?? { visitors: 0, topPages: [] })
        : null;
    const body =
      (await content({ db: c.env.DB, site, range, nonce, ch, live })) + liveScript(site.id, nonce);

    return c.html(htmlDoc(title(site), shell(ch, body), nonce));
  };

  // Overview
  dashboard.get("/app", (c) =>
    serveApp(
      c,
      "overview",
      (site) => site.name,
      (ctx) => overviewContent(ctx, { share: false }),
      (sites) => {
        // A bad/unknown ?site= among existing sites is not "no sites tracked" —
        // fall back to the default site (consistent with every other /app/*
        // view, which does `if (!site) return c.redirect("/app")`) instead of
        // showing the empty-state copy while real sites exist.
        if (sites.length > 0) return c.redirect("/app");
        return c.html(noSitesPage(c.get("nonce")));
      },
    ),
  );

  // Breakdown views
  for (const view of BREAKDOWN_VIEWS) {
    dashboard.get(`/app/${view.id}`, (c) =>
      serveApp(
        c,
        view.id,
        (site) => `${view.title} — ${site.name}`,
        (ctx) => breakdownPage(view, ctx),
        () => c.redirect("/app"),
      ),
    );
  }
}

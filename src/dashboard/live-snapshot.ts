/** Skopia — best-effort server-side read of a site's SiteLive snapshot. */

import type { Env, LiveSnapshot } from "../shared/types";

/**
 * One `snapshot()` RPC to the site's SiteLive DO, so a page renders the right
 * online-now state before any WebSocket connects. Best-effort: a DO failure
 * degrades to `null` (the page omits the compartment), never a 500 — the
 * count is a nicety, the page is the product.
 */
export async function readLiveSnapshot(env: Env, siteId: string): Promise<LiveSnapshot | null> {
  try {
    const ns = env.SITE_LIVE;
    const stub = ns.get(ns.idFromName(siteId)) as unknown as {
      snapshot(): Promise<LiveSnapshot>;
    };
    const snap = await stub.snapshot();
    return { visitors: Number(snap.visitors) || 0, topPages: snap.topPages ?? [] };
  } catch {
    return null;
  }
}

/**
 * Stratus — SiteLive Durable Object (per-site live visitor count, spec §6).
 *
 * One instance per site (`idFromName(site_id)`). Keeps an in-memory
 * `vid -> lastSeen` map, evicts entries older than 5 minutes (driven by a DO
 * Alarm), and treats the map size as the live-visitor count. Dashboards connect
 * over a hibernatable WebSocket (`acceptWebSocket`/`getWebSockets`) and receive
 * the count + top active pages on change.
 *
 * Foundation provides the typed class skeleton; the DASHBOARD/realtime agent
 * implements the live-count logic. Stubs throw until implemented.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, LiveSnapshot } from "../shared/types";

export class SiteLive extends DurableObject<Env> {
  /**
   * HTTP entry: `/hit` (collector bumps a vid via waitUntil) and `/live`
   * (dashboard opens the WebSocket). Implemented by the realtime agent.
   */
  override async fetch(request: Request): Promise<Response> {
    void request;
    throw new Error("not implemented");
  }

  /** Hibernation-API message handler (WS clients). */
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    void ws, void message;
    throw new Error("not implemented");
  }

  /** Hibernation-API close handler. */
  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void ws, void code, void reason, void wasClean;
    throw new Error("not implemented");
  }

  /** Eviction tick: drop visitors not seen in the last 5 minutes (spec §6). */
  override async alarm(): Promise<void> {
    throw new Error("not implemented");
  }

  /** Current live snapshot (count + top active pages). */
  async snapshot(): Promise<LiveSnapshot> {
    throw new Error("not implemented");
  }
}

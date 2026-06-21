/**
 * Stratus — SiteLive Durable Object (per-site live visitor count, spec §6).
 *
 * One instance per site (`idFromName(site_id)`). Keeps an in-memory
 * `vid -> lastSeen` map, evicts entries older than 5 minutes (driven by a DO
 * Alarm), and treats the map size as the live-visitor count. Dashboards connect
 * over a hibernatable WebSocket (`acceptWebSocket`/`getWebSockets`) and receive
 * the count + top active pages on change.
 */

import { DurableObject } from "cloudflare:workers";
import type { BreakdownRow, Env, LiveSnapshot } from "../shared/types";

/** TTL for a visitor in the live map: 5 minutes in ms. */
const VISITOR_TTL_MS = 5 * 60 * 1000;

/** Alarm tick interval: 30 seconds. */
const ALARM_INTERVAL_MS = 30_000;

interface VisitorEntry {
  lastSeen: number;
  path: string;
}

export class SiteLive extends DurableObject<Env> {
  /** vid -> { lastSeen, path } */
  private visitors = new Map<string, VisitorEntry>();

  /**
   * HTTP entry:
   *   POST /hit  — collector bumps a vid via waitUntil
   *   GET  /live — dashboard upgrades to WebSocket
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/hit") {
      return this.handleHit(request);
    }

    if (url.pathname === "/live") {
      return this.handleLiveWs(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleHit(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const vid = url.searchParams.get("vid") ?? "unknown";
    const path = url.searchParams.get("path") ?? "/";

    this.visitors.set(vid, { lastSeen: Date.now(), path });

    // Schedule alarm to evict stale entries (idempotent — only schedules if
    // no alarm is already set for this DO).
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }

    // Push updated snapshot to all connected dashboard WebSockets.
    this.broadcast();

    return new Response(null, { status: 204 });
  }

  private handleLiveWs(request: Request): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    // WebSocketPair exposes its sockets at indices 0 and 1.
    const client = pair[0];
    const server = pair[1];

    // Use the Hibernation API so the DO can sleep between messages.
    this.ctx.acceptWebSocket(server);

    // Send the current snapshot immediately on connect.
    server.send(JSON.stringify(this.currentSnapshot()));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hibernation-API message handler — clients can send "ping" for a refresh. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") {
      ws.send(JSON.stringify(this.currentSnapshot()));
    }
  }

  /** Hibernation-API close handler — nothing to clean up (session is gone). */
  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  /** Hibernation-API error handler — close the socket to remove stale entries. */
  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    void error;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  /** Eviction tick: drop visitors not seen in the last 5 minutes (spec §6). */
  override async alarm(): Promise<void> {
    const cutoff = Date.now() - VISITOR_TTL_MS;
    let evicted = false;

    for (const [vid, entry] of this.visitors) {
      if (entry.lastSeen < cutoff) {
        this.visitors.delete(vid);
        evicted = true;
      }
    }

    if (evicted) {
      this.broadcast();
    }

    // Reschedule only while there are still live visitors to watch.
    if (this.visitors.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /** Current live snapshot (count + top active pages). */
  async snapshot(): Promise<LiveSnapshot> {
    return this.currentSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private currentSnapshot(): LiveSnapshot {
    const pageCounts = new Map<string, number>();
    for (const { path } of this.visitors.values()) {
      pageCounts.set(path, (pageCounts.get(path) ?? 0) + 1);
    }

    const total = this.visitors.size;
    const topPages: BreakdownRow[] = Array.from(pageCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, count]) => ({
        label,
        pageviews: count,
        visitors: count,
        share: total > 0 ? count / total : 0,
        sampled: false,
      }));

    return { visitors: total, topPages };
  }

  private broadcast(): void {
    const payload = JSON.stringify(this.currentSnapshot());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // ignore closed sockets
      }
    }
  }
}

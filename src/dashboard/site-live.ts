/**
 * Skopia — SiteLive Durable Object (per-site live visitor count, spec §6).
 *
 * One instance per site (`idFromName(site_id)`). Keeps an in-memory
 * `vid -> lastSeen` map, evicts entries older than 5 minutes (driven by a DO
 * Alarm), and treats the map size as the live-visitor count. Dashboards connect
 * over a hibernatable WebSocket (`acceptWebSocket`/`getWebSockets`) and receive
 * the count + top active pages on change.
 */

import { DurableObject } from "cloudflare:workers";
import { utcDay } from "../shared/identity";
import type { BreakdownRow, Env, LiveSnapshot, RollupDimension } from "../shared/types";
import { type CountEvent, eventDimensions } from "./event-dimensions";

/** TTL for a visitor in the live map: 5 minutes in ms. */
const VISITOR_TTL_MS = 5 * 60 * 1000;

/** Alarm tick interval: 15 seconds — flush + live-eviction (spec §6). */
const ALARM_INTERVAL_MS = 15_000;

/** Durable distinct-visitor set. WITHOUT ROWID => PK insert is 1 row written. */
const SEEN_DDL = `CREATE TABLE IF NOT EXISTS seen (
  day        TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  dim_value  TEXT NOT NULL,
  vid        TEXT NOT NULL,
  PRIMARY KEY (day, dimension, dim_value, vid)
) WITHOUT ROWID`;

/** Phase 1 writes the shadow table; Phase 2 flips this to "rollup_daily". */
const FLUSH_TABLE = "rollup_daily_shadow";

const FLUSH_UPSERT = `
INSERT INTO ${FLUSH_TABLE} (site_id, day, dimension, dim_value, pageviews, visitors, sampled)
VALUES (?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(site_id, day, dimension, dim_value)
DO UPDATE SET
  pageviews = ${FLUSH_TABLE}.pageviews + excluded.pageviews,
  visitors  = excluded.visitors,
  sampled   = 0
`.trim();

/** RAM pending key: dimension + \u0001 + dim_value (NEVER \x00). */
function pendingKey(dimension: string, dimValue: string): string {
  return `${dimension}\u0001${dimValue}`;
}

interface VisitorEntry {
  lastSeen: number;
  path: string;
}

/** One pending bucket: a (dimension, dim_value)'s un-flushed pageview delta. */
interface PendingRow {
  dimension: RollupDimension;
  dimValue: string;
  delta: number;
}

/**
 * Durable snapshot of everything flush() needs. Persisted on every event so the
 * counters survive a Hibernation-API sleep / eviction / deploy that discards RAM
 * (ADR-0010). Before this, un-flushed deltas were lost when the DO slept (~10s)
 * before the 15s flush alarm, so pageviews were badly under-counted.
 */
interface FlushState {
  siteId: string | null;
  currentDay: string | null;
  pending: Map<string, PendingRow>;
}

/** Durable storage key for the serialized FlushState (one row, rewritten/event). */
const FLUSH_STATE_KEY = "flushstate";

export class SiteLive extends DurableObject<Env> {
  /** vid -> { lastSeen, path } — live window (RAM, ephemeral by design). */
  private visitors = new Map<string, VisitorEntry>();

  /** Per-(dimension,dim_value) pageview delta since the last flush + dirty set. */
  private pending = new Map<string, PendingRow>();

  /** UTC day the RAM state belongs to (rollover detection). */
  private currentDay: string | null = null;

  /** site_id, learned from the first event (needed for the D1 flush). */
  private siteId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup is synchronous; safe in the constructor for SQLite DOs.
    this.ctx.storage.sql.exec(SEEN_DDL);
    // Rehydrate un-flushed counters from durable storage before any request or
    // alarm runs, so a cold-started instance (post-hibernation) flushes the real
    // deltas instead of an empty map (ADR-0010).
    this.ctx.blockConcurrencyWhile(async () => {
      await this.rehydrate();
      // If we came back holding un-flushed work but no alarm is armed, arm one so
      // the deltas still reach D1.
      if (this.pending.size > 0 && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
    });
  }

  /**
   * HTTP entry:
   *   POST /event — collector forwards enriched event (live map + rollup)
   *   GET  /live  — dashboard upgrades to WebSocket
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/event") {
      return this.handleEvent(request);
    }

    if (url.pathname === "/live") {
      return this.handleLiveWs(request);
    }

    return new Response("Not found", { status: 404 });
  }

  /** Collector hot path: live-map update + dimensional counting in one call. */
  private async handleEvent(request: Request): Promise<Response> {
    let e: CountEvent;
    try {
      e = (await request.json()) as CountEvent;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // Live window: track visitor for the real-time dashboard.
    this.visitors.set(e.vid, { lastSeen: Date.now(), path: e.path });

    // Dimensional counting (new).
    await this.recordEvent(e);

    // Arm the flush/evict alarm if none is pending (idempotent).
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }

    this.broadcast();
    return new Response(null, { status: 204 });
  }

  /** Record one enriched event into RAM deltas + the durable seen set (spec §5). */
  async recordEvent(e: CountEvent): Promise<void> {
    this.siteId = e.siteId;
    const day = utcDay(new Date());
    await this.maybeRollover(day);
    this.currentDay = day;

    for (const c of eventDimensions(e)) {
      const key = pendingKey(c.dimension, c.dimValue);
      const cur = this.pending.get(key);
      if (cur) {
        cur.delta += c.pv;
      } else {
        this.pending.set(key, { dimension: c.dimension, dimValue: c.dimValue, delta: c.pv });
      }
      // INSERT OR IGNORE: a returning visitor is a no-op (0 rows written).
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO seen (day, dimension, dim_value, vid) VALUES (?, ?, ?, ?)",
        day,
        c.dimension,
        c.dimValue,
        e.vid,
      );
    }

    // Durably snapshot the counters so a hibernation before the next flush can't
    // drop them (ADR-0010). One put per event, independent of dimension count.
    await this.persistPending();
  }

  /** Reload the durable FlushState into RAM — the cold-start / construction path. */
  private async rehydrate(): Promise<void> {
    const s = await this.ctx.storage.get<FlushState>(FLUSH_STATE_KEY);
    if (s) {
      this.siteId = s.siteId;
      this.currentDay = s.currentDay;
      this.pending = s.pending;
    }
  }

  /** Persist the current flush state as a single durable row (ADR-0010). */
  private async persistPending(): Promise<void> {
    await this.ctx.storage.put<FlushState>(FLUSH_STATE_KEY, {
      siteId: this.siteId,
      currentDay: this.currentDay,
      pending: this.pending,
    });
  }

  /** Flush dirty counters to D1 (spec §6). Pageviews add; visitors are exact. */
  async flush(): Promise<void> {
    if (this.siteId === null || this.currentDay === null || this.pending.size === 0) return;
    const day = this.currentDay;
    const site = this.siteId;

    const stmts = [];
    for (const { dimension, dimValue, delta } of this.pending.values()) {
      const visitors = this.countSeen(day, dimension, dimValue);
      stmts.push(
        this.env.DB.prepare(FLUSH_UPSERT).bind(site, day, dimension, dimValue, delta, visitors),
      );
    }

    try {
      for (let i = 0; i < stmts.length; i += 100) {
        await this.env.DB.batch(stmts.slice(i, i + 100));
      }
      this.pending.clear(); // only on success — otherwise retry next alarm
      // Drop the durable snapshot too, so a post-flush cold start can't re-apply
      // these now-committed deltas (the flush UPSERT is additive) — ADR-0010.
      await this.ctx.storage.delete(FLUSH_STATE_KEY);
    } catch {
      // Leave pending intact; the next flush retries. WAE still holds the raw events.
    }
  }

  /** Exact distinct visitors for a (day, dimension, value) from the durable set. */
  private countSeen(day: string, dimension: string, dimValue: string): number {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT COUNT(*) AS c FROM seen WHERE day = ? AND dimension = ? AND dim_value = ?",
        day,
        dimension,
        dimValue,
      )
      .one();
    return Number(row.c);
  }

  /** On a UTC day change: flush the old day, reset the seen set, clear pending. */
  private async maybeRollover(newDay: string): Promise<void> {
    if (this.currentDay !== null && this.currentDay !== newDay) {
      await this.flush(); // flushes under the OLD this.currentDay
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS seen"); // not DELETE — no per-row writes
      this.ctx.storage.sql.exec(SEEN_DDL);
      this.pending.clear();
    }
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

  /** Tick: flush counters, then evict stale live visitors (spec §6). */
  override async alarm(): Promise<void> {
    await this.flush();

    const cutoff = Date.now() - VISITOR_TTL_MS;
    let evicted = false;
    for (const [vid, entry] of this.visitors) {
      if (entry.lastSeen < cutoff) {
        this.visitors.delete(vid);
        evicted = true;
      }
    }
    if (evicted) this.broadcast();

    // Reschedule while there is live activity or counters still to flush.
    if (this.visitors.size > 0 || this.pending.size > 0) {
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

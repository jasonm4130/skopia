/**
 * Skopia — SiteLive Durable Object (per-site live visitor count, spec §6).
 *
 * One instance per site (`idFromName(site_id)`). Keeps an in-memory
 * `vid -> lastSeen` map, lazily evicts entries older than 5 minutes on read
 * (no alarm involved — see `currentSnapshot()`), and treats the map size as
 * the live-visitor count. Dashboards connect over a hibernatable WebSocket
 * (`acceptWebSocket`/`getWebSockets`) and receive the count + top active pages
 * on change.
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

/** Phase 2 (cutover, ADR-0011): the DO is the sole writer of "rollup_daily". */
const FLUSH_TABLE = "rollup_daily";

const FLUSH_UPSERT = `
INSERT INTO ${FLUSH_TABLE} (site_id, day, dimension, dim_value, pageviews, visitors, sampled)
VALUES (?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(site_id, day, dimension, dim_value)
DO UPDATE SET
  pageviews = ${FLUSH_TABLE}.pageviews + excluded.pageviews,
  visitors  = excluded.visitors,
  sampled   = 0
`.trim();

/** RAM pending key: day + \u0001 + dimension + \u0001 + dim_value (NEVER \x00). */
function pendingKey(day: string, dimension: string, dimValue: string): string {
  return `${day}\u0001${dimension}\u0001${dimValue}`;
}

interface VisitorEntry {
  lastSeen: number;
  path: string;
}

/** One pending bucket: a (day, dimension, dim_value)'s un-flushed pageview delta. */
interface PendingRow {
  day: string;
  dimension: RollupDimension;
  dimValue: string;
  delta: number;
}

/**
 * Durable snapshot of everything flush() needs. Persisted on every event so the
 * counters survive a Hibernation-API sleep / eviction / deploy that discards RAM
 * (ADR-0010). Before this, un-flushed deltas were lost when the DO slept (~10s)
 * before the 15s flush alarm, so pageviews were badly under-counted.
 *
 * v2 keys pending rows by day (rows carry their own `day`), so a UTC midnight
 * crossing needs no special-case flush. {@link LegacyFlushState} is the pre-v2
 * blob shape, migrated on rehydrate so deployed DOs don't lose in-flight deltas.
 */
interface FlushState {
  v: 2;
  siteId: string | null;
  pending: Map<string, PendingRow>;
}

/** Pre-v2 pending row: no `day` (rows shared one {@link LegacyFlushState.currentDay}). */
interface LegacyPendingRow {
  dimension: RollupDimension;
  dimValue: string;
  delta: number;
}

/** Pre-v2 durable blob: 2-part keys under one `currentDay`, no version tag. */
interface LegacyFlushState {
  siteId: string | null;
  currentDay: string | null;
  pending: Map<string, LegacyPendingRow>;
}

/** Durable storage key for the serialized FlushState (one row, rewritten/event). */
const FLUSH_STATE_KEY = "flushstate";

export class SiteLive extends DurableObject<Env> {
  /** vid -> { lastSeen, path } — live window (RAM, ephemeral by design). */
  private visitors = new Map<string, VisitorEntry>();

  /** Per-(day,dimension,dim_value) pageview delta since the last flush. */
  private pending = new Map<string, PendingRow>();

  /** Last UTC day the durable `seen` set was pruned (RAM; re-prunes on loss). */
  private lastPruneDay: string | null = null;

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

    for (const c of eventDimensions(e)) {
      const key = pendingKey(day, c.dimension, c.dimValue);
      const cur = this.pending.get(key);
      if (cur) {
        cur.delta += c.pv;
      } else {
        this.pending.set(key, { day, dimension: c.dimension, dimValue: c.dimValue, delta: c.pv });
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
    const s = await this.ctx.storage.get<FlushState | LegacyFlushState>(FLUSH_STATE_KEY);
    if (!s) return;
    this.siteId = s.siteId;
    if ("v" in s) {
      this.pending = s.pending;
      return;
    }
    // Pre-v2 blob (ADR-0010): 2-part keys under one currentDay. Remap to
    // day-scoped keys/rows so the day-agnostic flush drains them without loss.
    const day = s.currentDay;
    const migrated = new Map<string, PendingRow>();
    if (day !== null) {
      for (const [key, row] of s.pending) {
        migrated.set(`${day}\u0001${key}`, { day, ...row });
      }
    }
    this.pending = migrated;
  }

  /** Persist the current flush state as a single durable row (ADR-0010). */
  private async persistPending(): Promise<void> {
    await this.ctx.storage.put<FlushState>(FLUSH_STATE_KEY, {
      v: 2,
      siteId: this.siteId,
      pending: this.pending,
    });
  }

  /** Flush dirty counters to D1 (spec §6). Pageviews add; visitors are exact. */
  async flush(): Promise<void> {
    if (this.siteId === null || this.pending.size === 0) return;
    const site = this.siteId;

    // Bind every pending row up front and remember the (key, delta) captured at
    // bind time per statement. A committed chunk is SUBTRACTED from `pending`
    // rather than clearing the whole map: D1 calls are subrequests, so the input
    // gate stays OPEN across the await and an event can grow a row mid-flush —
    // subtracting only the bound delta preserves that event's contribution.
    const stmts = [];
    const bound: { key: string; delta: number }[] = [];
    for (const [key, { day, dimension, dimValue, delta }] of this.pending) {
      const visitors = this.countSeen(day, dimension, dimValue);
      stmts.push(
        this.env.DB.prepare(FLUSH_UPSERT).bind(site, day, dimension, dimValue, delta, visitors),
      );
      bound.push({ key, delta });
    }

    try {
      for (let i = 0; i < stmts.length; i += 100) {
        await this.env.DB.batch(stmts.slice(i, i + 100));
        // Committed: subtract exactly what this chunk wrote. A row that grew
        // mid-flush keeps the remainder; a row drained to zero is removed.
        for (const { key, delta } of bound.slice(i, i + 100)) {
          const row = this.pending.get(key);
          if (row) {
            row.delta -= delta;
            if (row.delta === 0) this.pending.delete(key);
          }
        }
        // Persist the remainder after EACH chunk so a crash between chunks can
        // re-apply at most this one chunk, never an already-committed one (the
        // flush UPSERT is additive) — chunk-bounded ADR-0010 risk.
        if (this.pending.size === 0) {
          await this.ctx.storage.delete(FLUSH_STATE_KEY);
        } else {
          await this.persistPending();
        }
      }
    } catch {
      // A chunk threw: stop. The remaining chunks stay in `pending` and the
      // durable snapshot already reflects exactly what is still owed, so the
      // next alarm retries them with no re-apply. WAE still holds the raw events.
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

  /** Tick: flush counters, prune stale seen rows (spec §6). */
  override async alarm(): Promise<void> {
    await this.flush();

    // Sweep the live map while we are here (busy-site growth bound — see
    // evictStale). Costs no extra writes: this alarm was armed by `pending`.
    this.evictStale();

    // After a clean flush (nothing still owed), lazily prune the durable `seen`
    // set of past days — at most one DELETE per UTC day per instance. Guarded on
    // an empty `pending` so a failed flush never drops seen rows a retry needs.
    if (this.pending.size === 0) {
      const today = utcDay(new Date());
      if (today !== this.lastPruneDay) {
        this.ctx.storage.sql.exec("DELETE FROM seen WHERE day < ?", today);
        this.lastPruneDay = today;
      }
    }

    // Reschedule only while there are counters still to flush. Live-visitor
    // eviction is lazy (see `currentSnapshot()`) and no longer keeps the alarm
    // ticking — a session with no further events must not trail up to ~20
    // billed setAlarm row-writes waiting out the 5-minute live TTL.
    if (this.pending.size > 0) {
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

  /**
   * Drop live-map entries older than VISITOR_TTL_MS. Called on every read
   * (snapshot) and on every flush alarm: a busy site with no dashboard
   * connected keeps the DO warm indefinitely (no hibernation reset) and never
   * snapshots, so the alarm — already armed by `pending` on exactly that
   * traffic — is what bounds `visitors` growth there.
   */
  private evictStale(): void {
    const cutoff = Date.now() - VISITOR_TTL_MS;
    for (const [vid, entry] of this.visitors) {
      if (entry.lastSeen < cutoff) {
        this.visitors.delete(vid);
      }
    }
  }

  private currentSnapshot(): LiveSnapshot {
    // Read-time eviction (Task 3): the live count is correct at every read.
    this.evictStale();

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
    // Skip building the snapshot entirely when no dashboard is connected.
    if (this.ctx.getWebSockets().length === 0) return;
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

# Skopia — Event-driven DO incremental counters (rollup redesign)

- **Date:** 2026-06-29
- **Author:** brainstorming session (human: Jason) + `cloudflare-tech-lead` cost review
- **Status:** Approved design — ready for `writing-plans` → `subagent-driven-development`
- **Supersedes:** the cron-poll half of **ADR-0003 (query-and-rollup)**. Touches
  **ADR-0002 (ingestion-and-identity)** (salt rotation) and **ADR-0004 (realtime)** (the
  `SiteLive` DO gains durable counting alongside its live-visitor role). A follow-up ADR
  (**0010**) should record the supersession when this ships.
- **Evidence base:** Cloudflare pricing + SQLite-in-DO row-billing semantics retrieved
  **2026-06-29** (see §8). Grounded against `src/collector/index.ts`,
  `src/dashboard/site-live.ts`, `src/rollup/index.ts`, `migrations/0001_init.sql`,
  `wrangler.jsonc`.

---

## 0. Design stance (the one-paragraph version)

Replace the 5-minute cron that polls Workers Analytics Engine (WAE) and UPSERTs daily
aggregates into D1 with **event-driven incremental counters inside the per-site `SiteLive`
Durable Object**. The collector keeps writing every raw event to WAE (unchanged — WAE stays
the raw/exploratory store and the durability backstop), and additionally forwards the
enriched event to the site's DO. The DO maintains today's aggregates and flushes them to the
**unchanged** D1 `rollup_daily` table on a short post-activity alarm. The dashboard still
reads D1 — no dashboard change. The cron, `src/rollup/index.ts`, and the Worker's
`scheduled()` handler are deleted. **The one inviolable rule, from the cost review: never
write to durable storage on the per-event hot path** — accumulate in RAM, flush periodically.
Per-event durable writes amplify ~14× and would cost ~$1,365/mo at 100M pageviews; the
write-back pattern keeps it flat at ~$20–50/mo.

> **Amended by [ADR-0010](../decisions/0010-do-pending-durability.md) (2026-07-01):** this
> rule was too strong. RAM-only counters were discarded when the DO slept via the
> Hibernation API (~10s) before the 15s flush alarm, badly under-counting pageviews in the
> Phase-1 parity run. The revised rule: never write a *per-dimension* counter per event (the
> ~14× amplification above), but *exactly one* fixed durable `flushstate` blob write per
> event **is** required for correctness — one row-write/event, ~$15/mo added at 20M events.

---

## 1. Motivation

The current rollup (ADR-0003) re-queries WAE for every dimension of every site every 5
minutes, whether or not the site had traffic. It has three problems this redesign fixes:

1. **Idle cost & latency** — it polls all sites on a fixed tick; "today" is up to 5 minutes
   stale; a slow/large pass risks exceeding the cron's `waitUntil` budget (the visitors-bug
   we already hit).
2. **Coupling to the WAE SQL API** — a read-path dependency (token scope, query limits,
   sampling) for what should be a write-time aggregation.
3. **No real-time aggregates** — the live DO already sees every event but throws the data
   away after computing a 5-minute live count.

Event-driven counting makes "today" fresh within the flush interval, removes the idle poll,
and reuses the per-event DO hit the live feature already pays for.

---

## 2. Architecture & data flow

```
  BROWSER ── POST /e ──▶ COLLECTOR Worker (src/collector)
                          │  1. cookieless vid = HMAC(daily-salt | ip | ua | siteId)
                          │  2. env.WAE.writeDataPoint(event)      ← UNCHANGED (raw + backstop)
                          │  3. ctx.waitUntil(DO.fetch('/event', JSON body))  ← best-effort
                          ▼
                    SiteLive DO  (one per site, idFromName(siteId))
                          │  • RAM: per-(dim,val) pageview DELTA since last flush + dirty set
                          │  • DURABLE (ctx.storage.sql): seen(day,dim,dim_value,vid)
                          │  • per event: fan out across dimensions, bump RAM delta,
                          │    INSERT OR IGNORE into seen
                          │  • alarm (~15s after activity): FLUSH
                          ▼
                    D1  rollup_daily   (UNCHANGED schema)
                          ▲
                          │  SSR reads (unchanged)
                    DASHBOARD Worker (src/dashboard)
```

No `scheduled()`. No cron. WAE is still written on every event and is the only place raw
events live; the DO and D1 hold only aggregates.

---

## 3. Collector → DO payload

Today the collector bumps the DO with `vid`+`path` as **query-string** params
(`src/collector/index.ts:241`) — fine for a live count, insufficient for dimensional
rollup. Change it to a **JSON POST body** carrying the same enriched fields the collector
already computes for the WAE write (`WaeEvent`, `src/collector/index.ts:213`):

```jsonc
// POST https://do-internal/event
{
  "vid":        "16-hex",      // cookieless visitor id
  "isPageview": 1,             // 0 for custom events
  "path":       "/blog/x",
  "referrer":   "google.com",  // referrerHost; "" ⇒ bucketed as "(direct)"
  "utmSource":  "", "utmMedium": "", "utmCampaign": "",
  "country":    "GB",
  "device":     "mobile", "browser": "Firefox", "os": "iOS",
  "eventName":  ""             // non-empty only for custom events
}
```

> ⚠️ The existing `handleHit` reads from the query string on purpose (a comment at
> `src/collector/index.ts:240` records that an earlier JSON-body attempt was silently
> ignored and "collapsed every visitor to unknown"). The new `/event` handler **must parse
> the JSON body** (`await request.json()`). This is a deliberate change, not a regression —
> call it out in the plan so the implementer wires the body read.

Still fire-and-forget via `ctx.waitUntil(...).catch(() => {})`: the 204 stays fast and WAE
already holds the durable copy.

**One DO call per event.** `/event` **supersedes** the current `/hit`: the same call drives
*both* the existing live-visitor update + WebSocket broadcast (`vid`/`path`, unchanged
behaviour) **and** the new dimensional counting. Do not add a second DO round-trip — the
collector makes exactly one `waitUntil` DO call per event, as it does today.

---

## 4. DO state

**RAM (lost on hibernation/eviction — by design):**

- `deltas: Map<"${dimension}|${dimValue}", number>` — pageviews accumulated **since the
  last flush** (a delta, not a running total — see §6 for why).
- `dirty: Set<"${dimension}|${dimValue}">` — which counter rows changed since last flush.
- `currentDay: string` — the UTC day the RAM state belongs to (for rollover detection).

**Durable (`ctx.storage.sql`, survives hibernation):**

```sql
CREATE TABLE IF NOT EXISTS seen (
  day        TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  dim_value  TEXT NOT NULL,
  vid        TEXT NOT NULL,
  PRIMARY KEY (day, dimension, dim_value, vid)
) WITHOUT ROWID;   -- PK insert = 1 row written, not 2 (no separate autoindex)
```

`seen` is the **exact** per-`(dimension, dim_value)` distinct-visitor set. It must be durable:
a RAM-only set is wiped on every hibernation, and low-traffic sites hibernate constantly
between hits — that would re-count returning visitors and reintroduce the `visitors == pageviews`
bug we just fixed. `WITHOUT ROWID` + a daily `DROP` (not `DELETE`, §6) keep it cheap.

D1 `rollup_daily` is **unchanged** `(site_id, day, dimension, dim_value, pageviews, visitors,
sampled)`; the DO always writes `sampled = 0` (its counts are unsampled).

---

## 5. Per-event counting (dimension fan-out)

Each event fans out across the same 11 dimensions the cron used
(`ROLLUP_DIMENSIONS`, `src/rollup/index.ts`), mirroring the old query semantics exactly so
`rollup_daily` and the dashboard stay byte-compatible:

| dimension     | `dim_value` source        | pageviews metric      | skip rule                       |
|---------------|---------------------------|-----------------------|---------------------------------|
| `total`       | `""`                      | `isPageview`          | never                           |
| `page`        | `path`                    | `isPageview`          | —                               |
| `referrer`    | `referrer`, `"" → "(direct)"` | `isPageview`      | never (empty ⇒ `(direct)`)      |
| `utm_source`  | `utmSource`               | `isPageview`          | skip if empty                   |
| `utm_medium`  | `utmMedium`               | `isPageview`          | skip if empty                   |
| `utm_campaign`| `utmCampaign`             | `isPageview`          | skip if empty                   |
| `country`     | `country`                 | `isPageview`          | skip if empty                   |
| `device`      | `device`                  | `isPageview`          | skip if empty                   |
| `browser`     | `browser`                 | `isPageview`          | skip if empty                   |
| `os`          | `os`                      | `isPageview`          | skip if empty                   |
| `event`       | `eventName`               | `1` (count, not pv)   | skip if empty (pageviews have none) |

For each non-skipped `(dimension, dim_value)`:

```
deltas[key] += (dimension === 'event' ? 1 : isPageview)   // event-dim counts all events
dirty.add(key)
changed = INSERT OR IGNORE INTO seen(currentDay, dimension, dim_value, vid)   // 0 or 1 row
// visitors are NOT tracked in RAM — they are derived exactly from `seen` at flush (§6)
```

Custom events (`isPageview = 0`) still fan out across `page/referrer/country/...`,
contributing `0` to those dimensions' pageviews but registering the `vid` in `seen` — exactly
what the old `COUNT(DISTINCT vid) GROUP BY blobN` did (it counted any vid in the group,
regardless of `is_pageview`).

---

## 6. Flush, visitors derivation, and UTC rollover

**Flush is scheduled on activity, not on a fixed clock.** On the first event after a flush,
set an alarm for `now + ~15s`. 15s is comfortably under the ~70s DO eviction window, so a
flush always lands before the DO sleeps; under sustained traffic the pending alarm coalesces
to ~one flush / 15s regardless of event rate. (Tunable `var`.)

**`alarm()` flush, for each `key` in `dirty`:**

1. `visitors := SELECT COUNT(*) FROM seen WHERE day = currentDay AND dimension = ? AND dim_value = ?`
   — **absolute, exact, derived from the durable set** (so it never drifts across evictions).
2. UPSERT into D1, pageviews **additive**, visitors **absolute**:

   ```sql
   INSERT INTO rollup_daily (site_id, day, dimension, dim_value, pageviews, visitors, sampled)
   VALUES (?, ?, ?, ?, ?, ?, 0)
   ON CONFLICT(site_id, day, dimension, dim_value) DO UPDATE SET
     pageviews = rollup_daily.pageviews + excluded.pageviews,   -- add the delta
     visitors  = excluded.visitors,                              -- overwrite with exact count
     sampled   = 0;
   ```
3. Clear `deltas[key]` to 0; remove from `dirty`.

**Why delta-add for pageviews, absolute for visitors:** pageviews can only be a counter (we
don't store individual events in the DO — that's WAE's job), so RAM holds the delta since
last flush and D1 holds the authoritative running total. The only data an eviction can lose
is the un-flushed pageview delta (≤ one flush interval of events) — bounded, and recoverable
from WAE if ever needed. Visitors are recomputed from the durable `seen` set every flush, so
they are always exact and **eviction-proof**, with no RAM reload on cold start.

**UTC rollover.** When an event's UTC day ≠ `currentDay`: final-flush the old day, then
`DROP TABLE seen; CREATE TABLE seen ...` (a `DROP` deallocates pages and is **not** billed
per-row, unlike `DELETE FROM seen WHERE day < today`), clear RAM `deltas`/`dirty`, set
`currentDay` to the new day. The DO only ever holds one day of `seen` rows.

---

## 7. Cost & scale

Priced 2026-06-29, Workers **Paid** plan. The dominant term under naive per-event writes is
**DO SQLite rows-written**; the write-back design removes it.

| PV/mo | Write-through (rejected) | **Write-back (this design)** |
|-------|--------------------------|------------------------------|
| ≤1M   | ~$0                      | ~$0                          |
| 10M   | ~$91/mo                  | ~$0                          |
| 100M  | ~$1,365/mo               | **~$20–50/mo** (flat, like the cron) |

- **Exact `seen` is free to ~20M PV/mo.** With `WITHOUT ROWID` + `DROP`-based daily reset,
  `seen` writes ≈ `2.25 × PV/mo`; the 50M-rows-written/mo free tier covers ~20M PV/mo, and
  even 100M PV is only ~$175/mo for `seen`. The per-event **counter** writes are zero (RAM).
- **HLL is the documented escape hatch** (§9), needed per-site only above ~20–30M PV/mo
  (the point where either `seen` cost or the 128 MB DO-RAM working set bites). No realistic
  self-host install reaches it; the upgrade path exists so the pattern is never a trap.
- **Billing caveats to honor:** WAE write billing is currently prospective ($0 today, model
  ~$0.25/M); the exact `INSERT OR IGNORE` / UPSERT row-write counts are inferred from SQLite
  semantics (Medium confidence) — validate against real `meta.rows_written` on the parallel
  run (§9) before trusting absolute numbers. The *shape* (rows-written dominates, write-back
  removes it) is robust.

---

## 8. Salt rotation (cron removal fallout)

`rotateDailySalt` runs inside the cron we're deleting (`src/rollup/index.ts:231`). Decision:
**drop it entirely and rely on the KV TTL.** Lower the daily-salt TTL from `48h → ~25h`
(`src/shared/identity.ts:67`). The salt is keyed by UTC date and only needed for the current
day, so a ~25h TTL self-deletes it ~1h into the next day — the same ~24h
cross-day-correlation window the cron's explicit delete gave us, with zero infrastructure.
Delete `rotateDailySalt` and the Worker's `scheduled()` handler (`src/index.ts:57`).

---

## 9. Cutover, parallel-run validation, and rollback

**Clean seam, no backfill** (decided): existing `rollup_daily` rows stay frozen as the old
cron's history; the DO owns exact counts from cutover day forward.

**Validate before deleting the cron** (avoid a write conflict — both systems target the same
`rollup_daily` rows):

1. **Shadow phase.** Ship the DO counting + flush, but flush to a **`rollup_daily_shadow`**
   table while the existing cron keeps writing the real `rollup_daily`. Run both for 1–2 days.
2. **Compare.** Diff `rollup_daily_shadow` vs `rollup_daily` for the overlapping days.
   Pageviews should match closely; distinct visitors should match within a small tolerance
   (sampling on the cron side, eviction-window pageview loss on the DO side). Also capture
   real DO `meta.rows_written` here to confirm the §7 cost shape.
3. **Cut over.** Point the DO flush at the real `rollup_daily`, delete the cron trigger,
   `src/rollup/index.ts`, the `scheduled()` handler, and `rollup_daily_shadow`.

**Rollback:** if the shadow diff is bad, the cron is untouched and still authoritative — just
don't cut over. The DO change is additive until step 3.

---

## 10. Testing strategy (TDD)

Vitest + `@cloudflare/vitest-pool-workers`. Red→green per unit:

- **DO counting:** an event fans out across the dimension table (§5); `deltas` and `seen`
  update correctly; custom events add to `seen` but not to pageviews; empty `dim_value`
  skipped except referrer→`(direct)`; event-dim uses count.
- **Flush:** UPSERT writes pageviews **additively** and visitors **absolutely** from `seen`;
  two flushes accumulate pageviews but don't double-count visitors; `dirty` clears.
- **Eviction safety:** a fresh DO instance (RAM cleared, `seen` intact) flushes additively —
  visitors stay exact, pageviews don't reset.
- **UTC rollover:** crossing midnight final-flushes the old day and resets `seen` (assert a
  `DROP`, not per-row delete).
- **Collector:** `/event` POST carries the enriched JSON body; the `/event` handler parses
  the body (guard against the §3 query-string regression) and drives both live + counting in
  one call.
- **Identity:** salt TTL is ~25h; `rotateDailySalt` is gone; no `scheduled()` export.

---

## 11. Out of scope / documented escape hatches (not built now)

- **HyperLogLog `seen`** for >20–30M PV/mo single sites (§7) — replaces the exact per-vid set
  with a fixed-size sketch (±2%). Document the threshold; implement when a site approaches it.
- **Live current-day read straight from the DO** — the dashboard is already fresh within the
  flush interval via D1, so a direct DO read is deferred.
- **WAE-replay reconciliation on cold start** — the bounded ≤15s pageview-delta loss is
  acceptable; a WAE replay to recover it is a future option, not MVP.
- **ADR-0010** recording this supersession of ADR-0003 — write when it ships.

---

## 12. Files touched (for the plan)

| File | Change |
|------|--------|
| `src/dashboard/site-live.ts` | Add durable `seen` table, dimension fan-out, flush alarm, UTC rollover. Replace `/hit` with `/event` (parses JSON body; drives both live-visitor update + WS broadcast **and** counting in one call). Keep the existing live-visitor RAM map + WS behaviour. |
| `src/collector/index.ts` | Forward the enriched event as a JSON POST body to the DO (replace the `vid`+`path` query-string hit). |
| `src/shared/identity.ts` | Lower salt TTL 48h→~25h; delete `rotateDailySalt`. |
| `src/index.ts` | Delete the `scheduled()` handler. |
| `src/rollup/index.ts` | Deleted at cutover (step 9.3). |
| `migrations/` | Add `rollup_daily_shadow` for the parallel run (dropped at cutover). |
| `wrangler.jsonc` | Remove the cron `triggers`. |
| tests | New DO/collector/identity tests (§10); delete `test/rollup.test.ts` at cutover. |

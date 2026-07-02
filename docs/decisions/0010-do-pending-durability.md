# 0010 — Durable pending-counter state in the SiteLive DO

- **Date:** 2026-07-01
- **Status:** accepted
- **Owner:** cloudflare-tech-lead
- **Relates to:** spec `docs/specs/2026-06-29-do-incremental-counters-design.md` (amends the
  §0 / §7 / plan "never write the per-event counter to durable storage" guardrail), plan
  `docs/plans/2026-06-29-do-incremental-counters.md`. Touches ADR-0004 (the `SiteLive` DO).
  **Numbering note:** the plan penciled `0010` for the *Phase-2 cutover* supersession of
  ADR-0003. This durability fix is a separate, earlier decision and takes `0010`; the
  Phase-2 cutover ADR should be written as **0011** when it ships.
- **Evidence base:** Cloudflare DO lifecycle, storage, and pricing docs retrieved
  **2026-07-01** (URLs inline in each claim).

## Context

Phase 1 of the event-driven rollup ran the new `SiteLive` DO counters (writing
`rollup_daily_shadow`) in parallel with the authoritative 5-minute WAE-polling cron
(`rollup_daily`). The parity check on 2 days of organic traffic (settled UTC day
2026-06-30, `dimension='total'`) **failed badly on pageviews**:

| site | cron pv / visitors | DO shadow pv / visitors | DO pv capture |
|------|--------------------|--------------------------|---------------|
| sort-algorithms | 26 / 4 | **6** / 4 | 23% |
| jasonmatthew-dev | 15 / 3 | **7** / 2 | 47% |
| public-holiday | 1 / … | **0 rows** | 0% |
| skopia-www | 2 / … | **0 rows** | 0% |
| ss-ledger | 1 / … | **0 rows** | 0% |

Only 3 of 11 sites reached the shadow table at all; where they did, pageviews were a
fraction of the truth while **visitors roughly matched** (exact for sort-algorithms,
off-by-one for jasonmatthew-dev).

### Root cause (validated against the code and current CF docs)

The signature — visitors ~right, pageviews badly low, some sites entirely absent — is the
fingerprint of a **durability asymmetry between the two DO data structures**:

- `seen` (distinct-visitor set) is **durable SQLite**, written per event
  (`site-live.ts` `recordEvent`, `INSERT OR IGNORE`). It survives sleep.
- `pending` (per-`(dimension,dim_value)` pageview deltas) is a **RAM-only `Map`**
  (`site-live.ts:59`), persisted to D1 **only when the alarm fires** (`flush()`,
  `ALARM_INTERVAL_MS = 15_000`). `flush()` early-returns when `pending.size === 0`. `siteId`
  and `currentDay` — also required by `flush()` — are **RAM-only** too.

The spec assumed "15s is comfortably under the ~70s DO eviction window, so a flush always
lands before the DO sleeps." **That is the flaw.** Current CF docs make the SiteLive DO
*hibernateable*, and hibernateable DOs sleep in **10 seconds**, not 70:

- The 70–140s window applies **only** to the *idle, in-memory **non-hibernateable*** state.
  The *idle, in-memory **hibernateable*** state is hibernated "after **10 seconds** of
  inactivity."
  ([DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
  retrieved 2026-07-01)
- A DO is hibernateable when it holds no `setTimeout`/`setInterval`, no in-progress `fetch()`,
  no *standard* WebSocket, no in-flight request, and no outbound TCP/WebSocket. **A set DO
  alarm is not one of these blockers** — an armed alarm does *not* keep the DO in memory.
  SiteLive uses the WebSocket **Hibernation API** (`acceptWebSocket`, per ADR-0004) and holds
  none of the blockers, so after each event it is hibernateable and sleeps at 10s. (same doc)
- "When hibernated, the in-memory state is discarded." (same doc); "In-memory state is not
  preserved if the Durable Object is evicted from memory … Always persist important state to
  storage."
  ([In-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)).
  Code deployments also restart DOs and discard in-memory state
  ([Access storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)) —
  relevant during active development, where frequent deploys clip `pending` mid-window.

**Mechanism:** `10s (hibernation) < 15s (flush alarm)`. After an isolated event, the DO
discards `pending` at 10s; the alarm fires at 15s, the runtime cold-starts a fresh instance
(constructor runs, `pending` empty, `siteId`/`currentDay` null), and `flush()` early-returns
— the pageview delta is gone forever. Only *bursts* whose events arrive <10s apart keep the
DO warm long enough for the alarm to win, which is exactly the observed 23–47% partial
capture (bursts land, isolated hits vanish) and the 8 all-zero sites (never a dense-enough
burst to survive to a flush). WAE still holds every raw event, so nothing is lost upstream —
only the DO→D1 aggregate is wrong.

**Why visitors look right but aren't quite:** `seen` is durable and cumulative, so once *any*
flush fires late enough, `countSeen` writes the full distinct set (→ visitors exact, e.g.
sort-algorithms 4/4). The off-by-one (jasonmatthew-dev 2 vs 3) is the **stranded-`seen`**
corollary: a visitor whose events were the last of the day sits durably in `seen`, but no
later flush ever ran to copy that count into D1 — **because the lost `pending` was the flush
trigger.** Visitors are only as fresh as the last surviving flush.

The hypothesis in the task is therefore **confirmed and sharpened**: the trigger is
Hibernation-API 10s sleep (not a generic 70s eviction), and the fix must make *both* the
pageview deltas *and* the flush trigger durable.

## Decision

**Persist the whole flush state — `{ siteId, currentDay, pending }` — as a single durable
key, rewritten once per event, and reload it in the constructor via
`blockConcurrencyWhile()`.** `pending` stays a RAM `Map` as the working copy; every
`recordEvent` mutates RAM and then writes the serialized state with **one**
`ctx.storage.put("flushstate", …)`. On cold start (hibernation, eviction, deploy, host
move) the constructor rehydrates `pending`/`siteId`/`currentDay` from storage before any
request or alarm runs, so `flush()` on a cold-started alarm sees the real deltas and the
required IDs, and always writes.

This is **one durable row-write per event regardless of dimension count** — the minimum
that survives arbitrary hibernation (which is unannounced, so state must be durable by the
end of *every* event handler). It revises the spec's guardrail from "never write the
per-event counter to durable storage" to the correct, cost-aware rule:

> **Never write a *per-dimension* counter per event (that is the ~8–11× amplification the
> cost model rejects). Exactly *one* fixed durable write per event — the serialized pending
> blob — is required for correctness and is affordable.**

`seen` semantics, the flush UPSERT (additive pageviews, absolute visitors), the 15s
activity-armed alarm, and the daily `DROP TABLE seen` rollover are all **unchanged**.

## Alternatives considered

Requirement: pageview deltas and the flush trigger must survive hibernation, without the
per-event write amplification the cost model forbids. Reference point: ~20M events/mo (spec
§7). DO SQLite storage on Workers Paid = **50M rows written/mo included, then $1.00/M**;
`put()` is billed as rows written in a hidden SQLite table; `setAlarm()` = 1 row written
([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
retrieved 2026-07-01).

**A. Durable per-`(day,dimension,dim_value)` counter table, UPSERT per event
(write-through).** Correct and durable. But each event fans out to ~7–11 dimensions, each a
row write: ~8 × 20M = **~160M rows/mo** for counters, **plus** the existing ~45M for `seen`
= ~205M/mo → billable (205M − 50M) × $1 = **~$155/mo** at 20M events. ~10× the recommended
option, and ~$1,000+/mo at 100M — this *is* the amplification the spec rejected. Rejected on
cost.

**B. Single serialized `pending` blob, rewritten per event (chosen).** One `put`/event
regardless of dimension count. Durable, so hibernation/deploy/eviction are all survivable;
reload via `blockConcurrencyWhile`. Cost delta is +1 write/event (see Consequences). Best
correctness-per-dollar. **Chosen.**

**C. Shorten the alarm below the 10s hibernation window (e.g. 5s), keep `pending` in RAM.**
Reduces the loss rate but **does not make pageviews durable** and is explicitly a non-fix:
(1) the 10s hibernation is "up to the runtime … currently 10 seconds" — an undocumented-
stability constant, not a contract; (2) **code deployments and runtime updates restart DOs
at any time**, discarding `pending` regardless of alarm cadence — decisive during active
development, which is where this failure surfaced; (3) alarm delivery can be delayed under
load, landing after hibernation; (4) it raises `setAlarm`/flush write and D1-write frequency
for a fix that remains probabilistic. Timing is not durability. Rejected.

**D. HyperLogLog / cardinality sketch for `seen` (spec §11).** Orthogonal — it addresses
`seen` write/RAM cost above ~20–30M PV/mo, not the `pending` durability bug. Out of scope
here; remains the documented escape hatch.

| axis | A (per-dim write-through) | **B (blob, chosen)** | C (shorter alarm) |
|------|---------------------------|----------------------|-------------------|
| Fixes pageview loss | ✅ | ✅ | ⚠️ reduces only |
| Survives deploy/host-move | ✅ | ✅ | ❌ |
| DO rows written / event | ~8–11 | **+1** | 0 (unchanged) |
| Added $/mo @ 20M events | ~$155 | **~$15** | $0 (but unfixed) |
| Complexity | new table + fan-out writes | 1 put + constructor reload | trivial |
| Lock-in | none | none | none |

## Consequences

**What it fixes.** Pageviews become durable to a bounded window (≤ the un-persisted work of a
single in-flight event, essentially zero since the `put` completes within the handler).
Every site with even one pageview writes to the shadow (the cold-started alarm reloads
`pending` and flushes) — the 8 all-zero sites and the 23–47% under-counts both resolve.
**Visitors flush reliably**: with the trigger durable, the alarm always runs while `pending`
is non-empty, so the stranded-`seen` off-by-one (the last events of a day now reach D1) is
fixed too. `recordEvent` writes `pending` (incl. delta-0 keys for custom-event visitors) and
`seen` in the same handler, so visitor and pageview state always flush together.

**Cost delta (Medium confidence; validate on the parallel run).** Using the spec's ~2.25×
`seen`-writes-per-event factor:

| | rows written / mo @ 20M events | billable (−50M free) | $/mo |
|---|---|---|---|
| Before (seen only) | ~45M | 0 | **$0** (within free tier) |
| After (seen + 1 blob/event) | ~65M | ~15M | **~$15** |
| Rejected Option A | ~205M | ~155M | ~$155 |

So the fix moves DO storage from $0 (free tier) to **~$15/mo at 20M events/mo** — flat,
within the system's ~$20–50/mo envelope, and ~10× cheaper than write-through. At 100M
events it is ~$275/mo (vs ~$175 for `seen` alone); no self-host install approaches that. The
`seen` 2.25× factor and the "1 row-write per `put`" assumption are inferred from SQLite
semantics — **capture real `meta.rows_written` on the re-run** before trusting absolute
numbers (the *shape* — +~1 write/event, small absolute $ — is robust). `put` value size is
bounded by the ~15s flush interval keeping `pending` small; a high-cardinality burst that
grows the blob is a minor watch item (mitigate by flushing more often or chunking), not a
self-host concern.

**Spec amendment.** The §0 / §7 / plan Global-Constraints line "never write the per-event
counter to durable storage" is **superseded by this ADR's revised guardrail** (one fixed
blob write/event is required; only *per-dimension* per-event writes are forbidden). Update
the spec to reference this ADR.

**Test-gap owned.** The Phase-1 unit tests missed this because "eviction safety" was
simulated by re-recording events and calling `flush()` on a warm instance — it never
exercised *"the alarm fires on a cold instance whose only surviving state is durable."* The
new tests must: (1) after `recordEvent`, assert the durable `flushstate` key contains the
deltas; (2) construct/rehydrate a fresh instance with **no** RAM `pending` and **without**
re-recording, then run the alarm, and assert the shadow row has the correct pageviews *and*
visitors. This is the scenario the parity check caught and the suite didn't.

**Watch.** At-least-once flush semantics are unchanged: a crash in the sub-millisecond window
between the D1 `batch()` resolving and clearing `pending` could double-count that flush's
pageviews on retry. The window is tiny, no worse than today, and WAE is the reconciliation
backstop — noted, not blocking.

## Implementation sketch (for the plan, not built here)

`src/dashboard/site-live.ts` only; **no D1 migration** (the blob lives in the DO's own
storage; `rollup_daily_shadow` is unchanged).

1. **Constructor** — after `SEEN_DDL`, rehydrate:
   ```ts
   ctx.blockConcurrencyWhile(async () => {
     const s = await ctx.storage.get<FlushState>("flushstate");
     if (s) { this.siteId = s.siteId; this.currentDay = s.currentDay; this.pending = s.pending; }
   });
   ```
   `blockConcurrencyWhile` gates all requests/alarms until reload completes (documented
   init pattern,
   [In-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)).
   `structuredClone` (used by `storage.put/get`) round-trips a `Map`, so `pending` persists
   directly.
2. **`recordEvent`** — after mutating RAM `pending`/`seen`, `await this.persistPending()`
   where `persistPending()` = `ctx.storage.put("flushstate", { siteId, currentDay, pending })`.
   One durable write per event. (Off the visitor's critical path — the collector calls the
   DO via `ctx.waitUntil`, so the 204 does not wait on it.)
3. **`flush`** — unchanged UPSERT; on success, after `this.pending.clear()`, also persist the
   cleared state (`put` empty or `storage.delete("flushstate")`) so a post-flush cold start
   doesn't re-flush stale deltas.
4. **`maybeRollover`** — after the existing flush + `DROP/CREATE seen` + `pending.clear()`,
   persist the reset state so the new `currentDay` is durable.
5. **Robustness** — in the constructor reload, if `pending.size > 0` and `getAlarm()` is
   null, arm an alarm so a rehydrated-but-alarmless instance still flushes.
6. **Tests** — add the cold-instance/durable-only flush test described above; keep the
   existing warm-path tests.

Numbers current as of 2026-07-01; re-check limits/prices before relying on absolute figures.

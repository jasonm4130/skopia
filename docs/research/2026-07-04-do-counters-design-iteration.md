# Skopia — DO Incremental-Counters Design Iteration (pre-Phase-2)

- **Date:** 2026-07-04
- **Author:** `cloudflare-tech-lead` agent
- **Status:** **Research — recommendations, not decisions.** The human decides. Commissioned
  before the Phase-2 cutover in light of fresh empirical DO rows-written data.
- **Scope:** three questions — (1) cut the measured ~7.1 DO rows-written/pageview,
  (2) the honest publishable Workers-Free pageview ceiling (roadmap O5), (3) re-validate the
  DO-counter design + scrutinise the Phase-2 cutover for transition hazards.
- **Inputs:** the actual code (`src/dashboard/site-live.ts`, `src/rollup/index.ts`,
  `src/collector/index.ts`, `src/shared/identity.ts`, `wrangler.jsonc`); the cutover plan
  (`docs/plans/2026-06-29-do-incremental-counters.md` §"Phase 2"); ADR-0010; the roadmap
  (`docs/specs/2026-07-03-feature-roadmap.md` O5, C3); the feasibility sweep
  (`docs/research/2026-07-03-tech-state-and-feasibility.md` §3).
- **Every number below is tagged `[MEASURED]` (from the 2026-07-04 Cloudflare GraphQL /
  observability sample, gate day 2026-07-03) or `[DOCS]` (from a cited Cloudflare doc,
  retrieved 2026-07-04) or `[MODEL]` (arithmetic on those).** Citations in §Sources.

---

## TL;DR

1. **The task's believed write composition is confirmed but incomplete.** `setAlarm()` **is**
   a billed row-write and the flushstate `put()` **is** a billed row-write `[DOCS]`. But the
   dominant *removable* term is neither: it is the **`setAlarm()` reschedule loop that trails
   every live-visitor session for up to 5 minutes**, because the single 15 s alarm serves
   *double duty* (flush **and** live-visitor eviction) and re-arms while `visitors.size > 0`
   even when there is nothing left to flush. `seen` inserts are the largest *necessary* term.
2. **Top write-reduction recommendation:** **decouple live-visitor eviction from the flush
   alarm** — evict lazily when computing the snapshot, drive liveness refresh from the client
   WebSocket `ping`, and arm/reschedule the alarm **only while `pending.size > 0`**. Small,
   surgical, **does not regress ADR-0010** (flushstate stays per-event durable). Expected: the
   measured ~7.1× drops to roughly **~5×** at the sampled low-traffic/high-unique profile and
   the fixed per-visitor waste that hurts the many-small-sites self-host case disappears; the
   at-scale multiplier that governs the free-tier ceiling stays ~3.25×.
3. **Publishable free-tier number (O5):** there is **no single clean number** — the multiplier
   is traffic-shape dependent (≈ 2.25×–7×). Honest, defensible figure to publish: **~500k
   pageviews/month on Workers Free** (safe for one-off-visitor-heavy traffic), **up to ~0.9M**
   for typical returning/multi-page traffic. The binding limit is **DO rows-written (100k/day)**
   `[DOCS]`, not WAE. Do not publish a flat 0.9M as a floor.
4. **Design verdict:** DO-counter approach **remains correct** — no alternative (pure WAE,
   D1-direct per event, Queues) is now clearly better. The cutover plan is **sound but needs
   3 concrete amendments** to be safe: (a) **do not drop the shadow table in the cutover PR**
   (split it out so rollback stays clean); (b) **the flip + cron-delete must be one atomic
   deploy** (a partial deploy lets the absolute-overwrite cron clobber the DO's additive
   adds); (c) **accept or reconcile a bounded ≤1-flush-interval pageview discrepancy on the
   transition day** and **avoid cutting over in the first ~5 min after UTC midnight** (the
   DO's cross-midnight rollover flush would additively land on a cron-settled prior day).

---

## 0. What the code actually does (the billed write surface)

Per event, the collector forwards an enriched `CountEvent` to `SiteLive` over
`ctx.waitUntil(fetch(...))` (best-effort; WAE holds the durable copy). Inside the DO, one
event produces these **DO SQLite** writes (D1 `batch()` in `flush()` writes to D1, a *separate*
database — not counted in the DO rows-written figure):

`handleEvent` → `recordEvent` (`src/dashboard/site-live.ts:126-197`):
- **`seen` inserts** — `INSERT OR IGNORE INTO seen (day,dimension,dim_value,vid)` once per
  dimension contribution (`eventDimensions` fans a pageview to ~7 dims: total, page, referrer,
  country, device, browser, os). `seen` is `WITHOUT ROWID` with a PK and **no secondary
  index**, so each *new* row = **1 row written**; a returning `(day,dim,value,vid)` combo
  changes nothing = **0 rows written** `[DOCS: SQL rows-written = rows changed + index
  updates]`.
- **`persistPending()` `put("flushstate", …)`** — **1 row written per event** `[DOCS: KV put
  billed as rows written]`, independent of dimension count (the whole `pending` map is one
  blob; ADR-0010's design).

`handleEvent` alarm arming (`:141-144`):
- `getAlarm()` — a **row read** (cheap; get-family) `[DOCS]`. `setAlarm()` **only if none is
  pending** — so this is **already guarded** (candidate (a) is already implemented here).

`alarm()` (`:305-322`):
- `flush()` on success → `ctx.storage.delete("flushstate")` = **1 row written per flush that
  had pending** `[DOCS: KV delete billed as rows written]`.
- **`setAlarm()` reschedule** whenever `this.visitors.size > 0 || this.pending.size > 0` =
  **1 row written per tick while active** `[DOCS: each setAlarm() = 1 row written]`.

`maybeRollover` once/UTC-day: `DROP TABLE seen` + `CREATE TABLE seen` — negligible.

### The composition the task hypothesised, verified

> "1 flushstate blob put + 1 setAlarm (each = 1 billed row write) + seen inserts"

- **flushstate put = 1 row written:** **confirmed** `[DOCS]`. At self-host scale the blob is
  small (only ~15 s of un-flushed dimension deltas), so it is ~1 row; corroborated by the
  measurement fitting ≈ 1 put/event (§1). *Nuance:* the SQLite-backed KV `put` value→rows rule
  is not cleanly documented for large values (there is conflicting legacy "4 KB write-unit"
  language that applies to the **KV-backed** DO product, not SQLite-backed rows). For Skopia's
  small blob this is a non-issue; a pathological high-cardinality burst that grows the blob
  remains ADR-0010's flagged watch item. **MEDIUM confidence the put is ~1 row at target
  scale.**
- **setAlarm = 1 row written:** **confirmed** `[DOCS]` — but the hypothesis's implicit "1 per
  event" is **wrong**. `handleEvent`'s `setAlarm` is guarded by `getAlarm()===null`, so it is
  ~1 *per burst*, not per event. The real `setAlarm` volume comes from the **`alarm()`
  reschedule loop**, which is driven by `visitors.size`, i.e. by wall-clock live time, **not**
  by event count (see below).
- **seen inserts amortise with repeat visitors:** **confirmed** — and this is the *largest*
  term, but it is *necessary* (exact per-dimension visitor counts).

### The term the hypothesis missed: the eviction-coupled `setAlarm` loop

`VISITOR_TTL_MS = 5 min` (`:17`), `ALARM_INTERVAL_MS = 15 s` (`:20`). A visitor stays in the
live RAM map for 5 minutes after its last event, and `alarm()` re-arms every 15 s while any
visitor is present. So **a single visitor session drags up to `5 min / 15 s = ~20`
`setAlarm()` writes** *after its last event* — pure liveness bookkeeping, zero to do with
counting, and **independent of event volume**. `currentSnapshot()` (`:333-352`) does **not**
evict; only the alarm evicts — which is precisely why the alarm must keep firing.

This is the smoking gun for the low-traffic 7.1×: at 14 pageviews the counting writes are tiny,
but a handful of visitor sessions each trail ~20 `setAlarm` writes.

---

## 1. Question 1 — cutting the ~7.1 rows/pageview

`[MEASURED]` 99 DO rows written for 14 pageviews on the gate day = **7.1 rows/pageview**.

### Decomposition (code-grounded; the split is `[MODEL]`, the total is `[MEASURED]`)

A plausible decomposition of the 99 for a low-traffic day of ~7 visitors × ~2 pages:

| Term | Rows | Removable? | Note |
|---|---:|---|---|
| `seen` inserts (~6 shared dims × new visitors + page dim) | ~55 | **No** (necessary) | exact per-dimension visitors; amortises with repeats |
| `flushstate` `put` (1/event) | ~14 | **No** (ADR-0010 minimum) | already the write-optimal choice |
| `setAlarm` reschedule loop (visitor tails) | ~25 | **YES** | event-independent liveness waste |
| `flushstate` `delete` on flush | ~5 | Partly | 1/flush; shrinks with a longer flush interval |

The exact split is not separately observable in the GraphQL aggregate, but the *mechanism* is
certain from the code. The gap between the measured **7.1×** and the seen+put floor of **~3.25×**
`[MODEL, from the roadmap's 2.25× seen factor + 1 put]` is the `setAlarm`/`delete` overhead,
which is **event-count-independent** and therefore blows up at low volumes.

**Important framing:** the `seen` multiplier is *traffic-shape dependent*, not a constant:
- **One-off single-page visitors** (campaign/viral): each fresh `vid` writes ~7 `seen` rows for
  1 pageview → seen ≈ **6–7×**.
- **Returning, multi-page visitors** (blog/SMB): the ~7 fixed dims amortise over many pageviews
  → seen ≈ **1.5–2.5×**.
So the *whole-system* multiplier ranges ≈ **2.25× → 7×** by audience mix. The 7.1× sample is the
unique-heavy end **plus** the removable alarm loop.

### Candidate evaluation

**(a) Skip `setAlarm` when an alarm is already pending (getAlarm read instead of set).**
- **Already implemented** in `handleEvent` (`:141-144`) — `getAlarm()` (read, ~free) guards
  `setAlarm()`. `getAlarm` is a **row read** (5M/day free) vs `setAlarm` a **row write** (100k/day
  free), so the guard genuinely saves a write when an alarm is pending `[DOCS]`. **No further
  win available in `handleEvent`.** The residual `setAlarm` cost lives in `alarm()`'s reschedule,
  which *cannot* be guarded the same way (a fired alarm is already consumed → `getAlarm()`
  returns null → a fresh `setAlarm` is genuinely needed to keep ticking). The fix there is to
  **stop ticking when there is nothing to flush** — see (d).
- **Verdict: nothing to change (a) is done; the lever is (d).**

**(b) Store pending deltas as SQLite rows via additive UPSERT instead of one blob put.**
- A pageview fans to ~7 dimensions → **7 UPSERTs = 7 rows written per event** vs the blob's
  **1** `[DOCS: KV put = 1 row; SQL insert/update = 1 row each]`. This is **strictly worse on
  the write path** (7× vs 1×). On flush it is also worse (a `SELECT` over the pending table =
  more rows read than one `get`). **This is exactly Option A that ADR-0010 rejected on cost.**
- **Verdict: reject.** The single blob is already the write-optimal durability primitive.
  ADR-0010's choice is re-confirmed by fresh docs.

**(c) Persist flushstate only every N events (bounded loss).**
- Saves `(N-1)/N` of the `put` writes, but **re-introduces the ADR-0010 bug precisely where it
  hurts most**: at low traffic, events are >10 s apart, so the DO *hibernates between events*
  (10 s hibernation `[DOCS: DO lifecycle]`); persisting every N>1 events means each event's
  delta is discarded before the next arrives → near-total loss — the original 23–47% capture
  failure. At high traffic (bursts <10 s apart) it could batch safely, but the loss bound is
  traffic-dependent and the `put` is only ~14% of the write budget anyway.
- **Verdict: reject** for the target (low-traffic) case; low upside, high risk, ADR-0010
  regression.

**(d) [RECOMMENDED] Decouple live-visitor eviction from the flush alarm.**
- **Change:** (i) evict stale visitors *lazily* inside `currentSnapshot()` (filter by
  `lastSeen ≥ now − VISITOR_TTL_MS` before counting) instead of in the alarm; (ii) arm/reschedule
  the alarm **only when `pending.size > 0`**; (iii) let the dashboard client drive liveness
  refresh via the existing WebSocket `ping` (`webSocketMessage`, `:270-275`) on a client-side
  interval (a WS message costs **no DO storage write**). Verify the client already pings; if
  not, add a `setInterval(ws.send("ping"), ~15s)` client-side.
- **Billed-write delta:** removes the ~20 `setAlarm` writes per visitor tail entirely. At the
  sampled profile that is ~25 of 99 rows → **7.1× → ~5×**. The many-small-sites self-host
  profile (several low-traffic DOs each trailing tails) benefits most.
- **Durability:** **no ADR-0010 regression.** `flushstate` is still persisted per event; the
  constructor still rehydrates and arms an alarm if `pending.size > 0` on cold start
  (`:96-103`). Flushes still fire ~15 s after events (a new event re-arms via `handleEvent`),
  and an armed alarm still wakes a hibernating DO to flush. The only behaviour removed is
  *ticking with an empty `pending` just to evict RAM visitors* — which liveness no longer needs
  because eviction is lazy and refresh is client-driven.
- **Implementation cost:** **S** (small). Touches `alarm()` (drop the `visitors.size > 0`
  reschedule predicate → reschedule only on `pending.size > 0`), `currentSnapshot()` (add the
  lazy `lastSeen` filter), and a one-line client ping interval. TDD-able against existing
  `site-live.test.ts` alarm tests.

**(d′) [OPTIONAL, stacks with (d)] Lengthen the flush interval 15 s → 30–60 s.**
- Halves/quarters the per-flush `setAlarm` + `delete` overhead (the fixed at-scale term).
  Cost: `rollup_daily` freshness lags real-time by up to the interval. The **live count is
  unaffected** (separate in-memory path + WS). For self-host analytics, 30–60 s rollup freshness
  is acceptable. **S**, one constant.

**(e) [BIGGER LEVER, but a product tradeoff — not a free win] Reduce `seen` fan-out.**
- `seen` (the dominant *necessary* term, ~55% of writes) is only reducible by writing fewer
  distinct-visitor rows: (i) track `seen` for a *subset* of dimensions (e.g. total + page +
  referrer + country) and report pageviews-only (or approximate) visitor counts for
  device/browser/os → cuts seen ~40%; or (ii) an HLL/cardinality sketch (ADR-0010 alt D) →
  approximate visitor counts, more complex. **Both change the product's accuracy guarantees
  (exact per-dimension visitors) → PM decision, not a tech-only optimisation.** Flag to PM as
  the only lever that materially moves the free-tier ceiling.

**Recommendation:** ship **(d)** now (surgical, no accuracy cost, no ADR-0010 regression);
consider **(d′)** as a cheap stack. Do **not** do (b) or (c). Treat **(e)** as a PM-gated
accuracy/cost tradeoff only if the free-tier ceiling must rise.

---

## 2. Question 2 — the honest free-tier ceiling (roadmap O5)

**Binding limit** `[DOCS]`: Workers Free **DO rows-written = 100,000/day**. (DO requests
100k/day → binds at ~100k events/day, higher; WAE 100k data-points/day ~3M/mo, higher; D1
100k writes/day but post-cutover D1 is ~150 writes/day `[MEASURED-derived]`, a non-factor.) So
**DO rows-written is the tightest free-tier constraint** — confirming the feasibility sweep §3.2.

**The multiplier is not a constant**, so neither is the ceiling. Rows/day ≈
`(seen + 1 put)·events + fixed alarm/flush overhead`:

| Traffic shape | Effective ×/event | Fixed overhead/day | Free ceiling (events/day) | ≈ /month |
|---|---:|---:|---:|---:|
| Returning, multi-page (blog/SMB) | ~3.25 | ~8–11k (15 s ticks) | ~27k | **~0.8–0.9M** |
| Mixed | ~4–5 | ~5–10k | ~18–22k | **~0.55–0.66M** |
| One-off single-page (campaign/viral) | ~6–7 | small | ~14–16k | **~0.43–0.5M** |

`[MODEL]`, using the DO 100k/day cap `[DOCS]` and the seen-factor range `[MODEL, from roadmap
2.25× + the fan-out analysis in §1]`. The measured 7.1× at 14 pv is the low-volume/unique-heavy
corner and does **not** lower the *ceiling* number, because the fixed alarm overhead amortises
toward zero as event volume rises to where the cap actually binds — the ceiling is set by the
*at-scale* multiplier (~3.25×) plus the continuous 15 s tick overhead.

**Effect of the recommended fixes on the ceiling:** the decouple fix (d) mostly helps *low*
traffic and the many-small-sites case; at the single-busy-site ceiling it trims the fixed
overhead modestly (idle-with-visitors periods vanish), and (d′) trims it further. Net: the
busy-site ceiling nudges from ~0.8M toward ~0.9M/month. **To move it materially you must reduce
`seen` (option (e)) — an accuracy tradeoff.**

### The number to publish

> **Workers Free comfortably covers ~500,000 pageviews/month** (safe across all traffic
> shapes, including one-off-visitor-heavy campaigns). Typical returning/multi-page sites reach
> **~0.8–0.9M/month**. Beyond that, Workers Paid handles **~15M events/month within the included
> 50M DO rows-written**, and the design stays **~$5/mo at 10M events** `[MODEL, DOCS: Paid 50M
> rows + $1.00/M]`.

Rationale: the thesis is "accuracy you can stand behind," so publish the **conservative floor**
(~500k), not the optimistic 0.9M the roadmap penciled. This resolves O5 honestly: **the ~0.9M
figure is real only for repeat-visitor traffic; ~500k is the honest floor.** Update roadmap C3
to the range framing rather than a single number.

---

## 3. Question 3 — is the DO design still right, and is the cutover sound?

### 3a. Re-validate DO-counters vs alternatives (in light of the measurements)

| Approach | Verdict now | Why |
|---|---|---|
| **DO incremental counters (current)** | **Correct — keep** | Exact (unsampled) daily aggregates, per-site sharding, real-time live count, fast D1 dashboard reads. The 7.1× is a *tuning* issue (§1), not an architecture flaw. |
| **Pure WAE + on-demand query** | Worse | Re-introduces adaptive sampling (accuracy loss on hot sites), loses exact visitor counts, adds per-load WAE SQL latency + the 10k-queries/day free cap `[DOCS]`. This is what ADR-0003's cron already moved *away* from. |
| **D1-direct per-event UPSERT** | Worse | ~7 D1 rows-written/event fan-out → 100k/day D1 cap binds at ~14k events/day (tighter than DO), single unsharded DB contention, no live-count coordination. Strictly dominated. |
| **Queues batching** | Not now (scale-out option) | Buffers ingestion but still needs a stateful per-site distinct-visitor store (i.e. a DO or D1) — Queues *complement*, not replace, the aggregation state, and cost 3 ops/msg + a new primitive. Over-engineered for the self-host case; revisit only if collector→DO fan-in becomes a bottleneck. |

**The DO design remains correct.** The measurements argue for *tuning* (decouple the alarm),
not *replacement*.

### 3b. Cutover-plan scrutiny (the transition hazards)

Confirmed from code: **the cron writes `rollup_daily` with ABSOLUTE semantics** — it recomputes
the full day from WAE and `SET pageviews = excluded.pageviews` (`src/rollup/index.ts:252-257`),
for today + the 2 prior days each pass. **The DO flush is ADDITIVE for pageviews, ABSOLUTE for
visitors** (`src/dashboard/site-live.ts:34-42`). This asymmetry is the source of every
transition hazard.

**Hazard 1 — non-atomic deploy lets the cron clobber the DO.** If Step 1 (flip `FLUSH_TABLE`
→ `rollup_daily`) ships but Step 3 (delete cron) does **not**, both write `rollup_daily`: every
5 min the cron's **absolute** recompute *overwrites* the DO's additive adds (for today + 2 prior
days). The DO's contributions vanish each cron pass. **Amendment: the flip and the cron-delete
MUST be in the same atomic deploy** (the plan says "one PR" — make the atomicity a hard
requirement, and note *why*: absolute-overwrite vs additive).

**Hazard 2 — the transition-day pageview boundary (bounded gap, not a double-count).** At the
cutover deploy, `rollup_daily[today]` already holds the cron's absolute count
(midnight→last-cron-run). The DO then adds only its `pending` (deltas since its last *shadow*
flush, ~15 s) and every subsequent event's delta. Events in the window **[last-cron-run →
last-shadow-flush]** were flushed by the DO to the *shadow* table (now abandoned) and never
reached `rollup_daily`; the cron will not run again → **pageviews undercount for the
transition day by up to one cron interval (~5 min) of traffic** (~0–2 pageviews at self-host
scale). **Visitors self-heal**: the DO writes visitors *absolute* from its full-day `seen` set
on the first post-cutover flush, overwriting the cron's value. No double-count arises from
`pending` (it holds only un-flushed deltas). Options:
  - **(A) Accept it** — bounded, one day, visitors correct. Document as a "history note" (ties
    to roadmap O7). **Recommended for self-host.**
  - **(B) Reconcile for exactness** — immediately post-deploy, one-shot copy
    `rollup_daily_shadow[today] → rollup_daily[today]` (absolute overwrite of pageviews +
    visitors) *before* dropping the shadow, restoring the additive invariant so the DO's next
    flush continues the sum correctly. Carries a ~15 s race (a DO flush landing between deploy
    and copy could be overwritten) — acceptable given the magnitude.

**Hazard 3 — cross-midnight rollover flush onto a settled prior day.** If the cutover deploys
in the first minutes after 00:00 UTC, the DO may still hold *previous-day* `pending` (it rolls
over only on the first event of the new day, `maybeRollover` `:240-247`). That rollover flush
is **additive** onto `rollup_daily[previous-day]`, which the cron already finalised as
**absolute** → **overcounts the settled prior day** by the DO's residual pending. **Amendment:
do not cut over within ~5 min after UTC midnight** (any other low-traffic hour is fine, and
avoids Hazard 2's magnitude too).

**Hazard 4 — no rollback story, and Step 4 destroys it.** The plan's Step 4 drops the shadow
table *in the cutover PR*. If the cutover misbehaves, rollback = redeploy the prior Worker
version (cron returns, DO writes shadow) — but if the shadow table is already dropped, the
rolled-back DO's flushes fail silently (caught at `:221`) and the reconciliation source is gone.
**Amendment: split Step 4 (drop shadow) into a SEPARATE follow-up PR**, run ≥1 settled day
*after* the cutover once parity on `rollup_daily` is re-confirmed. Keep the shadow as both the
clean-rollback path and the reconciliation source (Hazard 2B). Likewise, **don't hard-delete
`src/rollup/index.ts` in the same PR** — keep it (or a manual recompute script) until the
shadow-drop PR, since WAE (90-day retention) + the cron logic is the emergency reconciliation
backstop for the transition day.

### 3c. Recommended cutover step ordering (amended)

1. **(Prep, anytime)** Ship the **decouple fix (d)** first and re-observe rows-written for a
   day — it is independent of the cutover and de-risks the cost story. *(Optional but advised.)*
2. **PR-1 (the cutover), one atomic deploy, at a low-traffic hour NOT within ~5 min of UTC
   midnight:** flip `FLUSH_TABLE` → `rollup_daily` (Step 1) **+** delete the cron & `scheduled()`
   & the `crons` trigger (Step 3) **+** lower the salt TTL 48h→25h & drop `rotateDailySalt`
   (Step 2). **Do NOT drop the shadow table. Do NOT delete `src/rollup/index.ts` logic yet** (or
   preserve it as a manual script).
3. **(Optional, immediately post-deploy)** Hazard-2B reconciliation copy for the transition day.
4. **Observe** ≥1 settled UTC day: compare `rollup_daily` (now DO-owned) against `WAE` recompute
   and against the still-present shadow. Confirm pageviews within the bounded transition-day
   tolerance and visitors exact.
5. **PR-2 (cleanup), after the gate passes:** drop `rollup_daily_shadow` (Step 4, + the
   `0003_drop_rollup_shadow.sql` migration), remove `src/rollup/index.ts`/tests, write the
   Phase-2 supersession ADR (**0011**, per ADR-0010's numbering note). This preserves a clean
   rollback across the risky window.

The salt-TTL change (Step 2) is independent and safe in PR-1. The plan's per-step TDD guidance
is otherwise sound.

---

## 4. Confidence & risk flags

- **HIGH:** setAlarm/put/delete are billed row-writes and getAlarm is a read `[DOCS]`; the
  eviction-coupled `setAlarm` loop exists and is event-independent (read from code); the cron
  is absolute / the DO is additive (read from code) → the cutover hazards are real; DO-counters
  remain the right primitive.
- **MEDIUM:** the exact split of the measured 99 rows (mechanism certain, per-term split
  modelled, not separately observed); the "put = ~1 row" assumption at target scale (large-value
  KV→rows chunking under-documented; non-issue for the small blob); the seen 2.25× base factor
  (inferred, audience-dependent).
- **Publishable number confidence: MEDIUM** — the ~500k floor / ~0.9M typical range is robust;
  a single flat number is not honest given the 2.25×–7× spread. Recommend publishing the range.
- **Watch / beta:** DO SQLite storage billing is live since **Jan 2026** `[DOCS]`, so these
  rows-written costs are billed *today* on Paid; WAE writes remain **$0** ("you will not be
  billed currently") so the DO line dominates the bill until CF flips WAE billing on.

---

## Sources (retrieved 2026-07-04)

- **DO pricing** (Free 100k rows-written/day, 5M rows-read/day, 5 GB, 100k requests/day, 13k
  GB-s/day; Paid 50M rows-written/mo + **$1.00/M**, 25B rows-read/mo + $0.001/M, 5 GB-mo +
  $0.20/GB-mo, 1M requests/mo + $0.15/M) — <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- **DO pricing partial** (canonical billing rules: "Key-value methods like `get()`, `put()`,
  `delete()`, or `list()` … are billed as rows read and written"; "**Each `setAlarm()` is billed
  as a single row written**") — <https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/durable-objects/durable-objects-pricing.mdx>
- **SQLite-backed DO storage API** ("When writing data, every row update of an index counts as
  an additional row") — <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- **DO SQLite storage billing changelog** (billing enabled Jan 2026, target 2026-01-07; only
  usage on/after the target date charged; Free plan not charged) —
  <https://developers.cloudflare.com/changelog/2025-12-12-durable-objects-sqlite-storage-billing/>
  and community changelog <https://community.cloudflare.com/t/durable-objects-workers-billing-for-sqlite-storage/869004>
- **DO lifecycle** (hibernateable DO hibernates after ~10 s of inactivity; in-memory state
  discarded on hibernation) — <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>
- **D1 pricing** (Free 100k rows-written/day, 5M rows-read/day, 5 GB; Paid 50M rows-written/mo +
  **$1.00/M**, 25B rows-read/mo, 5 GB + $0.75/GB-mo) — <https://developers.cloudflare.com/d1/platform/pricing/>
- **WAE pricing/limits** (Free 100k data-points/day; 3-month retention; "Currently, you will not
  be billed for your use of Workers Analytics Engine") —
  <https://developers.cloudflare.com/analytics/analytics-engine/pricing/>,
  <https://developers.cloudflare.com/analytics/analytics-engine/limits/>
- **Prior internal analysis:** ADR-0010 (`docs/decisions/0010-do-pending-durability.md`);
  feasibility sweep (`docs/research/2026-07-03-tech-state-and-feasibility.md` §3); roadmap O5/C3
  (`docs/specs/2026-07-03-feature-roadmap.md`); cutover plan
  (`docs/plans/2026-06-29-do-incremental-counters.md` §"Phase 2").
- **Measurements** `[MEASURED]`: 2026-07-04 Cloudflare GraphQL/observability, gate day
  2026-07-03 — 99 DO rows-written / 14 pageviews (7.1×); 38,374 D1 rows-written/day (~99.6%
  cron); DO shadow flush ~49 distinct rows/day.

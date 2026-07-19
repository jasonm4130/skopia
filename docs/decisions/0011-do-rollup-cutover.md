# 0011 — Phase-2 cutover: the DO becomes the sole `rollup_daily` writer

- **Date:** 2026-07-04
- **Status:** accepted
- **Owner:** cloudflare-tech-lead
- **Relates to:** supersedes the cron-writes-`rollup_daily` half of ADR-0003; amends the
  Phase-2 section of plan `docs/plans/2026-06-29-do-incremental-counters.md`; builds on
  ADR-0010 (durable `pending`/flush state in the `SiteLive` DO). Executed by Task 12 of
  plan `docs/plans/2026-07-04-review-hardening-and-cutover.md`.
- **Evidence base:** `docs/research/2026-07-04-do-counters-design-iteration.md`
  (tech-lead design iteration, 2026-07-04, cited inline below); the 2026-07-03 parity
  gate; live GraphQL/observability numbers pulled 2026-07-04.

## Context

Phase 1 ran the event-driven `SiteLive` DO counters in parallel with the legacy 5-minute
WAE-polling cron: the DO wrote `rollup_daily_shadow`, the cron kept writing the
authoritative `rollup_daily`. The first parity check (settled day 2026-06-30) **failed
badly on pageviews** — a durability bug in the DO's RAM-only `pending` map, root-caused
and fixed by ADR-0010 (durable `flushstate` blob, reloaded on cold start).

With the fix deployed, the parity gate was re-run on settled day **2026-07-03** and
**PASSED**: `rollup_daily` and `rollup_daily_shadow` matched **exactly** for every
traffic-bearing site. The handful of sites present in the cron's output but absent from
the shadow were confirmed to be **zero-traffic** — the cron writes a zero-row for every
known site every pass regardless of activity, while the DO only ever writes a site it has
seen an event for, so their "absence" is not a discrepancy.

Measured write costs (2026-07-04, gate day 2026-07-03), from the design-iteration
research doc:

- **DO:** ~7.1 rows-written per pageview at the sampled low-traffic/high-unique profile.
  The dominant *removable* term was the `setAlarm()` reschedule loop trailing every live
  visitor for up to 5 minutes for pure liveness bookkeeping, independent of event volume —
  fixed earlier in this branch (Task 3, "decouple live eviction from the flush alarm"),
  which drops the multiplier to roughly **~5×** at the same profile. The remaining cost is
  the necessary `seen` inserts plus the one `flushstate` blob write ADR-0010 requires.
- **D1:** ~38,374 rows written/day, of which **~99.6% is the cron's** absolute-recompute
  passes (every 5 minutes, today + 2 prior days, for every site). Retiring the cron cuts
  D1 write volume roughly **250×** at current traffic — the DO's own writes are the
  remaining ~150 rows/day.

Given the parity PASS and the cost profile, the cron is no longer needed as either a
correctness backstop or the primary write path — it is now pure overhead and, per the
next section, an active hazard if left running alongside the DO.

## Decision

**The `SiteLive` DO becomes the sole writer of `rollup_daily`.** The 5-minute cron
trigger, its `scheduled()` handler, and the daily-salt rotation it drove are retired in
the same deploy. `src/rollup/index.ts` (the cron's WAE→rollup recompute logic) and the
`rollup_daily_shadow` table are **not** deleted — they are retained as the rollback and
reconciliation path (see Consequences) until a follow-up PR.

## Amendments over the original Phase-2 plan

The original plan (`docs/plans/2026-06-29-do-incremental-counters.md` §"Phase 2")
specified: flip the DO's write target, delete the cron, drop the shadow table — in that
order, no atomicity requirement. The 2026-07-04 design-iteration review found this unsafe
and amended it as follows.

1. **Flip the write target and remove the cron trigger in ONE atomic deploy.** The cron
   writes `rollup_daily` with **absolute** semantics (`SET pageviews = excluded.pageviews`,
   recomputed from WAE each pass); the DO's flush is **additive** for pageviews. If the
   flip ships but the cron keeps running even briefly, every cron pass overwrites the
   DO's additive contributions for the day — the DO's writes vanish every 5 minutes until
   the cron is actually gone. A non-atomic rollout is silently self-defeating, not merely
   incomplete.
2. **`rollup_daily_shadow` and `src/rollup/index.ts` are retained until a follow-up PR,
   ≥1 settled day post-cutover.** Dropping the shadow table in the same PR (as the
   original plan specified) destroys the only clean rollback: if the cutover misbehaves,
   redeploying the prior Worker version restarts the cron and the DO resumes writing the
   shadow, but only if the shadow table still exists. Keeping `src/rollup/index.ts` also
   preserves a manual WAE→`rollup_daily` recompute path for any day the cutover affects,
   since WAE retains raw events independently of either write path.
3. **Deploy at a low-traffic hour, NOT within ~5 minutes of UTC midnight.** The DO rolls
   its `pending` state to a new day only on the first event of that day; a deploy shortly
   after 00:00 UTC can catch the DO still holding residual `pending` for the *previous*
   day. That rollover flush is additive and would land on `rollup_daily[previous-day]`,
   which the cron already finalised as absolute — overcounting a day that should be
   settled. Any other low-traffic hour avoids this.
4. **Accept a bounded transition-day imperfection.** At the moment of cutover,
   `rollup_daily[today]` holds the cron's last absolute snapshot; events in the window
   between the cron's last run and the DO's last shadow flush (up to one cron interval,
   ~5 minutes) were flushed only to the now-abandoned shadow table and never reach
   `rollup_daily`. Pageviews for the cutover day can therefore undercount by up to ~5
   minutes of traffic — a handful of pageviews at current scale. **Visitors self-heal**:
   the DO writes visitor counts *absolute* from its full-day `seen` set on its first
   post-cutover flush, overwriting the cron's value, so no visitor-count gap persists.
   This is accepted as a one-time, one-day, bounded cost rather than engineered away.
   Optionally, it can be closed exactly with a one-shot `rollup_daily_shadow[today] →
   rollup_daily[today]` copy immediately post-deploy (before the shadow is later
   dropped) — not required, left to the operator's judgment at deploy time.

### Follow-up landed — 2026-07-19 (shadow drop)

The retention window in Amendment 2 has elapsed (≥1 settled day post-cutover), so the
shadow-drop follow-up (Operational checklist item 5) has now shipped:

- `src/rollup/index.ts` (the retained manual WAE→`rollup_daily` recompute backstop) is
  **deleted** — it had no callers and the Worker never exported `scheduled()`.
- `rollup_daily_shadow` is **dropped** via a new append-only migration
  `migrations/0003_drop_rollup_shadow.sql` (`DROP TABLE IF EXISTS`); migration 0002 is left
  in place so live DBs replay 0002→0003 in order. The embedded schema
  (`src/shared/schema-embed.ts`) was regenerated (2→3 migrations).
- **How the drop reaches a live database:** the same way all schema does in this project —
  through `ensureSchema`'s embedded chain on the next dashboard/setup request, not via
  `wrangler d1 migrations apply`. The Deploy-button D1 is created empty and never migrated
  by wrangler (`src/shared/schema.ts`); `migrations/` is only the *source* build-schema
  globs into the embed. So `wrangler deploy` (Operational checklist item 2) does not itself
  apply the drop — the next dashboard read does, idempotently (`DROP TABLE IF EXISTS`). A
  deployment that only ever ingests and whose dashboard is never opened keeps the empty,
  unused shadow table until first read; that is harmless (no reader, no writer, negligible
  space). Operators who want the drop applied eagerly at deploy time can run
  `wrangler d1 migrations apply skopia --remote`, but it is not required.
- The "RETAINED … until the shadow-drop follow-up" comments in the deleted module, in the
  collector's fire-and-forget catch block, and in the embedded 0002 comment are removed.

Consequently the "Rollback story" above and the "committed to keep them in the codebase"
note in Consequences are now **historical**: the clean redeploy-the-prior-Worker rollback
no longer exists (the shadow table is gone). WAE still retains the raw events, so a manual
recompute of any affected day remains possible from the WAE SQL API if a parity spot-check
ever surfaces loss.

## Fire-and-forget re-justification

The collector delivers each event to the `SiteLive` DO via `ctx.waitUntil(fetch(...))`
and swallows delivery failures. That was previously justified as safe because "WAE
already holds the durable copy, and the cron reconciles `rollup_daily` from WAE
regardless of whether the DO delivery succeeded." **That premise no longer holds**: with
the cron retired, a swallowed DO-delivery failure is now a **bounded, permanent** loss to
`rollup_daily` for that event (WAE still has the raw event; nothing recomputes
`rollup_daily` from it automatically).

Accepted as-is because: such failures are rare (DO restarts or overload, not routine
delivery), WAE retains the raw events so a manual recompute of any affected day remains
possible from the WAE SQL API (the `src/rollup/index.ts` recompute logic was removed in the
2026-07-19 shadow-drop follow-up above — restore it from git history if ever needed), and
the alternative (per-event retry or a queue in front of the DO) adds meaningful complexity
for a loss rate that has not been observed to matter at current scale. **Revisit this if a parity spot-check ever surfaces measurable
loss** — that would be the signal the accepted rate is no longer negligible.

## Rollback story

Redeploy the prior Worker version. The cron and `scheduled()` handler return; the DO
resumes writing `rollup_daily_shadow` (its `FLUSH_TABLE` reverts with the code); the
shadow table still exists (never dropped by this change) so the DO's writes land
correctly. `src/rollup/index.ts` remains available to recompute `rollup_daily` from WAE
for any day affected by the cutover attempt.

## Operational checklist

The human runs this, in order, when ready to deploy:

1. Re-apply the trigger removal to the **local** `wrangler.jsonc` — the committed copy
   carries placeholder IDs and is never the deploy source; the local file carries the
   real account IDs and must have the `"triggers"` block removed there too.
2. `pnpm build && pnpm exec wrangler deploy`, at a low-traffic hour, **not** within ~5
   minutes of UTC midnight (Amendment 3).
3. The next day, spot-check `rollup_daily` against the live dashboard for the sites that
   had traffic during the cutover window.
4. Close GitHub issue #14 and delete/disable the reminder routine tracking the
   shadow-table drop follow-up.
5. **≥1 settled day later**, open the follow-up PR: drop `rollup_daily_shadow`, add
   migration `0003_drop_rollup_shadow.sql`, delete `src/rollup/index.ts` and the
   `test/rollup.test.ts` remnants, and remove the "RETAINED … until the shadow-drop
   follow-up" comment this cutover left in place.

## Consequences

**What it fixes.** D1 write volume drops ~250× at current traffic (cron was ~99.6% of
D1 writes). The dashboard's `rollup_daily` table is now written directly by the same
event-driven path that already powers the real-time live count, removing the two-writer
race the shadow parity check existed to catch.

**What it costs.** DO rows-written per pageview (~5× after Task 3, on top of the
necessary `seen` writes) becomes the only per-event write cost that scales with traffic —
there is no cheaper fallback if that multiplier needs to come down further (the
design-iteration doc's option (e), reducing `seen` fan-out, is a PM-gated accuracy
tradeoff, not a free lever). The collector's fire-and-forget DO delivery is now a real,
if rare and bounded, loss path (see above) rather than a belt-and-suspenders one.

**What we're now committed to.** `src/rollup/index.ts` and `rollup_daily_shadow` stay in
the codebase — unused by the running Worker — until the follow-up PR; do not delete
either before that PR, and do not treat their presence as dead code to clean up
opportunistically.

**Watch.** Confirm on the first settled post-cutover day that the transition-day
undercount (Amendment 4) was in fact bounded to about one cron interval, and that no
larger discrepancy appeared. If a parity spot-check ever shows loss beyond that bound,
revisit the fire-and-forget justification above before assuming it is transition noise.

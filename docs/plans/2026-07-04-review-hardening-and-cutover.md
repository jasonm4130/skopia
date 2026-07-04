# 2026-07-04 — Review hardening + Phase-2 cutover

Executes the verified findings of the 2026-07-04 four-agent review (3 code reviewers +
tech-lead design iteration) and the amended Phase-2 cutover. Design rationale and
measurements: `docs/research/2026-07-04-do-counters-design-iteration.md`. Parent plan
(now amended by this one): `docs/plans/2026-06-29-do-incremental-counters.md`.

**Sequencing intent:** Tasks 1–11 harden; Tasks 12–13 are the cutover flip + ADR; Task 14
records the free-tier answer. The shadow-table drop is deliberately NOT in this plan — it
is a follow-up PR ≥1 settled day after the cutover deploys (see Task 13).

## Global Constraints

- TypeScript strict mode; Cloudflare Workers runtime. Match existing file style exactly
  (biome-enforced). No features or abstractions beyond what the task specifies.
- **TDD is mandatory for every code task**: write the failing test first, run it, confirm
  it fails for the right reason, then implement, then quote the red→green transition.
  Runners: `pnpm exec vitest run <file>` per-file, `pnpm test` full suite,
  `pnpm typecheck`, `pnpm lint`. All three must be green before a task is complete.
- The tracking script is sacred: `< 2 KB` gzipped, CI-enforced by
  `scripts/check-script-size.mjs` via `pnpm ci`. Never regress its size without cause.
- After changing `src/script/skopia.ts` or `migrations/*.sql`, run `pnpm build` and
  commit the regenerated embeds (`src/shared/skopia-embed.ts`, `src/shared/schema-embed.ts`).
- DO tests share one D1 database and the flush UPSERT is additive: use a **unique
  per-test `site_id`** for any absolute-value assertion.
- Never write a raw `\u0001`/`\x00` control byte into a source file — only the escape
  text (a literal control byte corrupts the file for git).
- Do not touch `wrangler.jsonc` except where Task 12 says. Never introduce real account
  IDs into it (the committed copy carries placeholders; that must remain true).
- Privacy invariants: no cookies, no cross-site identifiers, no raw PII at rest.
- Commit per task with a descriptive message; commit trailer
  `Claude-Session: https://claude.ai/code/session_01WNT8ji3YoE5DThGLHayBMK`.

## Out of scope (do NOT do these here)

- Dropping `rollup_daily_shadow`, deleting `src/rollup/index.ts`, or adding migration
  `0003` — follow-up PR ≥1 settled day post-cutover (Task 13 documents it).
- The actual production deploy (human-timed; Task 13 documents the procedure).
- Login rate limiting/lockout infrastructure (only the timing oracle is fixed, Task 9).
- A DOM test harness for the tracking script (none exists; script changes are verified
  by build + size check + review).
- Query-string-only SPA navigation counting (product decision, not taken here).

---

## Task 1: Day-scoped pending — rollover correctness by construction

**Files:** `src/dashboard/site-live.ts`, `test/site-live.test.ts`
**Fixes:** midnight rollover re-entrancy (double-count old day / wipe first new-day
events) and rollover-discard-on-failed-flush. Both traced and confirmed 2026-07-04.

The root defect: `maybeRollover()` flushes the old day across an `await` while
`this.currentDay` still holds the old value, so concurrent events re-enter it (the DO
input gate stays open during D1 subrequests); and it clears `pending` + drops `seen`
even when the flush failed. Instead of patching the race, remove the day-boundary
special case entirely by keying pending rows by day:

1. `pendingKey(day, dimension, dimValue)` returns
   `` `${day}\u0001${dimension}\u0001${dimValue}` `` (escape text, never a raw byte).
   `PendingRow` gains `day: string`.
2. `recordEvent(e)`: compute `day = utcDay(new Date())`; **delete the `maybeRollover`
   call**; accumulate deltas under the day-scoped key with `day` stored on the row. The
   `seen` insert is already day-keyed — unchanged. `persistPending()` unchanged.
3. `flush()`: bind each row as
   `(site, row.day, row.dimension, row.dimValue, row.delta, countSeen(row.day, …))`.
   Remove the single-`currentDay` assumption; the guard becomes
   `this.siteId === null || this.pending.size === 0`. Old-day rows simply flush on the
   next alarm alongside new-day rows — a failed flush at midnight now retries naturally
   (this is what fixes the discard bug).
4. `FlushState` v2: `{ v: 2, siteId, pending }`. `rehydrate()` must migrate a legacy
   blob (shape `{siteId, currentDay, pending}` with 2-part keys): remap each key to
   `` `${s.currentDay}\u0001${key}` `` and set `row.day = s.currentDay`. Deployed DOs
   hold legacy blobs at upgrade time; losing them would regress ADR-0010.
5. Delete `maybeRollover()` entirely. Replace the `DROP TABLE seen` reset with lazy
   pruning in `alarm()`: keep a RAM `lastPruneDay: string | null`; after `flush()`, if
   `utcDay(new Date()) !== lastPruneDay`, run
   `DELETE FROM seen WHERE day < ?` (today) and update `lastPruneDay`. (Idempotent, at
   most one prune per day per instance; RAM loss just re-prunes.)
6. Keep `this.currentDay` only if something still needs it; if nothing does, delete the
   member (expected outcome: deleted).

**TDD (write failing first):**
- Cross-midnight accumulation: with a mocked clock, record events on day D0, advance to
  D1, record more, run `alarm()` once → D1 rows in the flush table for BOTH days with
  exact pageviews/visitors; `seen` rows for D0 pruned after the D1-day prune runs.
- Failed rollover flush retains data: stub `env.DB.batch` to throw once at the first
  post-midnight alarm → pending still holds both days; next alarm succeeds → exact
  totals, no loss, no double-count.
- Legacy-blob migration: seed storage with a v1-shaped `flushstate` (2-part keys +
  `currentDay`), cold-start the DO (new instance id), flush → deltas land under the
  legacy `currentDay`.

**Verify:** `pnpm exec vitest run test/site-live.test.ts` red→green, then
`pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 2: Subtractive, chunk-committed flush — no loss, no re-apply

**Files:** `src/dashboard/site-live.ts`, `test/site-live.test.ts`
**Depends on:** Task 1
**Fixes:** events-lost-during-in-flight-flush and partial-chunk-retry double-count.
Both traced and confirmed 2026-07-04.

The root defects: `flush()` does `pending.clear()` + `storage.delete(flushstate)` after
awaiting `DB.batch`, wiping any event that interleaved during the await (D1 calls are
subrequests — the input gate stays OPEN); and on a multi-chunk flush, a chunk-2 failure
retries chunk 1 too (additive → permanent inflation).

Replace clear-on-success with **subtract-what-was-committed**:

1. When building statements, record per chunk the list of `(key, boundDelta)` pairs
   (the delta captured at bind time).
2. After each successful `DB.batch(chunk)`: for each pair, look up
   `this.pending.get(key)`; if present, `row.delta -= boundDelta`; delete the entry when
   `row.delta === 0`. Then persist the remainder: `pending.size === 0` →
   `storage.delete(FLUSH_STATE_KEY)`, else `persistPending()`. Persisting after EACH
   chunk means a crash between chunks cannot re-apply a committed chunk.
3. On a thrown batch: stop (remaining chunks stay in `pending`; the durable snapshot
   already reflects exactly what is still owed). The existing swallow-and-retry
   `catch {}` semantics stay, but now they are correct.
4. An event that arrives mid-batch mutates `pending` (adds to `row.delta` or a new key)
   and its own `persistPending()` may interleave — that is fine: subtraction preserves
   its contribution, and the post-chunk persist re-writes a superset-correct snapshot.

Note: the crash window between a committed batch and the post-chunk persist re-applies
at most ONE chunk (pre-existing ADR-0010 accepted risk, now chunk-bounded instead of
whole-flush). Task 13's ADR re-states this bound.

**TDD (write failing first — both tests are feasible in the workers pool by replacing
`instance.env.DB` with a wrapper object whose `batch` returns a manually-resolved
deferred promise / throws on the Nth call):**
- Mid-flight event survives: start a flush (deferred batch), deliver an event while the
  batch is pending, resolve the batch, run the next alarm → D1 totals include the
  mid-flight event exactly once.
- Chunk-partial failure: >100 distinct pending rows (loop 150 unique `dim_value`s),
  batch call 1 succeeds, call 2 throws; next alarm retries → D1 totals exact; the first
  chunk's rows are NOT double-counted.

**Verify:** red→green per test, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 3: Decouple live eviction from the flush alarm; gate broadcast

**Files:** `src/dashboard/site-live.ts`, `test/site-live.test.ts`
**Depends on:** Task 2
**Why:** measured 2026-07-04: the 15s alarm re-arms while `visitors.size > 0` (5-min
live TTL ⇒ up to ~20 billed `setAlarm` row-writes trail every session, event-count
independent — the dominant removable term in the 7.1 rows-written/pageview). Design
decision: `docs/research/2026-07-04-do-counters-design-iteration.md` §1. Also:
`broadcast()` builds the full snapshot before checking for connected sockets.

1. `alarm()` reschedule condition becomes `this.pending.size > 0` ONLY.
2. Move stale-visitor eviction out of `alarm()` into `currentSnapshot()`: evict entries
   older than `VISITOR_TTL_MS` at the top, before aggregation. (The live count is then
   correct at every read; the map is RAM-only and hibernation clears it naturally, so
   unbounded growth is not a concern — say so in a comment.)
3. `broadcast()`: `if (this.ctx.getWebSockets().length === 0) return;` BEFORE building
   the snapshot payload.
4. `handleEvent`'s existing `getAlarm()` guard stays (arm only when none pending).

**TDD (write failing first):**
- No alarm tail: record one event, run `alarm()` (flushes, pending empties) → assert
  `storage.getAlarm()` is `null` (today it re-arms because a visitor is live — red).
- Lazy eviction: record an event, advance the mocked clock past `VISITOR_TTL_MS`, call
  `snapshot()` → `visitors === 0` without any alarm having run.

**Verify:** red→green, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 4: Referrer honesty — self-referral filter + SPA entry-referrer

**Files:** `src/script/skopia.ts`, `src/collector/index.ts`, `test/collector.test.ts`
**Why:** confirmed 2026-07-04: nothing anywhere compares the referrer against the
site's own domain (internal MPA navs credit the site itself as a source), and the
script re-sends the unchanging `document.referrer` on every SPA nav (one Google arrival
browsing 20 routes credits Google 20×). Worst honest-metrics defect of the review.

**Script** (remember: every byte ships to every visitor):
1. Add `var first = true;` module state. In `send()`, attach `b.r = ref` only when
   `first` is true; set `first = false` after the first send of any type. SPA navs and
   subsequent custom events then carry no `r` at all.

**Collector:**
2. Extend the merged site lookup (`getSiteAllowlist`, fix #6a — keep it ONE D1 read) to
   also return the site's `domain` column.
3. After `parseReferrerHost(beacon.r)`: if the site `domain` is non-empty and
   `referrerHost` is non-empty, normalize both sides (lowercase, strip one leading
   `www.`) and if equal, treat as direct (empty `referrerHost`, exactly what an absent
   `r` produces — downstream maps `""` → `(direct)`).
4. Sites with the default empty `domain` skip the filter (no behavior change).

**TDD (collector; write failing first):**
- Beacon with `r` = own domain (test the `www.` and mixed-case variants) → the WAE
  referrer blob is `""`.
- External referrer unchanged; empty site `domain` skips filtering.
- Site lookup remains a single D1 query (assert via a counting wrapper on
  `env.DB.prepare`).

Script change has no test harness (see Out of scope): verify `pnpm build` regenerates
the embed and `pnpm ci`'s size check passes.

**Verify:** red→green, `pnpm build`, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 5: Bot filter — stop dropping humans; fix the dead verified-bot check

**Files:** `src/shared/cf.ts`, `test/cf.test.ts`
**Why:** confirmed 2026-07-04: (a) `DATACENTER_ORG_PATTERNS` contains `cloudflare`,
`fastly`, `akamai` — the documented iCloud Private Relay egress partners, so every
Private-Relay Safari user is silently dropped; `google` matches residential
`GOOGLE-FIBER`; (b) the bare `"bot"` UA substring matches CUBOT-brand Android phones;
(c) `cfRaw.verifiedBot` is not a real Workers field (the all-plans field is
`cf.verifiedBotCategory`) — the check is dead code and the unit test fabricates the
wrong shape, masking it.

1. `DATACENTER_ORG_PATTERNS`: remove `"cloudflare"`, `"fastly"`, `"akamai"`; replace
   `"google"` with `"google cloud"`. Rationale comment to add: for an honest-metrics
   product, false-positives on humans are strictly worse than false-negatives on
   scrapers; Private Relay egress and residential fiber must never match. (Accepted
   trade: GCP egress identifying as other org strings slips this one heuristic; the UA
   and header heuristics still apply.)
2. Remove the bare `"bot"` entry from `BOT_UA_PATTERNS`. Preserve its catch-rate for
   real crawlers ("SomethingBot/1.0") without the CUBOT false-positive by checking a
   brand-stripped copy: `const uaStripped = uaLower.replace(/cubot/g, "");` then
   substring-match `"bot"` against `uaStripped` as a dedicated check after the pattern
   loop.
3. Replace the dead check with
   `typeof cfRaw.verifiedBotCategory === "string" && cfRaw.verifiedBotCategory.length > 0`
   and correct the comment (this is the non-Enterprise field; `cf.botManagement.*` is
   Enterprise-only).
4. Fix the test that fabricates `cf: { verifiedBot: true }` to use
   `cf: { verifiedBotCategory: "Search Engine Crawler" }`.

**TDD (write failing first):**
- UA `"Mozilla/5.0 (Linux; Android 10; CUBOT_X30) …"` and `"… CUBOT KINGKONG …"` →
  NOT bot (red today).
- UA `"MegaIndexBot/1.0"` → bot (must stay caught after the bare-entry removal).
- `asOrganization` `"Cloudflare Inc."`, `"GOOGLE-FIBER"` → NOT bot (red today);
  `"Google Cloud Platform"` → bot.
- `cf.verifiedBotCategory: "Search Engine Crawler"` with a clean browser UA → bot
  (red today, because the current field check never fires).

**Verify:** red→green, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 6: Beacon path must never 5xx

**Files:** `src/collector/index.ts`, `test/collector.test.ts`, `test/deploy-cold.test.ts`
**Depends on:** Task 4 (same file)
**Why:** confirmed 2026-07-04: `getSiteAllowlist` (D1), `getDailySalt` (KV) and
`deriveVid` (crypto) are awaited bare — any transient infra error propagates to Hono's
default 500 (without CORS headers, so customer consoles fill with CORS errors); and the
collector never bootstraps the schema, so a beacon on a cold deploy before any
dashboard visit throws `no such table`.

1. Wrap everything in `handleCollect` after body parsing/validation (from the site
   lookup onward) in one `try/catch`. On catch: `console.error("collector error", err)`
   (observability) and return `204` with `origin ? corsHeaders(origin) : {}`. The
   deliberate non-204 responses (404 unknown site, 403 origin, 503 missing secret) are
   `return`s, not throws — they must keep working.
2. Cold-schema consequence: `no such table` now falls into the catch → silent 204 drop
   until the dashboard's `ensureSchema` runs. Acceptable (previously a 500); note it in
   a comment. Do NOT add per-request `ensureSchema` to the hot path.

**TDD (write failing first):**
- Stub the D1 binding to throw on the site lookup → POST `/e` returns **204** with the
  `Access-Control-Allow-Origin` header (red: currently 500 without CORS).
- Cold deploy: fresh env WITHOUT running `ensureSchema` first (the existing
  `deploy-cold.test.ts` bootstraps before beaconing — add the missing-order case) →
  beacon returns 204.
- Existing 404/403/503 tests still pass unchanged.

**Verify:** red→green, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 7: Collector hot-path caching + drop CSP work on `/e`

**Files:** `src/collector/index.ts`, `src/shared/identity.ts`, `src/index.ts`,
`test/collector.test.ts`
**Depends on:** Task 6
**Why:** confirmed 2026-07-04: every pageview pays an uncached D1 site lookup, a KV
salt read, a `crypto.subtle.importKey`, and a full CSP-nonce security-header pass on a
body-less 204 — all constant per isolate (or per day).

1. Module-level site cache in the collector:
   `Map<siteId, { allowlist, domain, at }>` with a 60 s TTL; cache negative lookups
   (unknown site) too, so a flood of bogus site ids can't hammer D1. Comment: per-isolate
   cache ⇒ allowlist/domain edits take effect within ≤60 s per isolate — acceptable.
2. Module-level salt memo `{ day, salt }` in the collector (day-keyed; KV hit only on
   day change per isolate).
3. In `deriveVid` (`src/shared/identity.ts`): memoize the imported HMAC `CryptoKey`
   keyed on the secret string (module-level single-entry cache).
4. `src/index.ts`: exempt the collector route from the security-header middleware:
   `app.use("*", (c, next) => (c.req.path === "/e" ? next() : securityHeaders(c, next)))`
   — keep every other route's behavior identical.

**TDD (write failing first):**
- Two beacons, same site, same test → exactly one D1 site-lookup query (counting
  wrapper on `env.DB.prepare`; red today: two).
- Two beacons same day → one KV `get` for the salt (counting wrapper on `env.SALT`).
- POST `/e` response has NO `Content-Security-Policy` header; `GET /health` still does.

**Verify:** red→green, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 8: Collector input validation — bound what strangers can store

**Files:** `src/collector/index.ts`, `test/collector.test.ts`
**Depends on:** Task 7
**Why:** confirmed 2026-07-04: the size cap counts UTF-16 code units (a 2048-char CJK
body is ~6 KB); `p`/`r`/`n` have no length caps (a 2000-char event name becomes a
rollup dim_value and a dashboard row); `w` is never type-checked (`{"w":{}}` →
`Number({})` = `NaN` reaching `writeDataPoint`); `n` is honored on `t:"pv"` beacons.

1. Size: reject early (existing rejection semantics) when `Content-Length` exceeds
   4096; measure the parsed body cap in BYTES
   (`new TextEncoder().encode(text).length > 2048`).
2. Field caps (truncate, don't drop — bound storage, keep the event):
   `p` → 512 chars, `r` → 1024, `n` → 128.
3. `w`: keep only when `typeof beacon.w === "number" && Number.isFinite(beacon.w) &&
   beacon.w > 0 && beacon.w <= 32767`; otherwise omit it entirely (no NaN can reach
   WAE).
4. Ignore `n`/`d` unless `t === "event"` (a hand-crafted pv beacon must not be able to
   inject rows into the events breakdown).

**TDD (write failing first):**
- `{"w":{}}` beacon → 204 and the WAE data point carries no NaN double (red today).
- 2000-char `n` on a `t:"event"` beacon → stored name is 128 chars.
- `n` on a `t:"pv"` beacon → no `event` dimension contribution.
- All-CJK body over 2048 bytes but under 2048 chars → rejected (red today).

**Verify:** red→green, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 9: Dashboard polish — timing oracle, honesty caveats, script-safe JSON

**Files:** `src/dashboard/index.ts`, `test/dashboard.test.ts`
**Why:** three verified minors from the security review (no majors existed): the login
`&&` short-circuit skips PBKDF2 on email mismatch (a measurable is-this-the-owner's-
email oracle); the breakdown views show summed-daily "Visitors" without the honesty
tooltip the Overview has (and never surface the per-row `sampled` flag); the geography
map inlines `JSON.stringify(...)` into a `<script>` without `</script>`-safe escaping
(latent stored-XSS pattern — not exploitable today, `cf.country` is trusted).

1. Timing oracle: commit a module-level `DUMMY_PW_HASH` constant (generate once with the
   existing hash helper, same encoded format `verifyPassword` parses). On email
   mismatch, still `await verifyPassword(password, DUMMY_PW_HASH)` and discard the
   result, then fail. Login outcomes must be byte-identical to today.
2. Breakdown honesty: put the Overview's visitors-tooltip copy (see the stat-card title
   at the "counted once per day" string) on the breakdown table's Visitors column
   header (`title` attribute), and render the existing `~` estimated badge on rows whose
   `sampled` flag is set (match the Overview's badge markup).
3. Add `jsonForScript(v)`: `JSON.stringify(v)`, then in the resulting string replace
   every `<` with the six characters `\u003c`, every `>` with `\u003e`, and the
   U+2028/U+2029 line separators with `\u2028`/`\u2029` (escape TEXT in the output,
   which is still valid JSON/JS); use it for `mapValues` (the `var vals=…` inline
   script). Comment why: `JSON.stringify` does not neutralize `</script>`.

**TDD (write failing first):**
- `jsonForScript`: a value containing `</script><img src=x>` must not appear literally
  in the rendered page (red with plain stringify).
- `/app/pages` SSR: Visitors header carries the caveat `title`; a `sampled: 1` fixture
  row renders the badge.
- Login: wrong-email and wrong-password both still land on the same failure response.

**Verify:** red→green, then `pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 10: Tracking script slim — drop dead `ti`, fix the lying docblock

**Files:** `src/script/skopia.ts` (+ regenerated `src/shared/skopia-embed.ts`)
**Depends on:** Task 4 (same file)
**Why:** confirmed 2026-07-04: the collector never reads `beacon.ti` (no reference;
`WaeEvent` has no title slot) — every beacon ships dead payload bytes, and collecting
unused data is a privacy-posture smell. The header docblock claims a
`visibilitychange`/`pagehide` transport that does not exist in the file.

1. Remove the `ti` lines from `send()`.
2. Rewrite the docblock transport paragraph to describe reality: fetch with
   `keepalive: true`, fired synchronously at navigation time; SPA via history
   monkey-patch + popstate.
3. `pnpm build`; commit the regenerated embed. Size must not grow (expect a small
   shrink from 571 B gzipped).

**Verify:** `pnpm build`, `node scripts/check-script-size.mjs` (quote the byte count),
`pnpm test && pnpm typecheck && pnpm lint`.

---

## Task 11: CI must fail on stale embeds

**Files:** `package.json`
**Why:** verified 2026-07-04: the embeds are in sync today, but nothing enforces it —
`pnpm ci` regenerates them and never checks, there are no GitHub workflows, and
`wrangler deploy` has no build hook, so an edit without `pnpm build` ships stale bytes
silently.

1. In the `ci` script, after the build steps, add:
   `git diff --exit-code -- src/shared/schema-embed.ts src/shared/skopia-embed.ts`
   (fails when regeneration changed either embed, i.e. the commit was stale).

**Verify (demonstrate both sides, then leave the tree clean):** `pnpm ci` passes on a
clean tree; temporarily append a comment to `src/script/skopia.ts` without rebuilding →
`pnpm ci` fails at the diff step; revert the temp edit; `pnpm ci` green again.

---

## Task 12: Phase-2 cutover — flip, retire the cron trigger, keep the backstop

**Files:** `src/dashboard/site-live.ts`, `src/shared/identity.ts`, `src/index.ts`,
`wrangler.jsonc`, `src/rollup/index.ts` (comment only), `src/collector/index.ts`
(comment only), `test/site-live.test.ts`, `test/collector.test.ts`,
`test/identity.test.ts`, `test/rollup.test.ts` (deleted)
**Depends on:** Task 3, Task 8
**Why:** parity gate PASSED on settled day 2026-07-03 (exact match, every
traffic-bearing site). This executes the parent plan's Phase 2 WITH the tech-lead's
2026-07-04 amendments (research doc §3). The deploy itself is human-timed — see
Task 13's checklist.

1. `src/dashboard/site-live.ts`: `const FLUSH_TABLE = "rollup_daily";`
2. Update every test assertion that reads `rollup_daily_shadow` (grep: two in
   `test/site-live.test.ts`, one in `test/collector.test.ts`) to `rollup_daily`.
3. `src/shared/identity.ts`: salt KV TTL → `25 * 60 * 60` with the comment: the
   date-keyed salt is only needed for its own UTC day; ~25 h self-deletion preserves the
   ~24 h cross-day-correlation window the cron's explicit delete provided. Delete the
   entire `rotateDailySalt` function. `test/identity.test.ts`: remove `rotateDailySalt`
   tests; assert the TTL passed to `kv.put` is `25 * 60 * 60`.
4. `src/index.ts`: remove the `handleScheduled` import and the whole `scheduled(...)`
   property, leaving `fetch: app.fetch` only.
5. `wrangler.jsonc`: remove the `"triggers"` line (and its comment block). Touch
   nothing else in the file.
6. `git rm test/rollup.test.ts`. **KEEP `src/rollup/index.ts`** — prepend:
   `// RETAINED (unused by the Worker) as the manual WAE→rollup recompute backstop`
   `// until the shadow-drop follow-up lands (ADR-0011). Do not delete before`
   `// rollup_daily_shadow is dropped.`
7. `src/collector/index.ts`: the fire-and-forget catch comment currently justifies
   swallowing DO errors with "WAE already holds the durable copy" — that premise dies
   with the cron. Replace with: bounded, accepted loss per ADR-0011; WAE retains the raw
   events for manual recompute via `src/rollup/index.ts` until the follow-up PR.
8. Do NOT drop the shadow table, do NOT add a migration, do NOT delete
   `src/rollup/index.ts`.

**TDD note:** this task is assertion-flips plus deletions; the "red" is the updated
tests failing before the code flips (e.g. the `rollup_daily` assertion fails while
`FLUSH_TABLE` still says shadow). Quote that transition.

**Verify:** `pnpm test && pnpm typecheck && pnpm lint` all green;
`grep -rn "rollup_daily_shadow" src/` returns only `src/rollup/index.ts`(comments, if
any) and `src/shared/schema-embed.ts` (migration 0002 stays until the follow-up);
`grep -rn "scheduled" src/index.ts` returns nothing.

---

## Task 13: ADR-0011 — cutover decision record with the amended procedure

**Files:** `docs/decisions/0011-do-rollup-cutover.md`
**Depends on:** Task 12

Write the ADR (match the format of existing files in `docs/decisions/`, e.g. ADR-0010).
Required content:

- **Context:** two-phase migration; 07-01 parity failure → ADR-0010 durability fix →
  parity PASS on settled 2026-07-03 (exact match, all traffic-bearing sites; the
  "missing" shadow sites were all zero-traffic cron zero-rows). Measured write costs
  (2026-07-04): ~7.1 DO rows-written/pageview at low traffic, dominated by the alarm
  tail (fixed in this branch → ~5×); D1 ~38.4k rows/day, ~99.6% cron — cutover cuts D1
  writes ~250× at current traffic. Cite
  `docs/research/2026-07-04-do-counters-design-iteration.md`.
- **Decision:** DO becomes the sole `rollup_daily` writer; cron trigger retired.
- **Amendments over the original plan (each with why):** (1) flip + trigger-removal in
  ONE atomic deploy — a partial deploy lets the absolute-overwrite cron clobber additive
  DO writes every 5 min; (2) `rollup_daily_shadow` and `src/rollup/index.ts` are
  retained until a follow-up PR ≥1 settled day post-cutover — rollback + reconciliation
  source; (3) deploy at a low-traffic hour, NOT within ~5 min of UTC midnight — the
  cross-midnight rollover flush would land additively on the cron-settled prior day;
  (4) accepted transition-day imperfection: ≤ one cron interval (~5 min) of pageviews
  exist only in the shadow (visitors self-heal — absolute from `seen`); optionally
  reconcile with a one-shot shadow→rollup copy for the cutover day.
- **Fire-and-forget re-justification:** the collector's swallowed DO-delivery errors
  are now bounded permanent loss (no cron reconciliation). Accepted because: losses are
  rare (DO restarts/overload), WAE still holds raw events for manual recompute while
  `src/rollup/index.ts` exists, and the alternative (per-event retry/queue) buys little
  at current scale. Revisit if measured loss appears in parity spot-checks.
- **Rollback story:** redeploy the prior Worker version; the shadow table still exists;
  `src/rollup/index.ts` can recompute `rollup_daily` from WAE for any affected days.
- **Operational checklist (the human runs this, in order):** re-apply the trigger
  removal to the LOCAL `wrangler.jsonc` (it carries real IDs and is never committed);
  `pnpm build && pnpm exec wrangler deploy` at a low-traffic hour away from UTC
  midnight; next day, spot-check `rollup_daily` vs live dashboard; close GitHub issue
  #14 and delete/disable the reminder routine; ≥1 settled day later, open the follow-up
  PR (drop `rollup_daily_shadow` + migration `0003` + delete `src/rollup/index.ts` and
  the retained comment).

**Verify:** file exists, numbered 0011, `pnpm lint` (if it covers markdown) or n/a;
internal links resolve.

---

## Task 14: Resolve roadmap O5 with the measured free-tier range

**Files:** `docs/specs/2026-07-03-feature-roadmap.md`
**Why:** O5 held the free-tier ceiling open pending real `rows_written`. Measured + 
modeled answer (research doc §2): the multiplier is traffic-shape dependent, so publish
a RANGE, not a point.

1. Locate open question **O5** in the roadmap spec and mark it RESOLVED (2026-07-04):
   publishable figure is **~500k pageviews/month on Workers Free as the safe floor,
   up to ~0.9M for typical multi-page/returning-visitor traffic**; binding limit is DO
   SQLite rows-written (100k/day free), not WAE. Cite
   `docs/research/2026-07-04-do-counters-design-iteration.md` §2 and note the ~5×/pv
   post-Task-3 multiplier assumption.
2. If the roadmap's C3 (or wherever the flat 0.9M appears) states a single number,
   amend it to the range with the same citation. Touch nothing else in the spec.

**Verify:** the spec renders sanely (`git diff` review); no other sections modified.

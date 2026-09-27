# 0013 — The SiteLive DO owns each site's daily identity salt

- **Date:** 2026-09-27
- **Status:** accepted (2026-09-27). The option, the PITR trade-off (§7) and the
  WAE-on-failure rule (§4) were all decided by the human. Not yet implemented.
- **Owner:** cloudflare-tech-lead
- **Relates to:** amends ADR-0002 §Decision step 5 ("Daily salt in KV, rotated at UTC midnight
  by the Cron Worker"); builds on ADR-0010 (durable `SiteLive` state, single alarm slot) and
  ADR-0011 (cron retired; the DO is the only source of dashboard numbers). Touches
  `docs/privacy.md` §2, `README.md`, ADR-0006 (Deploy-button provisioning list), `wrangler.jsonc`.
- **Evidence base:** Cloudflare docs retrieved **2026-09-27** (URLs are inline with each claim);
  code read at `origin/main` `1f5f677`.

## Context

### The bug (verified)

The cookieless visitor id is `vid = HMAC(IDENTITY_HMAC_SECRET, salt | ip | ua | site_id)`
(`src/shared/identity.ts` `deriveVid`). The salt is a random 32-byte value per UTC day. Two
things combine to produce the bug:

- `getDailySalt` (`src/shared/identity.ts:68`) does a KV `get`. On a miss it mints a random salt
  and `put`s it, with the TTL anchored to one hour after the day ends. It returns the salt it
  minted, not a value read back from KV.
- `getCachedDailySalt` (`src/collector/index.ts:95`) keeps that value in a module-level
  `saltMemo` for the rest of the UTC day, so each isolate holds one salt for as long as it
  lives.

KV is eventually consistent. "Changes may take up to 60 seconds or more to be visible in other
global network locations", and "negative lookups indicating that the key does not exist are
also cached, so the same delay exists noticing a value is created as when a value is changed"
([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). KV also offers
no atomic get-or-create: "KV is not ideal for applications where you need support for atomic
operations" (same page). So right after 00:00 UTC, isolates in different colos, or two
isolates in the same colo that race, can each miss, each mint a different salt, and each
keep their own for the day. The same visitor then gets a different `vid` depending on which
isolate serves each beacon. A probe reproduced two different salts and vids for one day.

### Why it matters now

The daily Cron used to mint the salt ahead of each day. ADR-0011 retired it, so the
first-request race is now the normal way a day's salt is created. Since ADR-0011, the
`SiteLive` DO's `seen` set is the only source of dashboard visitor counts; the WAE `vid`
(blob1) survives only as a manual-recompute backup. The DO counts a split visitor twice, which
inflates **visitors**, deflates **views/visitor**, and skews **bounce**. The impact is small
at current traffic. It becomes material for busy sites with a global audience, where many
isolates in many colos cold-start within KV's propagation window after midnight.

The requirement comes from ADR-0002 and the privacy thesis: **exactly one salt per site per
UTC day, and that salt is deleted shortly after its day ends.** The second part is the
deletion property, which makes past-day ids unverifiable.

## Decision

**Each site's `SiteLive` DO (`idFromName(site_id)`, already one per site) generates, stores and
expires that site's daily salt in its own SQLite storage. The collector fetches the salt from
the DO once per isolate per (site, day) and memoizes it. The `SALT` KV namespace is removed.
Deleted salts stay recoverable for up to 30 days through Cloudflare PITR, and that is an
accepted trade-off (§7).**

### 1. Storage and the get-or-create contract

- Add a new table: `salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL) WITHOUT ROWID`. Create it
  synchronously in the constructor next to `SEEN_DDL`.
- Add an RPC method, `getSalt(day: string): string`, that runs a **synchronous** `SELECT`,
  then an `INSERT` only if no row exists, then returns the stored value. Nothing is awaited
  between the read and the write.
  - Durable Objects "are single-threaded and cooperatively multi-tasked"
    ([What are DOs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)),
    and `sql.exec()` is synchronous
    ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)).
    A get-or-create with no `await` between the two steps therefore cannot interleave with
    another request.
  - This does not depend on input gates. That matters because `flush()` already leaves the
    input gate open across D1 awaits (`site-live.ts:233-237`).
  - Result: **exactly one salt per site per day**. "Each Durable Object has a globally-unique
    name" (same page), so every collector isolate worldwide reaches the same object.
- **Validity window.** `getSalt(day)` serves or creates a salt only when the DO's own clock is
  inside `[start(day), end(day) + GRACE)`, with `GRACE = 10 min`. Outside that window
  it throws.
  - This rule keeps a **deleted past-day salt from ever being re-minted** by a late or skewed
    request. A re-minted salt would split that day's vids and would also recreate secret
    material the design promised to destroy.
  - **No early issuance.** A request for day D+1 before the DO's clock reaches `start(D+1)`
    throws and takes the §4 failure path (WAE point with `vid = ""`). An earlier draft allowed a
    5-minute lead for fast collector clocks, but that lets one visitor hold D's salt on an
    accurate isolate and D+1's salt on a fast one *before* midnight, which is the split this
    ADR exists to prevent. Cloudflare machine clocks are NTP-synced, so the rejected window is
    expected to be milliseconds wide.
  - `GRACE` replaces the old KV TTL of +1 h. Retention gets shorter, not longer. See the
    note on the collector memo in §2.
- The salt is still 32 bytes from `crypto.getRandomValues`, hex-encoded. Only where it is
  created and stored moves.

### 1a. One designated event day, end to end

The collector computes `day = utcDay(receiptTime)` **once** per beacon and uses that same value
for three things: the `getSalt(day)` call, the memo key, and a new `day` field in the DO
`/event` body. `SiteLive.recordEvent()` stops deriving the rollup day from its own
`utcDay(new Date())` (`site-live.ts:173`) and uses `e.day` instead.

- **Why.** Otherwise a beacon received at 23:59:59.9 on day D gets D's salt (inside `GRACE`)
  but is rolled up under D+1 by the DO's clock. The next D+1 beacon from the same visitor uses
  D+1's salt, so one person becomes two vids inside D+1's rollup. Carrying one day through
  identity and rollup makes the salt and the bucket agree by construction.
- **Validation in the DO.** `recordEvent` accepts `e.day` only if a salt row for `e.day` exists
  in this DO (that is, the day was issued a salt here and has not been deleted). Otherwise it
  drops the event and logs it. This also rejects forged or stale days: a day whose salt has
  been deleted can never gain new rollup rows.
- **WAE carries the day explicitly.** A new blob, `eventDay` (blob14, appended after
  `propsJson`, so existing slots do not move), stores the same designated day. WAE's own
  timestamp is the write time, which after §5 is inside `waitUntil` and can fall after midnight
  for a beacon received before it; a manual WAE recompute must bucket by blob14, not by
  timestamp, so it agrees with `rollup_daily`. `WAE_BLOB_SLOTS` and spec §4.1 gain the slot.

### 2. Collector memo

- Replace the single-entry `saltMemo` with a map keyed by `siteId`, where each entry is
  `{ day, salt }`. A hit requires `entry.day === today`.
- Bound the map like `siteCache`: reset it when it reaches `SITE_CACHE_MAX`. Also drop entries
  for other days whenever the collector's `today` changes, so yesterday's salt does not stay
  in isolate RAM longer than it has to.
  - An idle isolate that never serves another beacon still holds its last salt until it is
    evicted. The KV design had the same exposure.
- Only site ids that have already passed the D1 existence check and the origin check reach
  the memo, so bogus ids cannot fill it and cannot create DOs.

### 3. Alarm multiplexing: one slot, a minimum over deadlines

A DO "is able to schedule a single alarm at a time", and calling `setAlarm` when one is
already set "will override the existing alarm"
([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). The DO now has two
deadlines to share that one slot:

- the **flush tick**, `now + 15 s` while `pending` is non-empty (ADR-0010), and
- the **salt expiry**, `end(day) + GRACE` for the oldest stored salt.

**Rule: the armed alarm is always the earliest outstanding deadline.** Implement this with one
helper, `armBy(t)`: `cur = await getAlarm(); if (cur === null || cur > t) await setAlarm(t)`.

- **`handleEvent`** changes from "arm only if no alarm is set" to `armBy(now + 15 s)`.
  **This change is load-bearing.** With the current code, a salt-expiry alarm armed hours
  ahead would make `getAlarm() !== null`, no flush tick would be armed, and pageviews would
  sit un-flushed until the salt deadline. That would not lose data (the state is durable per
  ADR-0010), but the dashboard would go stale for hours.
- **`getSalt`**, when it mints a salt, calls `armBy(end(day) + GRACE)`.
- **`alarm()`** runs the expired-salt `DELETE` **first**, in its own `try`, before any other
  step: every salt whose `end(day) + GRACE <= now` is removed. It then runs its existing steps
  (flush, evict stale live visitors, prune `seen`), each failure caught and logged rather than
  thrown. It **always** re-arms before returning, in a `finally`: at
  `min(pending > 0 ? now + 15 s : ∞, earliest remaining salt deadline)`, and if the salt
  `DELETE` itself failed, at `now + 60 s` so deletion is retried.
  - **Why not rely on platform retries.** Alarms are retried "up to 6 retries" with
    exponential backoff when `alarm()` throws, then dropped (Alarms doc), and Cloudflare's
    guidance is to catch and schedule a new alarm instead. If a D1 outage made the flush throw
    for all six retries, a salt delete sequenced after it would never run, and on a site with
    no further traffic nothing would re-arm it. Salt deletion must not depend on D1 health.
  - The salt delete is idempotent and synchronous SQLite; it is the step least likely to fail,
    which is why it goes first.
- **Constructor rehydrate** already arms a flush when it finds `pending` with no alarm. It now
  also runs `armBy(earliest salt deadline)` whenever a salt row exists.
- **Lazy backstop.** `getSalt` and `handleEvent` also run the same expired-salt `DELETE`, which
  is synchronous and writes 0 rows when nothing matches.
  - The alarm is the primary deletion path. It covers a site that gets no traffic after
    midnight, which the human explicitly required.
  - The lazy path is a second line only. Because `alarm()` always re-arms (above), the alarm is
    not expected to be dropped; the lazy path covers a DO that was evicted between arming and
    firing and is then woken by traffic.
- **Cost of the multiplexing.**
  - `setAlarm()` is billed as one row written
    ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  - New rows: at most one mint-time `setAlarm` per day, plus one re-arm to the salt deadline
    each time a flush drains `pending`. That is about +1 row per burst of traffic, against the
    roughly 5 rows written per pageview that ADR-0011 measured. Negligible.
  - Alarm invocations count as DO requests (same page), which adds at most one salt-expiry
    alarm per site per day.

### 4. Failure mode: no vid and no DO delivery, but the WAE point is still written

If `getSalt` fails, the collector **still writes the WAE data point with `vid = ""`** (blob1
empty) and **skips the DO `/event` delivery**. It never falls back to KV or to any other salt,
because mixing salts is exactly the bug this ADR fixes.

- **Why keep the WAE write.** Before this change, a DO failure lost only the rollup, and WAE
  kept the raw event for a manual recompute (ADR-0011). Dropping the whole event would have
  removed that backstop for exactly these events. With an empty vid they stay in WAE, so
  pageviews and every other dimension can still be recomputed.
- **Why the visitor count stays clean.** An empty vid is not a real visitor, and it never
  reaches the DO's `seen` set. Any manual WAE recompute of visitors must exclude
  `blob1 = ''`, because otherwise `COUNT(DISTINCT blob1)` would count them as one extra
  visitor. No code queries blob1 today (checked at `1f5f677`).
- **Why the DO delivery is skipped.** The DO's `seen` set needs a real vid. Sending the
  pageview without one would split pageviews from visitors in `rollup_daily`. The consequence
  is that the dashboard undercounts pageviews for those events until someone recomputes them
  from WAE. That is the same bounded, accepted loss as ADR-0011's fire-and-forget delivery.

- Cloudflare's guidance is that errors with `.retryable` "are suggested to be retried if
  requests to the Durable Object are idempotent", using a new stub for each attempt, and that
  errors with `.overloaded` "should not be retried"
  ([DO error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)).
  `getSalt` is idempotent, so the collector **retries once on `.retryable`** with a fresh stub
  and never retries on `.overloaded`.
- This failure only affects isolates that have not yet memoized the day's salt. Isolates that
  already have it keep working during a DO outage, and during such an outage the rollup
  delivery would fail anyway.
- **A stalled fetch is a failure too.** The collector races `getSalt` against a **5 s
  timeout**. On timeout it takes the same path as a thrown error: WAE point with `vid = ""`,
  no DO delivery. Without the timeout, an RPC that never settles is cancelled when
  `ctx.waitUntil` hits its 30 s limit, the catch never runs, and the event is lost from WAE as
  well. 5 s is far above a healthy first-access round trip ("up to a few hundred
  milliseconds") and leaves 25 s of budget for the WAE write.
- Log each salt failure (error, timeout, or `.overloaded`) so the rate can be monitored.

### 5. Beacon latency: identity work moves into `ctx.waitUntil`

**Decision:** the collector responds 204 once the synchronous checks have passed: validation,
bot drop, the cached site lookup, the origin check and the secret guard. The rest runs in one
`ctx.waitUntil` task, in this order: salt fetch → `deriveVid` → `WAE.writeDataPoint` → DO event
delivery. If the salt fetch fails, the same task writes the WAE point with `vid = ""` and stops
there (§4).

- **Reason.** The first `getSalt` in an isolate is a cross-colo DO round trip. For named DOs,
  "the first time you get a Durable Object stub based on an ID derived from a name … this
  round-the-world check can take up to a few hundred milliseconds"
  ([DO namespace](https://developers.cloudflare.com/durable-objects/api/namespace/)). Beacons
  use keepalive and are fire-and-forget, so visitors would not notice. Server-side and no-JS
  callers, plus request-duration metrics, would.
- **The client sees no change.** Every infrastructure failure after the site lookup already
  returns 204 through the catch at `collector/index.ts:414`. The 204 has never meant "written".
- **The waitUntil budget is generous.** Work in `waitUntil` can run for up to 30 s after the
  response, and "If any Promises have not settled after 30 seconds, they are canceled"
  ([Context API](https://developers.cloudflare.com/workers/runtime-apis/context/)). One DO RPC
  plus one HMAC fits easily.
- **Error handling moves too.** The async task must `catch` and log on its own, because it runs
  outside the handler's try/catch.
- The deliberate non-204 responses (404, 403, 413, 503) stay synchronous, as they are today.
- **This amends the synchronous-WAE contract.** ADR-0002 and the technical spec
  (`docs/specs/2026-06-21-technical-spec.md` §3, step 12 "Write to WAE (synchronous)") state
  that the WAE write happens before the 204. After this ADR it happens in `waitUntil`, so a
  Worker crash or `waitUntil` cancellation after the 204 can now lose the WAE point too. The
  §4 timeout keeps the one foreseeable stall inside the budget; the residual loss (runtime
  eviction mid-task) is accepted, and both documents are updated in the implementation PR.

### 6. Binding removal and rollout for existing deploys

- **Removals.** `SALT` is removed from `wrangler.jsonc` `kv_namespaces` and from `Env`
  (`src/shared/types.ts`). `getDailySalt` is deleted. `deriveVid` and `utcDay` stay.
- **Deploy button.** It now provisions one fewer resource (ADR-0006).
- **Existing deploys.**
  - The old KV namespace stays in the account, unused. `wrangler deploy` does not delete it.
  - The only value it can hold, the current day's salt, expires through its existing TTL
    within about 25 h.
  - The upgrade notes should tell operators they can remove it with
    `wrangler kv namespace delete` at any time after that. Nothing reads it.
- **No DO migration tag is needed.** `SiteLive` is already a SQLite class, and the new table
  is created in the constructor.
- **Cutover-day discontinuity: accepted.**
  - While the rollout is in progress, old-version isolates use the KV salt and new-version
    isolates use the DO salt. After it completes, only DO salts are used.
  - A visitor seen both before and after the switch on cutover day gets two vids, so they may
    be counted twice **on that one day only**.
  - Deploying at exactly 00:00 UTC does not remove this, because rollouts are not atomic
    across the fleet. Deploying early in the UTC day (after about 00:10) *minimizes* the
    affected population, since few of the day's visitors have been seen yet.
  - ADR-0011 Amendment 3's warning against deploying near midnight guarded against the retired
    cron's absolute writes. The cron is gone and `pending` is now day-keyed (v2 `FlushState`),
    so that hazard no longer applies. The 10-minute margin is only to let the new DO salts be
    minted cleanly.
  - This is documented rather than engineered away. It is a one-time, one-day,
    visitors-only inflation.

### 7. Accepted trade-off: PITR keeps a deleted salt recoverable for 30 days

SQLite-backed DOs support point-in-time recovery "to any point in time in the past 30 days",
and it applies "to the entire SQLite database contents, including both the object's stored SQL
data and stored key-value data"
([SQLite storage API — PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
retrieved 2026-09-27). So the alarm's `DELETE` removes a salt from the live database, but the
salt is still recoverable from the recovery log for up to 30 days.

**The human accepted this trade-off on 2026-09-27.** Its bounds:

- **Who.** Only someone who can deploy code to the Worker in the owner's Cloudflare account.
  PITR is reached only through the DO's own API (`getBookmarkForTime` /
  `onNextSessionRestoreBookmark`). Site visitors and dashboard viewers cannot reach it, and
  neither can anyone else without account access.
- **What it allows.** To confirm that a specific person visited on a specific past day, that
  party would need four things: the restored salt, `IDENTITY_HMAC_SECRET`, the person's exact
  IP and User-Agent for that day, and the vids WAE holds. With all four, they can recompute
  the person's vid and look for it.
- **What it does not allow.**
  - Recovering an IP or UA from a vid.
  - Linking one person across days or across sites.
  - Doing anything after 30 days, when the recovery log ages out.
- **Cost of a restore.** It rolls back the whole DO, including `seen` and `flushstate`, so it
  is deliberate, disruptive and visible.
- **Compared with the options.**
  - KV's TTL made the salt unrecoverable about 1 h after its day ended. I found no documented
    KV restore feature, but I have not proven KV has none.
  - Option 2 (`HMAC(secret, day)`) makes every past salt recomputable **forever**, and was
    rejected because that exposure is unbounded.
  - This design's exposure is operator-only and ends at 30 days.
- **No mitigation inside the DO.** Every kind of durable DO storage is covered by PITR. A salt
  kept only in memory would be lost when the DO hibernates after 10 s (ADR-0010), which would
  bring the split-salt bug back.

## Alternatives considered

The requirement for every option: one salt per site per day, visible to every isolate
worldwide, deleted shortly after the day ends, with no new always-on cost and no new
provisioned resource.

**1. Keep KV; after `put`, read the value back and memoize what was read.** This fixes only
races within one colo. Two colos that both miss still each read back their own write, and each
colo's cached negative lookup keeps the other's value invisible for up to 60 s or more (KV doc
above). KV has no compare-and-set, so there is no correct KV-only fix. **Rejected: does not
fix the bug.**

**2. Deterministic salt, `salt = HMAC(secret, day)`.** Nothing is stored, so there is nothing
to race. But it destroys ADR-0002's deletion property permanently. Anyone holding
`IDENTITY_HMAC_SECRET` plus a known IP and UA could recompute a person's vid for **any past
day**, then confirm presence against the vids retained in WAE (blob1), or against any
exported copy. That is a retrospective confirmation attack with no time bound.
**Rejected: voids the privacy thesis.**

**3. The DO owns the salt (chosen).** It is strongly consistent because a single-threaded,
globally unique object performs a synchronous get-or-create. It adds no new resource, removes
one, and makes the salt genuinely per-site. The cost is one DO request per isolate per site per
day, plus an alarm-multiplexing rule and a DO dependency for isolates without a memoized salt.

**3b. The DO derives the vid itself (considered during review, not adopted).** The collector
would send raw IP and UA in the existing per-event DO call, and the DO would return the vid.
That removes the extra round trip and the memo. It was not adopted for three reasons:

- The raw IP would leave the collector isolate and appear in a request body, which widens its
  in-flight exposure (DO logs, error payloads). Sending a pre-salt HMAC instead is worse: it is
  a stable cross-day pseudonym in flight.
- It makes **every** WAE write depend on DO availability.
- It serializes the WAE write behind a DO round trip on every event, not only the first in
  each isolate.

| axis | 1 KV read-back | 2 HMAC(secret, day) | **3 DO-owned (chosen)** |
|------|----------------|---------------------|-------------------------|
| One salt per site/day | ❌ same-colo only | ✅ | ✅ |
| Deletion property | ✅ ~1 h after day end (KV TTL) | ❌ unbounded | ⚠️ ~10 min after day end, but recoverable by an operator via PITR for 30 d (§7, accepted) |
| Provisioned resources | KV ns (kept) | none (KV removed) | none (KV removed) |
| Added requests | 0 | 0 | 1 DO req / isolate / site / day |
| New failure mode | none | none | un-memoized isolate writes WAE with `vid=""` and skips the DO while the DO is down |
| Complexity | trivial | trivial | alarm multiplexing + memo map |
| Lock-in | KV | none | DO (already load-bearing) |

## Consequences

**ADR-0002, amended.** Step 5 changes as follows. The "daily salt in KV, rotated at UTC
midnight by the Cron Worker (yesterday's salt deleted)" wording is replaced by: *the daily salt
is a per-site random value owned by that site's `SiteLive` DO, created on first use, deleted by
the DO alarm about 10 min after its UTC day ends*. The Consequences line "Daily-salt rotation is
a Cron dependency" is superseded: salt availability is now a DO dependency, per §4.

**Correction to ADR-0002.** ADR-0002's "Site-scoped salt" wording was **inaccurate**. Until
this ADR, the implementation used **one global salt per day for all sites** (a single KV key,
`salt:<day>`). The unlinkability of one person across two sites came entirely from `site_id`
being in the HMAC message, and that already held. Under this ADR, salts really are per-site.
That adds defense in depth, but it does not change the unlinkability claim. Because salts are
now per-site, the salt-fetch cost scales with **isolates × sites** rather than with isolates
alone (see Cost).

**ADR-0011, amended.** ADR-0011 already made the DO the sole source of dashboard numbers. This
ADR also makes the DO the source of identity. Two consequences follow:

- Amendment 3 (don't deploy near midnight) no longer applies (§6).
- The "WAE retains raw events, so any day can be recomputed" backstop still covers events
  whose salt fetch failed. They are written to WAE with `vid = ""` (§4). Their pageviews are
  recomputable, but their visitors are not, and they never reach the DO rollup.

**Privacy doc.** `docs/privacy.md` §2 is rewritten on this branch in a separate commit. It
now says:

- the salt is per-site and stored in the site's DO;
- it is deleted about 10 min after its day ends; and
- it is recoverable via PITR for up to 30 days by someone with deploy access, with what that
  does and does not allow (§7).

**Cost** (DO prices from the [pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/),
last updated Aug 25 2026; KV prices from the
[Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/), last
updated Aug 28 2026; both retrieved 2026-09-27):

- **DO requests.** Free: 100k/day. Paid: 1M/month included, then $0.15/M. "HTTP requests, RPC
  sessions, WebSocket messages, and alarm invocations" all count, and "Each RPC session is
  billed as one request".
- **Added.** One `getSalt` RPC per isolate per site per day, plus at most one expiry alarm per
  site per day. Example: 1,000 isolates/day × 1 site ≈ 30k requests/month ≈ **$0.005** at
  overage rates, and in practice absorbed by the 1M included.
- **Removed.** One KV read per isolate per day (Paid: $0.50/M after 10M included) and about
  one KV write per day.
- **Net ≈ zero for a self-host with a handful of sites**, but the comparison is not
  like-for-like. The old salt was one global value, so its cost was one KV read per isolate
  per day **regardless of site count**. The new cost is one DO request per isolate **per
  site** per day, so it scales with **isolates × sites**. Example: 50 busy sites × 1,000
  isolates/day ≈ 1.5M requests/month ≈ $0.08/month beyond the included 1M. That is still
  cents, but it is no longer independent of site count.
- **DO storage.** One salt insert and one delete per site per day, plus the `setAlarm` rows in
  §3. Immaterial next to the per-pageview `seen` writes.
- **Free-plan ceiling.** See R3.

**What we're committed to.** The DO is on the identity path. The `alarm()` handler is now
shared by three duties: flush, `seen` prune, and salt expiry. Any future change to alarm
arming must go through `armBy()` and respect the minimum-over-deadlines rule.

**Testing strategy** (Vitest + `@cloudflare/vitest-pool-workers`; `runInDurableObject` and
`runDurableObjectAlarm` are already used by `test/site-live.test.ts`). Give `getSalt` and the
expiry sweep an injectable `now` so tests can control day boundaries without depending on
whether fake timers reach DO code.

1. **Concurrent first fetch.** Fire `Promise.all` of 20 `getSalt(day)` calls on one stub. All
   return the same value, and the `salt` table has exactly one row for `day`.
2. **Per-site.** Two sites on the same day get different salts. Two collector isolates, which
   can be simulated by resetting the memo, get the same salt for the same site.
3. **Day rollover.** `getSalt(D+1)` after midnight mints a new salt. The collector memo misses
   on the new day and drops entries for the old day. The vid for the same IP and UA changes
   across the boundary.
4. **Window.** `getSalt(D)` after `end(D) + GRACE` throws and does **not** insert a row. A
   deleted day cannot be re-minted.
5. **The alarm deletes old salts with no further traffic.** Mint D's salt, record no events,
   advance past `end(D) + GRACE`, run `runDurableObjectAlarm`: the row is gone and no alarm
   remains armed.
6. **Multiplexing.** With a salt-deadline alarm armed hours ahead, an event arms a 15 s flush
   (`getAlarm()` ≤ now + 15 s). After the flush drains, the alarm is re-armed to the salt
   deadline, not null. **Update the existing assertion at `test/site-live.test.ts:560`**
   (`getAlarm()` is null after drain): it holds only when the DO holds no salt.
7. **Cold-start re-arm.** A DO with a salt row and no alarm re-arms the salt deadline in
   rehydrate.
8. **Fetch failure keeps the WAE point with an empty vid.** Stub `getSalt` to throw. Assert:
   - exactly one WAE data point is written, with blob1 `""` and every other field populated;
   - no DO `/event` is delivered;
   - the response is still 204;
   - no KV is touched;
   - a `.retryable` error is retried once, and an `.overloaded` error is not retried.
9. **Replace** the KV-specific tests: `test/identity.test.ts` `getDailySalt` and
   `test/collector.test.ts:744` (`env.SALT` spy). The collector test instead asserts one DO
   `getSalt` per (site, day) per isolate.
10. **Salt deletion survives a failing flush.** Make the D1 flush throw on every alarm run,
    record no further traffic, advance past `end(D) + GRACE`, and run the alarm: D's salt row
    is gone, the alarm did not throw, and an alarm is still armed (flush retry or salt
    deadline). Also force the salt `DELETE` to fail once: the alarm re-arms at `now + 60 s`
    and the next run deletes it.
11. **One event day end to end.** A beacon whose receipt time is 23:59:59 UTC on day D, with
    the DO clock already on D+1: the salt used is D's, and the rollup row lands under D, not
    D+1. An event whose `day` has no salt row in the DO is dropped and not rolled up.
12. **Stalled fetch.** Stub `getSalt` to never settle: after the 5 s timeout the WAE point is
    written with blob1 `""`, no DO `/event` is delivered, and the task settles well inside the
    30 s `waitUntil` limit.

## Recorded risks and monitoring

The human has resolved the review's open questions. R1 (PITR) is accepted as §7. R4 (write
WAE on salt failure) is adopted as §4. The cost-scaling correction is folded into Consequences.
The doc follow-ups (privacy §2, README, ADR-0006, the ADR index) are done in separate commits on
this branch. The `wrangler.jsonc` comments are left to the implementation PR, which removes the
binding there.

The remaining risks below are accepted and monitored. The original R-numbers are kept so
earlier references still resolve.

- **R2 (resolved by §1a): two clocks.** The draft let the collector pick the salt day and the
  DO pick the rollup day independently, which could split a visitor near midnight. §1a now
  carries one designated day from the collector through identity and rollup, and the DO only
  accepts days it holds a salt for.
- **R3: Worst-case doubling of DO requests on the Free plan.** Low-traffic sites may hit fresh
  isolates on most beacons, so the memo hit rate could approach 0 and DO requests approach 2×
  events.
  - This does not matter on Paid ($0.15/M).
  - On Free, the 100k/day DO request cap would then bind at about 50k events/day instead of
    about 100k. The Workers Free cap is also 100k requests/day
    ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)), so the
    ceiling was previously set by Workers requests.
  - **Action:** log memo hits and misses in observability and measure after rollout.
  - **Escape hatch if it bites:** one RPC session that fetches the salt and then records the
    event through an `RpcTarget` stub. Calls on "the returned stub are part of the same RPC
    session" and are billed as one request (pricing page). It is more complex, so it is not
    done up front.
- **R5: DO placement adds latency for distant isolates.** The DO lives "close to where it is
  first requested"
  ([What are DOs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)).
  Each far-away isolate pays one cross-region round trip per day. That is harmless inside
  `waitUntil` (§5) and would be the main argument against keeping identity on the synchronous
  path.
- **R6: Per-object throughput.** A DO has "a soft limit of 1,000 requests per second"
  ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
  `getSalt` adds only a small per-isolate trickle, so the per-event `/event` delivery stays
  the binding constraint. The salt changes nothing here, but a midnight burst of cold isolates
  now hits the DO with `getSalt` and `/event` together. Watch for `.overloaded` right after
  00:00 on the busiest site.

# Task 5 report — `docs/privacy.md` becomes the canonical data-policy doc

## What I built

Rewrote `docs/privacy.md` from scratch as the canonical, source-linked data
policy, following the structure of `docs/briefs/2026-07-05-data-policy-page-brief.md`
§"Page structure" (that brief targets the marketing page; this doc is its
source of truth, so it is documentation-register, not marketing copy).

Sections, in order:

1. **What Skopia stores** — split into "what the browser sends" (from `Beacon`
   in `src/shared/types.ts` and `send()` in `src/script/skopia.ts`) and "what
   the collector derives and stores" (the exact `WaeEvent` field list from
   `src/shared/types.ts`, cross-referenced against `handleCollect` in
   `src/collector/index.ts`). Explicit "absent from storage" list: no raw IP,
   no cookies, no localStorage, no cross-site identifier, no page title.
2. **The visitor id, precisely** — the HMAC formula verbatim from
   `deriveVid`/`getDailySalt` in `src/shared/identity.ts`: key =
   `IDENTITY_HMAC_SECRET`, message = `daily_salt|ip|user_agent|site_id`, first
   8 bytes → 16 hex chars; 32-byte CSPRNG daily salt in KV with a TTL anchored
   to the UTC day boundary (~1 h after the day ends), not to creation time.
3. **What this means the site owner can and cannot know** — "cannot know"
   given equal visual weight to "can know" (monthly uniques, cross-day
   journeys, returning-visitor rate beyond a day), stated as design intent,
   plus known accuracy limits (shared IP+UA under-counts; VPN hopping
   over-counts).
4. **Where data lives** — WAE's hard, platform-level 90-day raw retention vs.
   D1 `rollup_daily` aggregates thereafter, all inside the owner's own
   Cloudflare account.
5. **What Skopia does NOT collect** — bulleted absence list, updated from the
   prior version.
6. **Source links** — the three mandated repo-relative links
   (`src/shared/identity.ts`, `src/collector/index.ts`, `migrations/`) plus
   the additional files every specific claim in §1/§4 actually depends on
   (`src/shared/types.ts`, `src/script/skopia.ts`, `src/dashboard/site-live.ts`,
   `src/shared/cf.ts` inline).
7. Consent/regulation note (kept, reworded to avoid banned phrases) + a
   closing line inviting scrutiny/issues, mirroring the marketing brief's
   footer note.

### Factual corrections made while verifying against source

While tracing every claim to its implementing code (per the brief's "every
claim links the actual source file" rule) I found two claims in the prior
`docs/privacy.md` that no longer matched the code and fixed them:

- **"Document title" was listed as sent/stored.** `Beacon.ti` exists in
  `src/shared/types.ts` as a reserved field, but `src/script/skopia.ts`'s
  `send()` never sets `b.ti`, and the collector never reads it into
  `WaeEvent`. No page title is sent or stored today. Documented as a reserved
  wire-format field the script doesn't use.
- **"Aggregates ... computed by a cron job" and "retention governed by
  `RETENTION_DAYS`".** Per ADR-0011 the cron was retired; `rollup_daily` is
  now written incrementally, per event, by the `SiteLive` Durable Object
  (`src/dashboard/site-live.ts`). Separately, `RETENTION_DAYS` is declared in
  `Env`/`wrangler.jsonc` but is not read anywhere in `src/` — it does not
  currently govern anything, so the old claim that owners can "adjust it to
  your needs" was false. Replaced with the accurate, brief-aligned framing:
  WAE's 90-day retention is a hard Cloudflare platform cap (not a Skopia
  setting), and D1 rollups persist as durable long-range history since they
  aren't subject to that cap.

### Register-rule compliance (Global Constraint 10)

- Grep-verified absent: `GDPR compliant`, `anonymous`, `impossible to track`,
  and (to be safe) any bare use of the word "impossible" or "self-hosted".
- Every mechanism claim in §1/§2/§4 links its actual source file (verified
  every relative link resolves to a real file — see Verification below).
- §3 gives the "cannot know" list equal prominence to the "can know" line
  (both are top-level bold callouts in the same section, cannot-know listed
  second and more fully elaborated, consistent with the brief's "state what
  the design cannot tell the owner as prominently as what it can").
- "Skopia is self-deployed on your own Cloudflare account" replaces the prior
  "you self-host Skopia" phrasing.

## Files changed

- `docs/privacy.md` (rewritten; 190 insertions, 83 deletions)

## Verification

This is a docs-only change; there is no code path to unit-test. Verification
was: (1) grounding every claim in the actual source (read `src/shared/identity.ts`,
`src/collector/index.ts`, `src/shared/types.ts`, `src/shared/cf.ts`,
`src/script/skopia.ts`, `src/dashboard/site-live.ts`, `migrations/0001_init.sql`,
ADR-0002, ADR-0011 before writing), (2) grep-verifying banned phrases are
absent, (3) resolving every relative markdown link against the filesystem, and
(4) running the project's typecheck/test suite to confirm the docs-only change
didn't regress anything (required by Global Constraint 1).

```
$ grep -in "gdpr compliant\|anonymous\|impossible to track\|impossible\b\|self-hosted\b" docs/privacy.md
(no output — all banned phrases absent)
$ grep -n "self-deployed" docs/privacy.md
9:Skopia is self-deployed on your own Cloudflare account — everything below runs
```

Link resolution (every `../`-relative link in the file resolved against the
filesystem):

```
OK   ../migrations/
OK   ../migrations/0001_init.sql
OK   ../README.md#generating-your-secrets
OK   ../src/collector/index.ts
OK   ../src/dashboard/site-live.ts
OK   ../src/script/skopia.ts
OK   ../src/shared/cf.ts
OK   ../src/shared/identity.ts
OK   ../src/shared/types.ts
```

Typecheck:

```
$ pnpm typecheck
$ tsc --noEmit && tsc --noEmit -p tsconfig.script.json
(clean, no output — exit 0)
```

Full test suite:

```
$ npx vitest run
 Test Files  14 passed (14)
      Tests  269 passed (269)
   Start at  10:07:41
   Duration  6.45s
```

No TDD red/green cycle applies — Global Constraint 1's TDD requirement is for
"every code task"; this task's `**Files:**` line is `docs/privacy.md` only, and
the brief's own success criteria (doc complete, every mechanism claim
source-linked, banned phrases grep-clean) are the checkable verification
surface for a docs task, which I ran above.

## Self-review

- Implemented exactly the brief's content list (stored fields, visitor-id
  mechanism, what the owner can't know, accuracy limits, where data lives,
  the three mandated source links) — nothing extra beyond structural sections
  the brief's own referenced page structure calls for (source-links block,
  closing scrutiny-invite line), no new topics (e.g., did not add anything
  about `/share/*` — out of this task's scope).
- Did not touch `wrangler.jsonc`, migrations, or any code file.
- Verified every factual claim against the actual implementation rather than
  trusting the prior doc or the marketing brief's prose — this caught two
  stale claims (document title, cron-based rollups/`RETENTION_DAYS`) that
  would otherwise have shipped as inaccuracies in the doc whose entire job is
  to be accurate.
- `git status` shows only `docs/privacy.md` modified; nothing else staged.

## Concerns

- I linked `../README.md#generating-your-secrets` for the `IDENTITY_HMAC_SECRET`
  generation instructions rather than `install.md`, because as of this
  worktree's base commit that walkthrough still lives in `README.md` (Task 6
  is the one that moves it into `docs/install.md` and leaves a one-line
  pointer in the README, per the plan). If Task 6 lands first and this link
  should instead point at `install.md`, that's a one-line follow-up edit — I
  did not want to link to content that doesn't exist yet in isolation.
- The `571 B gzipped` script-size figure that appears in the marketing-page
  brief and several other docs is out of this task's explicit scope (Task 5's
  content list doesn't mention script size), so I left it out entirely rather
  than guess at a number likely to shift; a build I ran locally to check
  measured 554 B gzipped today, which doesn't match either the old doc's
  "< 2 KB" language (still true, just imprecise) or the 571 B figure quoted
  elsewhere — worth reconciling in whichever task actually owns that number
  (looks like a README/homepage task, not this one).

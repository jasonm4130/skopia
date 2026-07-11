# Task 1 report — Public overview route: `/share/:token` replaces `/public/:token`

**Worktree:** `/Users/jasonmatthew/Work/Git/skopia-wt-launch-t1`
**Branch:** `sdd/t1`
**Head SHA:** `a13917805b4cfb77b6ac3f315b69b09139a3aaf8`

## Missing ADR-0012 (noted, not blocking)

The plan (`docs/plans/2026-07-05-launch-readiness.md`) and its global constraints
reference `docs/decisions/0012-public-share-link-dashboard.md` as "FINAL — implement,
do not re-derive." I verified across all local branches (`main`, `sdd/t4`, `sdd/t5`)
and `git log --all` that this file was never committed — the tech-lead ADR write-up
described in the spec's Sequencing step 1 didn't land. I did not treat this as a
blocking gap: every concrete requirement the brief attributes to "ADR §2" / "ADR §4"
(header list, cache-key format, token shape regex, what publicNav/publicLayout must
reuse and must never leak) is already fully enumerated in Global Constraints 4-6 and
the Task 1 brief itself. Where the brief left a genuine implementation detail
unspecified (exact CSP directive list, "Powered by Skopia" link target, mobile
layout), I derived it by mirroring the existing root `securityHeaders` middleware
(`src/shared/security-headers.ts`) and `appLayout`/`sidebar` patterns already in
`src/dashboard/index.ts` rather than inventing new conventions — reuse over
invention, no new public API/schema/dependency decisions were required. Flagging
this for the controller since a future task may need the actual ADR text.

## What I built

- **`src/index.ts`**: extended the root middleware predicate so `/share/*` (like
  `/e`) skips the nonce-minting `securityHeaders` middleware — the share handler
  mints its own nonce and sets its own complete header set instead.
- **`src/dashboard/index.ts`**:
  - Removed `GET /public/:token`.
  - Added `SHARE_TOKEN_SHAPE` (`^shr_[A-Za-z0-9_-]{43}$`) — a pre-filter that runs
    before any D1 read.
  - Added `SHARE_NOT_FOUND_HTML` — a fully static 404 body (no nonce or token
    interpolation) so unknown/malformed/revoked tokens are byte-identical.
  - Added `publicSecurityHeaders(nonce)` — the same strict CSP (nonce +
    strict-dynamic, no `unsafe-inline` in `script-src`), the same hardening headers
    as the root middleware, plus `X-Robots-Tag: noindex, nofollow`. Duplicated
    locally rather than factored into `src/shared/security-headers.ts` (out of this
    task's file scope, and that module's docstring marks it foundation-owned).
  - Added `PUBLIC_NAV_ITEMS` (filters `NAV_ITEMS` to drop `geography`) and
    `publicNav(activeView, token, rangeKey)` — sidebar reusing `skopiaLogo()`, with
    hrefs rewritten `/app/* → /share/:token/*`, ending in a "Powered by Skopia"
    link to `https://skopia.dev`. No site switcher, no health-status footer.
  - Added `publicLayout(...)` — topbar with the site name + a "read-only" badge,
    an "online now" badge slot that renders only when `onlineCount !== null` (this
    task always passes `null`; Task 2 wires the real count), and a small nonced
    script that wires the reused `rangePicker()` `<select>` to auto-submit (the
    strict CSP blocks an inline `onchange`).
  - Added `GET /share/:token`: mints its own nonce, applies the shape pre-filter,
    looks up the site via `getSiteByPublicToken`, runs the same 5-query
    `Promise.all` as `/app` (uncached, as specified), and renders through
    `publicLayout` with headers from `publicSecurityHeaders`.

## Tests

### New: `test/dashboard/share.test.ts`

Covers every RED case in the brief: valid token → 200 with stat cards/site
name/header-body nonce match; unknown+malformed+revoked → byte-identical 404s with
`X-Robots-Tag`, with an explicit assertion that malformed shapes never reach
`getSiteByPublicToken`; no `Set-Cookie` ever; `listSites` never called and no
`/app`/`/login`/site-switcher markup; no `new WebSocket(`/`/live?site=` in the body;
and the roadmap-7 regression that unauthenticated `GET /live?site=x` still redirects
to `/login`. One extra test (`renders the read-only badge, top-pages/top-sources
breakdown, and the range picker`) carries forward assertions from the old
`/public/:token` suite that weren't in the brief's enumerated RED list but cover
brief-mandated features (read-only badge, "Powered by Skopia" reuse of the
breakdown/range-picker builders) — since the underlying behavior was already
implemented (copied from the old route), this one was written test-after rather than
RED-first; every other test in the file was RED-first per the transcript below.

### Migrated: `test/dashboard/dashboard.test.ts`

- Removed the `/public/:token` describe block (7 tests) — superseded by
  `share.test.ts`.
- `stat-card labels` and `sampled data badge` describe blocks (4 tests) exercised
  `statCardsHtml()` output, a builder shared verbatim between `/app` and `/share` —
  not the public/private distinction itself — so I repointed them at the still-live,
  authed `/app` route instead of duplicating them into `share.test.ts`. Assertions
  are unchanged.
- Updated the file's header docstring to remove stale `/public/:token` bullets and
  point at the new suite.

## TDD evidence

**RED** (`npx vitest run test/dashboard/share.test.ts`, before implementation —
`/share/:token` didn't exist yet, so requests fell through to Hono's default 404
with no `X-Robots-Tag` header):

```
 ❯ test/dashboard/share.test.ts (7 tests | 3 failed) 15ms
     × valid token: 200 with overview stat cards, site name, and a header nonce matching the baked body nonce 12ms
     × 404s unknown and malformed tokens with byte-identical bodies; malformed shapes never reach the DB 1ms
     × revoked token (previously valid, now resolves null) 404s the same way as unknown 0ms

 FAIL  test/dashboard/share.test.ts > GET /share/:token > valid token: ...
AssertionError: expected 404 to be 200 // Object.is equality
 FAIL  test/dashboard/share.test.ts > GET /share/:token > 404s unknown and malformed tokens ...
AssertionError: expected null to be 'noindex, nofollow' // Object.is equality
 FAIL  test/dashboard/share.test.ts > GET /share/:token > revoked token ...
AssertionError: expected null to be 'noindex, nofollow' // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 4 passed (7)
```

(The other 4 tests in the same RED run — no-Set-Cookie, isolation, no-live-socket,
and the `/live` regression — passed immediately because Hono's default 404 for a
nonexistent route also carries no cookie, no `/app`/`/login`/WebSocket markup, and
the `/live` route itself was untouched. They still exercise real behavior post-
implementation.)

**GREEN** (`npx vitest run test/dashboard/share.test.ts`, after implementation):

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

**Full suite + typecheck** (after implementation, migration, and lint fixes):

```
$ npx vitest run
 Test Files  15 passed (15)
      Tests  270 passed (270)

$ pnpm typecheck
$ tsc --noEmit && tsc --noEmit -p tsconfig.script.json
(clean, no output)

$ pnpm lint
$ biome check
Checked 46 files in 60ms. No fixes applied.
```

## Files changed

- `src/index.ts` — middleware predicate extended for `/share/*`.
- `src/dashboard/index.ts` — `/public/:token` removed; `/share/:token` +
  `publicSecurityHeaders`/`publicNav`/`publicLayout`/`SHARE_TOKEN_SHAPE`/
  `SHARE_NOT_FOUND_HTML` added.
- `test/dashboard/dashboard.test.ts` — `/public/:token` suite removed; 4 tests
  repointed at `/app`; docstring updated.
- `test/dashboard/share.test.ts` — new, 8 tests.

## Self-review notes

- Confirmed `wrangler.jsonc` untouched (`git diff --name-only` has no match) and no
  new migration file was added (`migrations/` has no pending changes).
- Confirmed the 404 body is truly byte-identical across unknown/malformed/revoked
  causes by never interpolating the nonce or the token into `SHARE_NOT_FOUND_HTML`
  (the per-request nonce only appears in the CSP header on 404s, never in the body).
- Confirmed `esc()` wraps every interpolated value in the new HTML, including the
  already-shape-validated `token` in nav hrefs — matching the existing codebase
  convention of `esc()`-wrapping trusted DB/route values (e.g. `esc(site.id)`
  elsewhere in this file) rather than relying on upstream validation alone.
- Did not add a response cache, `Cache-Control` header, or the `SITE_LIVE` snapshot
  read — both are explicitly Task 2's job ("UNCACHED in this task").
- Did not add the five other share views (`pages`, `sources`, `devices`,
  `campaigns`, `events`, `geography` 404) — explicitly Task 3.
- Did not touch `src/shared/security-headers.ts` — out of this task's file scope
  and marked foundation-owned; `publicSecurityHeaders` duplicates a small CSP-build
  routine locally instead.

## Concerns

- ADR-0012 doesn't exist in the repo (see above) — not blocking for this task since
  every requirement it's cited for is already spelled out in the plan's Global
  Constraints, but a later task that needs ADR text not already surfaced in the plan
  would hit the same gap.
- The "online now" badge, `publicNav`, and mobile responsiveness (no mobile
  tabbar/collapse for `/share/*`, unlike `/app`) are my own reasonable design calls
  in the absence of ADR §2 visuals — functionally correct and tested, but a human
  design pass may want to adjust styling once Claude Design sessions (Track C) or a
  written ADR land.

# Task 3 report — the five remaining share views

## Worktree base correction (before starting)

The dispatch prompt gave `sdd-worktree ... df5e3d36fb0bdefe1dd87eb589fc58d72fac15fc 3`
as the setup command, but that SHA is the tip of `main`, not of the branch
carrying Tasks 1/2/4/5/6 (`feat/launch-readiness`, tip `0ebb77af`). The prompt's
own pre-flight check ("verify with git log that docs/install.md contains both
'## 7. Public share links' and the four-secret walkthrough before starting")
failed against that base: no `/share/:token` route, no `test/dashboard/share.test.ts`,
and `docs/install.md` had no share-link section.

`main` is an ancestor of `feat/launch-readiness` (confirmed via
`git merge-base main feat/launch-readiness` = `df5e3d36f...`), so this reads as
a dispatch parameter error (wrong base SHA), not an ambiguous design decision.
No commits existed yet on `sdd/t3`, so I re-ran `sdd-worktree` with the corrected
base (`0ebb77af434d4c3fe6e94afda5f3d3a577ff3d4c`, tip of `feat/launch-readiness`),
which recreated the worktree/branch cleanly. Verified afterward: `docs/install.md`
has `## 7. Public share links`, `src/dashboard/index.ts` has the `/share/:token`
overview route, `test/dashboard/share.test.ts` exists. Proceeded from there.

## What I built

Five new public share routes in `src/dashboard/index.ts`, mirroring their
`/app` counterparts (same query set, same content builders — `breakdownTable`,
`breakdownCard`), rendered inside `publicLayout` and fronted by the existing
`cachedPublicResponse` read-through cache (Global Constraint 6 cache-key
format, unchanged):

- `GET /share/:token/pages` — `getTopPages(...50)` → `breakdownTable` (Page /
  Visitors / Pageviews columns), cache key `share:v1:{id}:pages:{range}:{day}`.
- `GET /share/:token/sources` — `getTopSources(...50)` → `breakdownTable`
  (Source / Visitors / Share columns).
- `GET /share/:token/devices` — `getTopDevices/getTopBrowsers/getTopOperatingSystems`
  (limit 10 each) → three `breakdownCard`s in a 3-col grid.
- `GET /share/:token/campaigns` — `getTopUtmSources/Mediums/Campaigns` (limit
  10 each) → three `breakdownCard`s.
- `GET /share/:token/events` — `getTopEvents(...50)` → `breakdownTable`
  (Event / Count / Visitors, "Count" not "Pageviews" per the honesty
  convention) or the same "no events yet" empty-state copy as `/app/events`
  when `rows.length === 0`.

`/share/:token/geography` is intentionally **not** registered (the brief
scopes this task to five views, not six, and `PUBLIC_NAV_ITEMS` already
excludes geography from the public nav) — an unmatched request falls through
Hono's default 404, which the test suite asserts.

**Refactor:** extracted `resolveShareSite(c, token): Promise<SiteRow | Response>`
out of the existing overview route — the token-shape pre-filter + D1 lookup +
byte-identical 404 body was about to be duplicated five more times verbatim.
All six `/share/:token*` routes now call it; behavior is unchanged (verified
by the pre-existing overview-route tests staying green).

None of the five new routes call `liveScript`, set cookies, call `listSites`,
or open a WebSocket — matching Global Constraint 5. Nav hrefs come for free
from the existing `publicNav`/`PUBLIC_NAV_ITEMS` (`/app/x` → `/share/:token/x`
substitution), unchanged by this task.

## Files changed

- `src/dashboard/index.ts` — `resolveShareSite` helper + 5 new routes (+207/-4 lines).
- `test/dashboard/share.test.ts` — new mock data (`MOCK_DEVICES`, `MOCK_UTM`,
  `MOCK_EVENTS`, matching `test/dashboard/dashboard.test.ts`'s app-view fixtures)
  and a new `describe` block covering the five views + geography 404 + unknown-token
  404 (+121 lines).

`wrangler.jsonc` untouched. No new migration. No new dependency.

## TDD evidence

**RED** — `npx vitest run test/dashboard/share.test.ts` before implementation
(routes didn't exist, requests fell through to Hono's default 404):

```
FAIL  test/dashboard/share.test.ts > ... pages: 200 with the Pages breakdown table ...
AssertionError: expected 404 to be 200
FAIL  ... sources: 200 with the Sources breakdown table ...
AssertionError: expected 404 to be 200
FAIL  ... devices: 200 with device/browser/OS panels ...
AssertionError: expected 404 to be 200
FAIL  ... campaigns: 200 with UTM source/medium/campaign panels ...
AssertionError: expected 404 to be 200
FAIL  ... events: 200 with the events table ...
AssertionError: expected 404 to be 200
FAIL  ... every rendered view's nav hrefs point at /share/:token/… ...
AssertionError: expected '404 Not Found' to contain '/share/shr_aaa.../pages'
FAIL  ... an unknown token 404s each view the same way as the overview route ...
AssertionError: expected '404 Not Found' to contain 'Dashboard not found.'

Test Files  1 failed (1)
     Tests  7 failed | 13 passed (20)
```

(The 13 pre-existing passes are the untouched overview/cache/live-gating
tests; the geography-404 test in the new block happened to pass immediately
since it asserts the default-404 behavior that was already correct.)

**GREEN** — after implementing the five routes + `resolveShareSite`:

```
$ npx vitest run test/dashboard/share.test.ts
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

**Full suite + typecheck + lint**, run last:

```
$ npx vitest run
 Test Files  15 passed (15)
      Tests  282 passed (282)

$ pnpm typecheck
$ tsc --noEmit && tsc --noEmit -p tsconfig.script.json
(no output — clean)

$ pnpm lint
$ biome check
Checked 46 files in 26ms. No fixes applied.
```

## Self-review

- Implemented exactly the five routes the brief names; geography deliberately
  left unregistered (in scope: "→ 404", not "→ implement").
- Content builders and query sets are byte-for-byte the same calls the `/app`
  counterparts make (same limits: 50 for pages/sources/events, 10 for
  devices/campaigns sub-panels) — no drift between authed and public rendering.
- Tests assert real HTTP behavior (status, body markers reused from the
  `/app`-view test fixtures, nonce header/body equality, nav href substrings,
  404 byte-content) against the real Hono router, not mocked internals.
- `resolveShareSite` extraction: six call sites in this file after the change,
  well past the "two concrete uses" bar for justified reuse; the full existing
  overview-route test suite (token-shape pre-filter call-count assertions,
  Set-Cookie absence, cache tests) stayed green unchanged, confirming the
  refactor didn't alter behavior.
- No new dependency, no schema/migration change, `wrangler.jsonc` untouched.
- Output pristine: no stray console warnings in the vitest run, lint and
  typecheck both silent-clean.

## Concerns

- The worktree-base correction above (main tip vs. `feat/launch-readiness`
  tip) — flagging so the controller can check whether other tasks in this
  wave got the same wrong base SHA in their dispatch prompts.
- Pages and Sources share the same `MOCK_BREAKDOWN` fixture (`/home` row) in
  the test file, same as `dashboard.test.ts` does for the authed views — I
  distinguished them in assertions via the breakdown-table's column-header
  text (`>Page<` / `>Source<`) rather than row content, which is a slightly
  more implementation-coupled marker than a distinct fixture would give, but
  it mirrors the existing `/app` test file's own convention rather than
  introducing a new one.

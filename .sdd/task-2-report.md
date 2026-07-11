# Task 2 — Read-through cache + server-rendered "online now" count — report

**Worktree:** `/Users/jasonmatthew/Work/Git/skopia-wt-launch-t2` (branch `sdd/t2`)
**Base:** reset onto integration tip `9b092bf` (feat/launch-readiness) so Task 1/4/5
output was present to build on — the dispatch base `df5e3d3` predated it (see "Base note").

## What I built

`GET /share/:token` (overview) now runs through a two-tier read-through cache and
server-renders the live "online now" count.

- **`cachedPublicResponse(c, cacheKey, ttl, render)`** (`src/dashboard/index.ts`) — per
  ADR-0012 §4:
  1. `caches.default` first, synthetic key `new Request("https://cache.local/" + cacheKey)`.
     A hit replays the stored `Response` verbatim.
  2. On Cache-API miss, `env.CACHE.get<CachedPublicPage>(key, { type: "json", cacheTtl: ttl })`
     (stored shape `{ html, nonce }`). A hit rebuilds the response and warms the near tier.
  3. On full miss, read the live count **once** via a single `SITE_LIVE` `snapshot()` RPC in
     `try/catch` (a DO failure degrades to no badge, never a 500), then `render(onlineCount)`.
  4. `waitUntil` both `CACHE.put(key, JSON.stringify(page), { expirationTtl: ttl })` and
     `cache.put(cacheReq, res.clone())`.
- **`buildPublicResponse(page)`** — reconstructs the exact public `Response`
  (`Content-Type`, `Cache-Control: public, s-maxage=60`, full `publicSecurityHeaders(nonce)`)
  from a rendered `{ html, nonce }`, so a KV-tier replay is byte-identical to the origin.
- Overview route rewired through it with the Global-Constraint-6 key
  `share:v1:${site.id}:overview:${range.key}:${todayUtc()}` (keyed by site id, never token).
  The 200 nonce is minted inside `render()` so a cached page keeps a single nonce across
  its header and body. Shape pre-filter + `getSiteByPublicToken` null-check (the 404 paths)
  are unchanged from Task 1 and run before the cache.

Because `render()` runs inside the helper only on a full miss, a cache hit skips **both** the
D1 query set and the snapshot RPC.

## TDD evidence (RED -> GREEN)

Test runner: `npx vitest run` (Workers pool). Added 4 tests to
`test/dashboard/share.test.ts` under `describe("GET /share/:token — read-through cache +
online-now (Task 2)")`, each with a test-unique site id (Global Constraint 7).

**RED** (`npx vitest run test/dashboard/share.test.ts`) — 3 failed | 9 passed:

```
× serves the second GET from cache: header and body carry the SAME nonce
    AssertionError: expected 'fa105e53e7bd41a3afda3270294088f8' to be '3733df1935ad436bb3f3d7285c94a76f'
× 200 responses carry Cache-Control: public, s-maxage=60
    AssertionError: expected null to be 'public, s-maxage=60'
× renders the online-now badge from the SITE_LIVE snapshot count
    AssertionError: expected '<!DOCTYPE html>...' to contain '7 online now'
```

Each fails for the intended reason: two distinct nonces (no cache), no `Cache-Control` header,
no badge wired. The 4th test (snapshot-throws degradation) passes pre-impl by construction —
it guards against a *naive* implementation that lets the RPC throw propagate to a 500; it
cannot be RED against the Task-1 baseline because no badge/snapshot exists there yet.

**GREEN** (`npx vitest run test/dashboard/share.test.ts`):

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

## Full verification (end of task, all clean)

- `pnpm typecheck` -> exit 0 (`tsc --noEmit && tsc --noEmit -p tsconfig.script.json`).
  Caught one real issue mid-task: `cacheKey.split(":")[2]` is `string | undefined` under
  `noUncheckedIndexedAccess`; fixed with an `if (siteId)` guard (also defensive — a malformed
  key skips the snapshot rather than crashing).
- `pnpm lint` (biome) -> exit 0, "No fixes applied" (auto-formatted the two wrapped 404
  returns).
- `npx vitest run` (full suite) -> exit 0, **15 files / 274 tests passed**.

## Files changed

- `src/dashboard/index.ts` — added `LiveSnapshot` to the type import; `SHARE_CACHE_TTL_SECONDS`,
  `CachedPublicPage`, `buildPublicResponse`, `cachedPublicResponse`; rewired `GET /share/:token`.
- `test/dashboard/share.test.ts` — 4 new tests + `afterEach` import + `stubSiteLive` helper.

No `wrangler.jsonc` change; no migration; no new dependency. `git status` shows only the two
files above.

## Self-review / concerns

- **Signature vs. site-id addressing.** The brief fixed the 4-arg signature
  `cachedPublicResponse(c, cacheKey, ttl, render)`, so the DO is addressed by parsing the site
  id out of segment 2 of the cache key. That assumes site ids carry no `':'` (the WAE-index
  slug convention — the codebase's own INSERT example uses `'my-site'`). Marked with a
  `ponytail:` comment; failure mode is a cosmetically-wrong/absent count, never a crash or a
  security issue.
- **Caching a failed live-count read.** When `snapshot()` throws, the null-badge page is still
  cached for the 60 s TTL. This is intentional: the live count only refreshes every 60 s by
  design (that is the cache), so a badge absent for <=60 s after a DO blip is acceptable
  degradation, not a bug.
- Global-Constraint checks: no WebSocket (server-side RPC only); no `Set-Cookie`; no
  `listSites`; 404 paths byte-identical and unchanged; cache key by site id, never token;
  `Cache-Control: public, s-maxage=60`. All existing Task-1 share tests still green.

## Base note

The dispatch passed base `df5e3d3` (the plan commit, pre-implementation), but the note said
Tasks 1/4/5 are already merged at `9b092bf` on `feat/launch-readiness` and must be built on.
`sdd/t2` had no unique commits, so I `git reset --hard 9b092bf` to pick up Task 1's
`/share/:token` route, `publicSecurityHeaders`, `publicLayout`, and `share.test.ts`. The
controller should be aware the worktree branch was rebased onto the true integration tip.

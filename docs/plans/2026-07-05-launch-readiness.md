# Launch Readiness — implementation plan (Tracks A + B)

**Date:** 2026-07-05
**Spec:** `docs/specs/2026-07-05-launch-readiness-design.md`

> **STATUS: Tracks A + B COMPLETE; C + D outstanding.** Track A (public share-link demo,
> [ADR-0012](../decisions/0012-public-share-link-dashboard.md)) and Track B (README rebuild)
> shipped. Track C (marketing-honesty pass) and Track D (launch assets — a social `og:image`
> card, removing the placeholder homepage stat) still have open items before launch.
**ADR:** `docs/decisions/0012-public-share-link-dashboard.md` (Track A decisions are FINAL —
implement, do not re-derive)
**Research:** `docs/research/2026-07-05-best-in-class-analytics-marketing.md`,
`docs/research/2026-07-05-launch-asset-inventory-pm.md`

Track C (skopia-www copy pass) is a separate repo and is NOT in this plan.
Post-merge operations (mint the skopia.dev share token, load test, capture the real
dashboard screenshot, replace the README badge sentinel) are release-checklist items for the
controller, NOT tasks here.

## Global Constraints

1. **TDD.** Every code task: write the failing test first, run it, confirm it fails for the
   right reason, then implement, then quote the red→green transition. Test runner:
   `npx vitest run` (Workers pool). Typecheck: `pnpm typecheck`. Both must be clean at the
   end of every task.
2. **Never touch `wrangler.jsonc`.** The `CACHE` KV and `SITE_LIVE` DO bindings already
   exist. Never stage or commit it.
3. **No new migrations.** `sites.public_token` + its unique partial index already exist in
   `migrations/0001_init.sql`. Do not add a migration.
4. **`/share/*` security invariant (ADR-0012).** `/share/*` is excluded from the root
   nonce-rewriting `securityHeaders` middleware; the share handler MUST set the complete
   hardening header set itself via `publicSecurityHeaders(nonce)` (strict CSP with the baked
   nonce, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, HSTS,
   `Permissions-Policy`, `X-Robots-Tag: noindex, nofollow`).
5. **Public surface is read-only and single-site.** Share routes never call `listSites`,
   never read `users`/`goals`/settings, never set or read cookies, never open a WebSocket,
   and return a generic byte-identical 404 for unknown/revoked/malformed tokens. Token shape
   pre-filter: `^shr_[A-Za-z0-9_-]{43}$` before any D1 read.
6. **Cache key format:** `share:v1:{site_id}:{view}:{range_key}:{utcDay}` — keyed by site id,
   NEVER by token. TTL 60 s. Responses carry `Cache-Control: public, s-maxage=60`.
7. **Unique per-test site ids** in any test touching real D1 (the Workers pool shares D1
   state within a file run).
8. **Escape-text only** for control characters in any file content (write them as backslash-u escape text like `\uXXXX`, never as raw bytes).
9. **Match existing style** in `src/dashboard/index.ts`: `esc()` for HTML interpolation,
   `jsonForScript()` for inline-script data, content builders stay pure `(data, nonce) → html`.
10. **Docs register rules** (Tasks 5–7): never the words "GDPR compliant", "anonymous", or
    "impossible to track"; every mechanism claim links the actual source file; state what the
    design cannot tell the owner as prominently as what it can; say "self-deployed on your
    own Cloudflare account", not bare "self-hosted".

# Task 1 — Public overview route: `/share/:token` replaces `/public/:token`

**Files:** `src/index.ts`, `src/dashboard/index.ts`, `test/dashboard/share.test.ts` (new),
`test/dashboard/dashboard.test.ts` (migrate any existing `/public/:token` cases).

1. New `test/dashboard/share.test.ts` mocking `src/db/queries` exactly as
   `test/dashboard/dashboard.test.ts` does (`getSiteByPublicToken` returns the mock site for
   the valid token, `null` otherwise). Write these RED first:
   - Valid token → 200; body contains the overview stat cards and the site name; the CSP
     header's `nonce-…` value equals the `nonce="…"` baked into the body (single-request
     header/body nonce consistency).
   - Unknown token, malformed token (`shr_` + wrong length, and a non-`shr_` string), and
     revoked (`getSiteByPublicToken` → null) → 404 with byte-identical bodies and
     `X-Robots-Tag: noindex, nofollow`. Assert `getSiteByPublicToken` was NOT called for the
     malformed shapes (shape filter runs first).
   - No `Set-Cookie` header on any share response.
   - Isolation: `queries.listSites` is never called by a share request; body contains no
     `/app` hrefs, no `/login`, no site-switcher markup.
   - No public live socket: body contains no `new WebSocket(` and no `/live?site=`.
   - Roadmap-7 regression: unauthenticated `GET /live?site=x` still 401s/redirects (copy the
     existing assertion pattern).
2. Implement: remove `GET /public/:token`; add `publicSecurityHeaders(nonce)`; add
   `publicNav`/`publicLayout` per ADR §2 (reuse `skopiaLogo`, `NAV_ITEMS` minus geography,
   `rangePicker`, content builders; hrefs → `/share/:token/…`; "read-only" badge; "Powered by
   Skopia" link; the "online now" badge slot renders only when a count is passed — pass
   `null` for now, wired in Task 2); add `GET /share/:token` (overview, UNCACHED in this
   task) running the same query set as the app overview via `Promise.all`, rendered with
   `publicLayout`, headers from `publicSecurityHeaders`.
3. In `src/index.ts`, extend the middleware predicate to skip `securityHeaders` for
   `c.req.path.startsWith("/share/")` (mirroring `/e`).

**Success:** new tests green, suite + typecheck clean, red→green quoted.

# Task 2 — Read-through cache + server-rendered "online now" count

**Files:** `src/dashboard/index.ts`, `test/dashboard/share.test.ts`.

1. RED first:
   - Two sequential GETs of the same share URL return the SAME nonce in header and body
     (proves the second is a cache hit serving the stored body+headers together).
   - 200 responses carry `Cache-Control: public, s-maxage=60`.
   - When the `SITE_LIVE` snapshot path throws (mock/stub it), the page still renders 200
     and the "online now" badge is absent.
2. Implement `cachedPublicResponse(c, cacheKey, ttl, render)` per ADR §4: `caches.default`
   first (synthetic key `new Request("https://cache.local/" + cacheKey)`), then
   `env.CACHE.get(key, { cacheTtl: 60 })` (stored shape `{ html, nonce }`), then `render()`;
   on render-miss fetch the live count via ONE `SITE_LIVE` `snapshot()` RPC in try/catch;
   `waitUntil` both `KV.put(…, { expirationTtl: ttl })` and `cache.put`. Wire the overview
   route through it with the Global-Constraint-6 key.

**Success:** cache-hit nonce test green (it MUST fail before this task — quote it), suite +
typecheck clean.

# Task 3 — The five remaining share views

**Files:** `src/dashboard/index.ts`, `test/dashboard/share.test.ts`.

1. RED first: each of `/share/:token/{pages,sources,devices,campaigns,events}` → 200 with a
   view-specific marker (reuse the mock-data markers the app-view tests assert);
   `/share/:token/geography` → 404; every view's body nonce matches its header nonce; nav
   hrefs in each rendered view point at `/share/:token/…` (never `/app`).
2. Implement the five routes through `cachedPublicResponse`, each running the same query set
   as its `/app` counterpart and the same content builders inside `publicLayout`.

**Success:** view-coverage tests green, suite + typecheck clean, red→green quoted.

# Task 4 — Share-token operations documented

**Files:** `docs/install.md`.

Add a "Public share links" section: mint/rotate
(`TOKEN="shr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"` +
`wrangler d1 execute skopia --remote --command "UPDATE sites SET public_token='$TOKEN' WHERE id='<site>'"`),
revoke (`… SET public_token=NULL …`), the ≤60 s post-revocation cache window, independence
from collection and auth (rotating a share link never breaks ingest), and the optional
Cloudflare rate-limiting rule on `/share/*` for operators who want one. No code changes.

**Success:** section present, accurate to ADR §1/§4/§5; `pnpm typecheck` still clean (no-op
guard).

# Task 5 — `docs/privacy.md` becomes the canonical data-policy doc

**Files:** `docs/privacy.md`.

Rewrite per the structure in `docs/briefs/2026-07-05-data-policy-page-brief.md` §"Page
structure" (that brief is for the marketing page; this doc is its source of truth): what is
stored (exact event fields; no raw IP at rest, no cookies, no localStorage, no cross-site
identifiers); the visitor-id mechanism verbatim from `src/shared/identity.ts` (HMAC-SHA-256
over `salt|ip|ua|siteId`, first 8 bytes → 16 hex chars; 32-byte CSPRNG daily salt in KV with
day-boundary-anchored TTL, gone ~1 h after the UTC day ends); what the owner cannot know
(monthly uniques, cross-day journeys, returning-visitor rates beyond a day) stated as
design intent; known accuracy limits (shared IP+UA under-counts, VPN hopping over-counts);
where data lives (owner's own account: WAE raw 90-day platform retention, D1 rollups
thereafter); repo-relative source links (`src/shared/identity.ts`, `src/collector/index.ts`,
`migrations/`). Global Constraint 10 register rules bind hard.

**Success:** doc complete, every mechanism claim carries a source link, banned phrases absent
(grep-verify "GDPR compliant" returns nothing).

# Task 6 — `docs/install.md` absorbs the four-secret walkthrough

**Depends on:** Task 4 (same file).
**Files:** `docs/install.md`, `README.md` (removal only).

Move the secret-generation walkthrough (the four secrets: `IDENTITY_HMAC_SECRET`,
`AUTH_COOKIE_SECRET`, `CF_ACCOUNT_ID`, `WAE_API_TOKEN`) from `README.md` into
`docs/install.md` as a complete, copy-pasteable setup path (Deploy-button flow first, then
`wrangler deploy` alternative). README keeps a one-line pointer. Do not otherwise restructure
the README (that is Task 7).

**Success:** walkthrough lives in `docs/install.md` intact, README pointer in place, no
information lost (diff-check the moved content).

# Task 7 — README rebuilt to the exemplar anatomy

**Depends on:** Task 6.
**Files:** `README.md`, `docs/assets/` (referenced, not created).

Rebuild per the teardown §2.6 anatomy and spec Track B, in order: logo/wordmark + one-liner
("Open-source, cookieless web analytics you deploy to your own Cloudflare account — the
privacy-first Google Analytics alternative with nothing to run") → badge row (AGPL license,
CI, green **Live demo** badge whose href is the literal sentinel `SHARE_URL_PENDING` — the
release checklist replaces it after the token mint; this sentinel is deliberate and the only
one allowed) → hero screenshot slot `docs/assets/dashboard-overview.png` (image captured in
the release checklist; alt text written now) → linked feature claims (each → a docs anchor or
source file) → **Deploy to Cloudflare button in the first viewport** → **Limitations**
section BEFORE installation (owned tradeoffs: WAE sampling; 90-day WAE window + the
rollup/DO-counters answer; exactly what daily-salt identity cannot tell you — monthly
uniques, cross-day conversion attribution; the Cloudflare dependency — "self-deployed on
your own Cloudflare account") → short install pointer to `docs/install.md` → tech stack list
→ contributing/license. Keep the existing honest tone; Global Constraint 10 binds. Do not
invent stats; the script-size claim is "571 B gzipped" (cite the CI size check).

**Success:** README follows the anatomy top-to-bottom, Deploy button in first viewport,
Limitations precede Installation, banned phrases absent, exactly one `SHARE_URL_PENDING`
sentinel present.

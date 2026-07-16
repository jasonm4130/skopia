# 0012 — Public share-link dashboard

- **Date:** 2026-07-05
- **Status:** accepted
- **Owner:** cloudflare-tech-lead
- **Relates to:** implements Track A of `docs/specs/2026-07-05-launch-readiness-design.md`
  (the launch gate); reuses the dashboard SSR view functions and auth model from ADR-0005;
  reads `rollup_daily` written by the `SiteLive` DO (ADR-0011); must not regress the
  auth-gating of `/live` (feature-roadmap `docs/specs/2026-07-03-feature-roadmap.md` item 7).
- **Evidence base:** current-state read of `src/dashboard/index.ts`, `src/db/queries.ts`,
  `src/dashboard/site-live.ts`, `src/shared/security-headers.ts`, `migrations/0001_init.sql`;
  Cloudflare pricing/limits pulled 2026-07-05 (cited in the cost model). All primitives used
  (Workers, KV, Cache API, D1, Durable Objects) are GA; nothing here is beta.

## Context

The launch is demo-gated. skopia.dev's own dashboard must be viewable **logged-out** at an
unguessable URL, must render the standard views for one site, and must **survive Hacker News
front-page load** — the spec explicitly cites Umami's demo 502'ing under load as the failure
to avoid.

What already exists (this is a hardening/completion task, not greenfield):

- `sites.public_token TEXT` column **already exists** (migration `0001_init.sql`) with a
  unique partial index `idx_sites_public_token`. `getSiteByPublicToken()` **already exists**
  in `src/db/queries.ts`. **No migration is required.**
- A `GET /public/:token` route **already exists** but is a placeholder: it renders only a
  partial view (stat cards + chart + top pages/sources/countries), has **no caching**
  (5 D1 queries per request, every request), and duplicates layout instead of reusing the
  app's view functions.
- The KV `CACHE` binding is **provisioned but entirely unused** in code — only a type
  declaration (`src/shared/types.ts`). There is *no existing KV response-cache pattern*; this
  ADR defines it. (The collector's `siteCache` is an in-memory `Map`, not KV.)
- The collector authenticates a site by **site id + `origin_allowlist` CORS check** — there
  is **no collector bearer token**. `public_token` is therefore used *exclusively* as the
  share token. There is no reuse-vs-mint-separate conflict to resolve: the two capabilities
  are already independent, with independent revocation.
- `/live` (WebSocket → `SiteLive` DO) is gated by `requireAuth` (`src/dashboard/index.ts`).

Three constraints shape every decision below:

1. **CSP-nonce/caching conflict (correctness-critical).** `securityHeaders`
   (`src/shared/security-headers.ts`) mints a fresh nonce per request and writes a matching
   `Content-Security-Policy` header *after* the handler runs. The SSR bodies bake that nonce
   into `<style nonce>`/`<script nonce>`. If we cache a rendered body, its baked-in nonce
   desyncs from a freshly-minted header nonce on a cache hit → CSP blocks all styles/scripts →
   broken page. Any caching design must keep header-nonce == body-nonce on a hit.
2. **HN load = hundreds of RPS in bursts, concentrated in a handful of colos, global.**
3. **A single hot Durable Object.** All of one site's live state lives in one `SiteLive`
   instance. Anything that fans public request volume onto that one DO (e.g. a public
   WebSocket per visitor, with `broadcast()` looping all sockets on every event) is the first
   thing that melts. This is the load-bearing scale risk.

## Decision

### 1. Token model

- **Format:** `shr_` + base64url(32 random bytes) — 256-bit CSPRNG
  (`crypto.getRandomValues`), URL-safe, ~43-char body. The `shr_` prefix makes tokens
  greppable, self-identifying, and lets us **shape-filter before any D1 read** (reject
  anything not matching `^shr_[A-Za-z0-9_-]{43}$`). 256 bits is non-enumerable by construction.
- **Storage:** plaintext in the existing `sites.public_token` column (existing unique index,
  existing O(1) exact-match query). *Not* hashed at rest. Rationale: the protected asset is
  read-only **aggregate** analytics for a single site the owner has *chosen to expose*; the
  threat model is "unguessable URL," not "secret credential." This matches Umami/Plausible
  precedent and the existing schema. Hash-at-rest is noted as trivial future hardening
  (store `sha256(token)`, look up by hash) if the threat model ever changes (e.g. managed
  multi-tenant) — over-engineering for self-host single-owner today.
- **Mint / rotate / revoke (launch):** a **documented `wrangler d1 execute` procedure**, not
  new owner UI. The launch gate is the *public read surface* on skopia.dev's own site; the
  owner mint UI is explicitly deferrable per the spec. Exact procedure lands in
  `docs/install.md`:
  - **Mint / rotate:** generate `TOKEN="shr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"`
    then `wrangler d1 execute skopia --remote --command "UPDATE sites SET public_token='$TOKEN' WHERE id='<site>'"`.
    Rotation reuses the same command; the old URL dies immediately at the query layer.
  - **Revoke:** `UPDATE sites SET public_token=NULL WHERE id='<site>'`.
  - Fast-follow (post-launch, not required now): a minimal authenticated
    `POST/DELETE /app/site/:id/share` pair (~15 lines) once the owner-settings surface exists.
- **Independence:** revoking/rotating the share token does **not** touch collection (collector
  uses site id + origin allowlist), and does not touch auth. Documented so operators aren't
  afraid to rotate.

### 2. Route surface + reuse

- Replace the placeholder `GET /public/:token` with the spec's Umami-style `/share/:token`
  family (nothing external links to `/public/:token` yet):
  - `GET /share/:token` → overview
  - `GET /share/:token/pages`
  - `GET /share/:token/sources`
  - `GET /share/:token/devices`
  - `GET /share/:token/campaigns`
  - `GET /share/:token/events`
  - Range via `?range=7d|30d|90d` (reuse `parseRange`).
- **Views exposed = exactly the spec's six** (overview, pages, sources, devices, campaigns,
  events). **Geography is deliberately omitted** from the public nav — it is not in the spec's
  public list, and it is the heaviest view (jsVectorMap vendor JS). The overview keeps its
  existing "Top countries" *card* (the data is already public-safe); the full map view stays
  app-only. Trivially added later if the PM wants it.
- **Reuse strategy — "public render mode" without a risky refactor:** the public routes call
  the **same content builders** as the app (`statCardsHtml`, `timeSeriesChartHtml`,
  `breakdownCard`, `breakdownTable`) and the **same query functions** (`getStatCards`,
  `getTopPages`, …). Those are already pure `(data, nonce) → html`. Only the surrounding
  *chrome* differs, so we add a slim `publicLayout` (no site switcher, no `/app` nav, no
  health-status block, nav hrefs → `/share/:token/…`, a "read-only" badge, an "N online now"
  badge, a "Powered by Skopia" link). The app's `/app/*` routes are **not touched** (surgical:
  a change to app chrome can't break the public page, and vice-versa). Duplicating ~40 lines
  of thin chrome is cheaper and safer than threading a `mode` flag through `appLayout`, which
  is entangled with the switcher, mobile tabbar, and live-WS badge. `NAV_ITEMS` (minus
  geography) stays the single source of truth for both.

### 3. Live view: **no public WebSocket; a server-rendered cached count**

The public surface has **no WebSocket** and no unauthenticated `/live`. The authenticated
`/live` route is unchanged (roadmap item 7 preserved exactly).

- **Why not public WS:** a live socket per HN visitor points thousands of concurrent,
  15s-pinging, 3s-reconnecting sockets at the **single** `SiteLive` DO, whose `broadcast()`
  loops every socket on every collector event (O(sockets) per event). That is precisely the
  single-DO meltdown the spec's "don't 502 under load" requirement forbids.
- **What we ship instead:** the "N online now" badge is rendered **server-side** into the
  cached page from **one** `SITE_LIVE…snapshot()` RPC per *render-miss* (see cache strategy —
  bounded to the global miss rate, roughly tens of calls/day even under HN load, not per
  visitor). The call is wrapped in `try/catch` with a short timeout; on failure the badge is
  hidden and the page still renders and caches. The number is ≤60s stale ("online now" on a
  demo — fine) and the public page **never depends on DO health**.
- **Documented easy upgrade (out of scope for launch):** if we later want the number to tick
  without a refresh, add a `GET /share/:token/live.json` polled every ~15s and fronted by the
  Cache API (per-colo, free) with a ~15s TTL — bounded backend cost, still no sockets. Not
  built now (simplicity first).

### 4. Cache strategy: Cache API (primary) + KV (second tier), read-through, ≥60s TTL

Public routes run inside the Worker on every request (a Worker is the origin for its own
route; there is no free CDN layer in front of it), so caching must be **explicit in the
handler**. Two layers, read-through:

1. **`caches.default` (Cache API) — primary, per-colo, unbilled.** Checked first; holds the
   **full rendered `Response`** (headers + body). On hit: return immediately — zero KV, zero
   D1, zero DO, near-zero CPU. This is the mechanism that absorbs sustained HN RPS for free.
   Because we cache the *whole Response*, its CSP header nonce and body nonce are stored
   together and can never desync (solves constraint 1).
2. **KV `CACHE` — second tier, cross-colo.** Checked on Cache-API miss; holds `{ html, nonce }`
   (JSON), read with `get(key, { cacheTtl: 60 })`. On hit: rebuild the `Response` with the
   stored nonce and reseed the colo's Cache API. On miss: query D1, call the DO snapshot once,
   render, then `waitUntil` a `KV.put(key, …, { expirationTtl: ttl })` **and** a `cache.put`.

**Why both, and why KV is not gold-plating:** Cache API alone survives HN on cost, but it is
*per-colo* — every cold/expired colo re-renders, and re-renders each call the single hot DO
(`snapshot()`) and D1. KV bounds the DO snapshot calls, D1 reads, and render work to the
**global** miss rate (~one per (view,range,site) per TTL) instead of the **per-colo** miss
rate (colos × that) — roughly a 50× reduction in load on the single `SiteLive` DO under a
globally-distributed HN burst. The justification for KV is DO-protection + cold-colo latency,
**not** D1 cost (D1 is trivial either way — see model).

**Nonce handling (constraint 1):** exclude `/share/*` from the root nonce-rewriting
`securityHeaders` middleware (mirroring the existing `/e` exclusion in `src/index.ts`). The
share handler owns its own complete header set via a `publicSecurityHeaders(nonce)` helper
(same strict CSP shape as the app — `script-src 'self' 'nonce-<N>' 'strict-dynamic'`, etc. —
plus the hardening headers), where `<N>` is baked into the cached body. The nonce is therefore
**per-cache-entry** (rotates each ≤60s render), not per-request. Acceptable because the public
page reflects **no** user input into script context and every interpolated value is escaped
(`esc`) or `jsonForScript`'d — there is no injection point for the shared-nonce window to
matter, and it rotates every ≤60s.

**Cache key:** `share:v1:{site_id}:{view}:{range_key}:{utcDay}`.
- `v1` — bump on any render-shape change to invalidate globally via deploy.
- `utcDay` — entries roll at UTC midnight automatically (so a stale "today" partial can't
  outlive the day) and give a natural key for negative-cache expiry.
- Keyed by **site_id, not token** — so rotating the token doesn't orphan warm cache, and the
  token never lands in a cache key or `Cache-Control`.

**TTL:** uniform **60s** for all six views (the spec floor). All ranges end at "today," whose
`rollup_daily` rows are still being written by the DO, so 60s is the right freshness/coverage
trade. (Historical-only ranges would justify a longer TTL, but we have none.) The response
carries `Cache-Control: public, s-maxage=60` and `X-Robots-Tag: noindex`.

**Revocation vs cache:** a revoked token can still serve the last cached page for **≤ the TTL
(≤60s)**, then 404s. Accepted and documented for read-only aggregates; an operator needing
instant kill can bump `v1`/redeploy. No per-request cache-busting.

### 5. Security / privacy

- **Entropy / no enumeration:** 256-bit token; exact-match on the indexed column; **generic
  404** (byte-identical for unknown / malformed / revoked — no oracle); no listing endpoint;
  no sequential IDs. Shape pre-filter rejects malformed tokens before any D1 read.
- **Cross-site / settings isolation (invariant):** the handler resolves **exactly one** site
  from the token and passes only that site into the single-site `publicLayout`. It **never**
  calls `listSites`, never renders a switcher, never reads `users`/`goals`/settings. There is
  no path to pivot to another site (1:1 token→site) or to any owner surface. Enforced by test
  (a second seeded site's name must be absent from the first site's share page).
- **No cookies on public routes:** the handler sets no `Set-Cookie` and reads no cookie. This
  is also a caching guard — the Cache API refuses to store a `Set-Cookie` response, so an
  accidental cookie would surface as a caching failure in tests.
- **Indexing:** `X-Robots-Tag: noindex, nofollow` (+ `robots.txt` disallow `/share/`) so an
  "unguessable" link cannot leak into search results, defeating its own unguessability. The
  skopia.dev demo is discoverable via the marketing CTA regardless.
- **Rate-limiting stance:** the Cache API absorbs load for free; the shape filter + generic
  404 blunt malformed floods. A flood of well-formed random tokens is all cache-misses hitting
  one D1 read each — but D1's 25 **billion**/mo read allowance makes that cost-trivial, and KV
  bounds DO exposure. We therefore **do not build a custom rate limiter** (over-engineering);
  the operator knob is a Cloudflare rate-limiting rule on `/share/*`, documented in
  `docs/install.md`.

## Cost & scale model

Cloudflare pricing pulled **2026-07-05** (paid Workers plan; sources listed below).
Modeled scenario — **"HN front page" spike day**: 1 dogfooded site; 6 views × 3 ranges = 18
`(view,range)` combos; TTL 60s; ~1,000,000 public page requests over the day; peak ~300 RPS;
~50 colos carrying meaningful traffic.

With Cache API primary + KV second tier, per-primitive volume and headroom:

| Primitive | Spike-day volume | Included (paid) | Marginal $ | Notes |
|---|---|---|---|---|
| Worker requests | ~1.0M | 10M/mo | ~$0 | every request runs the Worker |
| Worker CPU | ~1M CPU-ms | 30M/mo | ~$0 | render only on miss (~2–5 ms) |
| **Cache API** | absorbs ~99% of reads | **free / unbilled** | **$0** | per-colo; the HN-survival layer |
| KV reads | ~1.3M (1 per Cache-API miss) | 10M/mo | ~$0 | miss = colos × combos ÷ TTL |
| KV writes | ~26k (1 per render-miss) | 1M/mo | ~$0 | bounded by combos ÷ TTL, **not** RPS |
| D1 rows read | ~130k (≈5 per render-miss) | **25B/mo** | ~$0 | 0.0005% of allowance |
| DO requests (`snapshot`) | ~26k (1 per render-miss) | 1M/mo | ~$0 | KV keeps this off per-colo |
| DO duration | ~26k trivial wakeups | 400k GB-s/mo | ~$0 | in-memory map read, sub-ms |

**Bottom line: a full HN-front-page spike day costs effectively $0 in marginal Cloudflare
spend, and no primitive approaches a hard limit.** Cost is not the binding constraint;
architecture is.

**Per-million-events framing:** public reads are decoupled from event volume (they read
`rollup_daily`, not raw events). The ingestion cost of the underlying 1M events is governed by
ADR-0011 (DO writes); the share dashboard adds only the read-side numbers above, which scale
with *cache-miss* count, not traffic.

**Limits that bite first (ordered):**
1. **Single-`SiteLive`-DO concurrency** — would melt first *if* a future change exposed public
   WebSocket live (thousands of sockets + O(n) per-event broadcast on one instance). This
   design avoids it entirely; the `snapshot()` path is bounded by KV to <1/s. **This is the
   risk to guard in review of any future "make the public count live" change.**
2. **KV writes (1M/mo included)** — bounded by `sites × combos ÷ TTL`, not RPS. Safe for a
   handful of sites at 60s TTL. Would bite only at ~hundreds of sites × many combos (>11
   render-misses/s sustained); the lever is a longer TTL.
3. **Cache API is per-colo and unreplicated** — a globally-synchronized TTL-expiry herd can
   briefly fan out to KV/DO across many colos at once. Bounded and cheap; the KV tier is what
   smooths it.
4. Worker requests/CPU, D1 reads, DO requests each have 2–4 orders of magnitude of headroom.

## Alternatives considered

- **Token: hash-at-rest.** Rejected for launch — needs a deterministic-hash lookup rework of
  the existing plaintext-index query for a low-sensitivity, deliberately-shared aggregate.
  Kept as documented future hardening.
- **Token: reuse a collector token.** Moot — there is no collector token (site id + origin
  allowlist). The two capabilities are already independent.
- **Reuse: thread `mode:"public"` through `appLayout`.** Rejected — couples public rendering
  to app-chrome internals (switcher, mobile tabbar, live-WS badge); a slim dedicated
  `publicLayout` reusing the *content* builders is safer and barely larger.
- **Live: public WebSocket (demo wow-factor).** Rejected — single-DO meltdown under HN load
  (see Decision 3). Server-rendered cached count gives ~90% of the wow at ~0% of the risk;
  polling `live.json` is the documented upgrade if needed.
- **Cache: KV-only (spec's literal "KV response cache").** Rejected as *primary* — a KV.get
  per request under HN RPS is billable read volume (≈39M/mo sustained → ~$14/mo) and, worse,
  offers no free per-colo absorption; Cache API in front makes KV reads happen only at the
  bounded miss rate.
- **Cache: Cache-API-only.** Viable on cost, rejected as *sole* layer — per-colo misses
  re-render and re-hit the single DO on every cold colo (~50× more DO load under a global
  burst). KV as second tier is the cheap fix and is already provisioned.
- **Cache: fixed/predictable nonce to simplify caching.** Rejected — a predictable nonce
  guts CSP. Per-cache-entry random nonce (stored with the body) keeps CSP meaningful and
  cacheable.

## Consequences

- **What it fixes.** skopia.dev gets a logged-out, load-proof demo URL at `/share/<token>`
  covering the six spec views; the placeholder partial `/public/:token` is retired; the KV
  `CACHE` binding gains its first real use with a documented pattern reusable by the app views
  later.
- **What it costs.** A slim `publicLayout` duplicates ~40 lines of chrome (accepted for
  decoupling). A per-cache-entry (not per-request) nonce on public pages — documented, low
  risk given full output escaping. A ≤60s post-revocation cache window — documented. `/share/*`
  is excluded from the root `securityHeaders` middleware and owns its own headers — a new
  invariant to preserve (the share handler MUST set the full hardening header set).
- **What we're committed to.** The public surface stays **read-only and single-site**: no
  switcher, no settings, no goals, no other site — enforced by test. Any future "live-ticking
  public count" must go through the polling+Cache-API path, **never** a per-visitor DO socket
  (limit #1). `wrangler.jsonc` is untouched (CACHE binding already present); no migration
  (column already present).
- **Watch.** First load test post-launch: confirm Cache API hit-ratio is ~99% and that
  `SiteLive` `snapshot()` call volume tracks the render-miss rate (not the request rate). If
  snapshot volume tracks requests, the KV second tier isn't engaging — investigate before
  assuming the DO is safe.

---

## Implementation outline (for a `# Task N` plan)

Decisions above are final; this section is enough to write the plan without re-deriving them.

### Files touched

- **`src/index.ts`** — one-line predicate change: exclude `/share/` from the nonce-rewriting
  `securityHeaders` middleware, mirroring the existing `/e` exclusion
  (`c.req.path === "/e" || c.req.path.startsWith("/share/") ? next() : securityHeaders(...)`).
- **`src/dashboard/index.ts`** —
  - Remove `GET /public/:token`.
  - Add `publicSecurityHeaders(nonce): Record<string,string>` (CSP identical in shape to
    `securityHeaders`, using the passed nonce, + `X-Content-Type-Options`, `Referrer-Policy`,
    `X-Frame-Options`, HSTS, `Permissions-Policy`, `X-Robots-Tag: noindex, nofollow`).
  - Add `publicNav`/`publicLayout(view, site, token, headerRight, content, nonce, rangeKey,
    liveCount|null)` — reuses `skopiaLogo`, `NAV_ITEMS` (minus geography), `rangePicker`, and
    the shared content builders; hrefs → `/share/:token/…`; "read-only" + "N online now" +
    "Powered by Skopia" chrome; **no** switcher/health/liveScript.
  - Add `cachedPublicResponse(c, cacheKey, ttl, render): Promise<Response>` — read-through:
    `caches.default.match` → `env.CACHE.get(key,{cacheTtl:60})` → `render()`; on render, bake
    the DO `snapshot()` count (try/catch, hidden on failure); `waitUntil` both `KV.put` and
    `cache.put`. Build the `Request` key from a stable synthetic URL, e.g.
    `new Request("https://cache.local/" + cacheKey)`.
  - Add the six `GET /share/:token[...]` routes. Each: shape-filter token → `getSiteByPublicToken`
    → generic 404 → `parseRange` → cache key `share:v1:{site.id}:{view}:{range.key}:{utcDay}`
    → `cachedPublicResponse`. The `render` closure runs the same `Promise.all` query set the
    matching `/app/*` route uses, then the same content builders, wrapped in `publicLayout`.
- **`src/db/queries.ts`** — no change (`getSiteByPublicToken` already exists). Optionally add
  `getShareViewData` composites only if the route closures get repetitive; not required.

### New routes / queries / migrations

- **Routes:** `GET /share/:token`, `/share/:token/{pages,sources,devices,campaigns,events}`.
  (Optional post-launch: `GET /share/:token/live.json`.)
- **Queries:** none new — reuse `getStatCards`, `getTimeSeries`, `getTopPages/Sources/Countries/
  Devices/Browsers/OperatingSystems/UtmSources/UtmMediums/UtmCampaigns/Events`.
- **Migrations:** **none.** `public_token` + unique index exist (0001). Do **not** add one.
- **`wrangler.jsonc`:** **do not touch** — `CACHE` KV + `SITE_LIVE` DO bindings already present.
- **Docs:** add the mint/rotate/revoke `wrangler d1 execute` procedure + the optional
  `/share/*` rate-limiting-rule note to `docs/install.md`.

### Test strategy (`@cloudflare/vitest-pool-workers`, TDD)

New `test/dashboard/share.test.ts` (mock `src/db/queries.ts` as the existing
`test/dashboard/dashboard.test.ts` does; the existing `/public/:token` cases there get
migrated to `/share/:token`). Write these **red first**, in order — (1) and (2) are the
load-bearing correctness invariants:

1. **Nonce consistency (the cache correctness test).** GET `/share/:token` twice; assert
   (a) the response CSP header `nonce-…` value equals the nonce on a `<script nonce="…">`/
   `<style nonce="…">` in the body, and (b) the nonce is **identical across the two requests**
   — which simultaneously proves the second was a cache hit reusing the stored body.
2. **Isolation.** Seed two sites; assert site B's name/domain and any `/app`, `/login`,
   settings, or goals link are **absent** from site A's share page; assert **no** `Set-Cookie`.
3. **404 semantics.** Unknown, revoked (`public_token=NULL`), and malformed tokens each →
   404 with a byte-identical generic body and `X-Robots-Tag: noindex`.
4. **View coverage.** Each of the six routes → 200 and contains its expected data marker;
   geography route is absent (404 or not registered).
5. **No public live socket.** Body contains no `new WebSocket(` / `/live?site=`; the
   "online now" badge renders a number (or is absent when the mocked `snapshot()` throws).
6. **Cache headers.** 200 responses carry `Cache-Control: public, s-maxage=60` (or ≥60).
7. **Roadmap-7 regression.** Unauthenticated GET `/live?site=…` still redirects/401s; the
   `/live` route is unchanged.

Miniflare provides `caches.default`, `env.CACHE` (KV), and the `SITE_LIVE` DO in-pool, so
hit/miss and DO-snapshot behavior are all assertable without network.

### Suggested task slicing

- **Task 1** — middleware exclusion + `publicSecurityHeaders` + failing nonce-consistency test.
- **Task 2** — `publicLayout`/nav + overview `/share/:token` route (uncached) + isolation/404/
  view tests green.
- **Task 3** — `cachedPublicResponse` (Cache API + KV read-through) + DO-snapshot count; cache
  + nonce-consistency tests green.
- **Task 4** — remaining five view routes.
- **Task 5** — docs: mint/rotate/revoke procedure + rate-limit note in `docs/install.md`;
  enable the token on skopia.dev's site; load test.

## Open risks & confidence

- **HIGH confidence** — token model, route surface, no-public-WS, isolation/privacy: standard,
  well-scoped, matches existing schema and precedent.
- **HIGH confidence** — cost model orders of magnitude: pricing cited below; every primitive
  has large headroom. Exact miss counts depend on real colo distribution (the ~50-colo and
  ~1M-request figures are illustrative), but the *conclusion* (≈$0, no limit approached) is
  robust to an order-of-magnitude error.
- **MEDIUM confidence, mitigated** — whether `cacheTtl`-served KV reads are billed as
  operations is **not confirmed in current docs**. The design does **not** depend on it: the
  Cache API (unbilled) fronts KV, so KV reads occur only at the bounded miss rate regardless.
  Flagged so no one later "optimizes" by removing the Cache API layer and reintroducing a
  KV.get-per-request cost/limit exposure.
- **Risk to watch** — the per-cache-entry (shared, ≤60s) nonce is a conscious relaxation of
  per-request nonces. It is safe *only while the public page reflects no user input into
  script context*. Any future public feature that echoes a query param/token into inline JS
  must revisit this (or move that route off the shared-nonce cache path).

### Sources (pulled 2026-07-05)

- Workers KV pricing (reads $0.50/M after 10M/mo incl.; writes $5/M after 1M/mo incl.;
  storage $0.50/GB-mo after 1GB): https://developers.cloudflare.com/kv/platform/pricing/
- KV `cacheTtl` minimum 30s; edge local+regional cache; ≤60s cross-region propagation:
  https://developers.cloudflare.com/kv/api/read-key-value-pairs/
- Durable Objects pricing (requests $0.15/M after 1M/mo incl.; duration $12.50/M GB-s after
  400k GB-s/mo incl.; WS incoming billed 20:1, outgoing free; hibernation avoids idle-duration
  billing): https://developers.cloudflare.com/durable-objects/platform/pricing/
- D1 pricing (rows read: 25B/mo incl. then $0.001/M; rows written: 50M/mo incl. then $1/M;
  storage 5GB incl. then $0.75/GB-mo): https://developers.cloudflare.com/d1/platform/pricing/
- Workers pricing (requests 10M/mo incl. then $0.30/M; CPU 30M ms/mo incl. then $0.02/M ms):
  https://developers.cloudflare.com/workers/platform/pricing/
- Workers Cache API (`caches.default`; per-colo/unreplicated; GET-only; never caches
  `Set-Cookie`; no separate pricing): https://developers.cloudflare.com/workers/runtime-apis/cache/

# Harden-and-Launch Sprint — Implementation Plan

> **STATUS: SHIPPED (historical).** This early hardening sprint landed; later hardening is
> continued in
> [`2026-07-04-review-hardening-and-cutover.md`](2026-07-04-review-hardening-and-cutover.md).
> Durable record; checkboxes were tracked during execution.

> **For agentic workers:** execute task-by-task; each task ends with an independently testable
> deliverable and a commit. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the merged Stratus MVP actually deployable and actually privacy-respecting, so the
two product promises — *privacy-first* and *self-host in minutes* — become provable rather than
contradicted in the shipped code.

**Why now (PM call, 2026-06-21):** harden-and-launch beats building funnels next. A wedge feature
can't leverage an announcement we haven't earned the right to make, and two of our shipped
promises are currently false in `main`. Funnels stays the v1.1 marquee fast-follow.

**Architecture decisions (cloudflare-tech-lead, 2026-06-21):** baked into the tasks below.
1. Serve vendored fonts + jsVectorMap from **Cloudflare Workers Static Assets** (`public/` dir on
   the same Worker — stays single-Worker; implements ADR-0005's "SSR + API + static assets").
2. CSP via **per-request nonce + `'strict-dynamic'`** in one shared root Hono middleware.
3. Cold-account deploy is **not reproducible today** — fix secret-provisioning + D1 schema before
   the < 10 min TTFD claim is measurable.

**Tech Stack:** TypeScript strict · Cloudflare Workers (single Worker) · Hono SSR · Wrangler
^4.103.0 · Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- **License:** AGPL-3.0-or-later. **Language:** TypeScript strict.
- **Single Worker** topology — no new deploy target. The tracking-script route (`src/index.ts:39`,
  `/stratus.js` from the embed string) stays a Worker route (size-contract); it does **not** move to `public/`.
- **Tracking script budget < 2 KB gz** — this sprint does not touch `src/script/`; do not regress.
- **Privacy by default** — the whole point of this sprint: **zero third-party requests** from any
  rendered page after Task 3. A CI guard enforces it.
- `npm run ci` must stay green (typecheck → tests → build:script → check:size → check:cookieless),
  with the new `check:no-external` guard added to the chain.
- Fail **closed**, never silently: a missing crypto secret must surface a clear error, never sign
  with `undefined`.

---

## Priorities

| P | Task | Why |
|---|------|-----|
| **P0** | 1. Cold-account secret provisioning + fail-closed guard | Collector 500s / sessions forgeable without it — *the product collects nothing* |
| **P0** | 2. D1 schema on a cold account | `/setup` 500s on empty D1 — *no one can even create the owner account* |
| **P0** | 3. Self-host fonts + vendor jsVectorMap | Leaks every visitor's IP to Google/jsDelivr — *contradicts the privacy thesis* |
| **P1** | 4. CSP + security headers | Defense-in-depth; credibility for a security-positioned product |
| **P1** | 5. Honest "bounce rate" label | Accuracy positioning (ADR-0003) — don't show a misleading metric |
| **P1** | 6. Deploy docs + cold-account E2E test | The deploy story is a documented feature; makes TTFD measurable |

**Out of scope (human-run, needs the user's Cloudflare account):** the actual clean-account
"Deploy to Cloudflare" run, the live TTFD measurement, and dogfooding on the landing page. This
sprint makes those *possible and instrumented*; the human executes them.

**Explicitly deferred** (stay in `2026-06-21-mvp-followups.md`): KV response cache, rollup
backfill, per-page bounce column, avg-session-time + period-over-period delta cards, R2 archival.
YAGNI until dogfooding shows a real signal.

---

## File structure

```
public/                              NEW — served by Workers Static Assets
  fonts/*.woff2                      Latin-subset Space Grotesk / Hanken Grotesk / JetBrains Mono
  vendor/jsvectormap@1.6.0/
    jsvectormap.min.css
    jsvectormap.min.js
    world.js                         (lazy-loaded, geography view only)
scripts/
  fetch-vendor.mjs                   NEW — downloads pinned fonts + jsVectorMap into public/
  build-schema.mjs                   NEW — generates src/shared/schema-embed.ts from migrations/
  check-no-external.mjs              NEW — CI guard: fail on any third-party host in src/ or public/
src/shared/
  config.ts                          NEW — requireSecrets() fail-closed guard
  schema.ts                          NEW — ensureSchema(db): idempotent CREATE TABLE IF NOT EXISTS
  schema-embed.ts                    NEW (generated) — SCHEMA_SQL string from 0001_init.sql
  security-headers.ts                NEW — Hono middleware: per-request nonce + CSP + headers
src/index.ts                         MODIFY — mount securityHeaders middleware at root
src/dashboard/index.ts               MODIFY — @font-face, /vendor refs, nonce threading, label
src/marketing/index.ts               MODIFY — @font-face, nonce threading, label
src/collector/index.ts               MODIFY — requireSecrets guard before crypto
wrangler.jsonc                       MODIFY — add "assets" block
package.json                         MODIFY — cloudflare.bindings + scripts + ci chain
.dev.vars.example                    NEW — documents the 4 deploy secrets
README.md                            MODIFY — real deploy + secret-generation walkthrough
```

---

## Task 1 — Cold-account secret provisioning + fail-closed guard  **(P0)**

**Problem:** `IDENTITY_HMAC_SECRET`, `AUTH_COOKIE_SECRET`, `CF_ACCOUNT_ID`, `WAE_API_TOKEN` are read
(`src/collector/index.ts:179`, `src/dashboard/index.ts:228/782/810`, `src/rollup/index.ts:113/116`)
but never set. No `.dev.vars.example`, no `cloudflare.bindings`. Cold deploy → all undefined →
collector `crypto.subtle.importKey(undefined)` throws (500, zero ingest); cookies sign with key
`undefined` (forgeable sessions).

**Files:** Create `.dev.vars.example`, `src/shared/config.ts`. Modify `package.json` (add
`cloudflare.bindings`), `src/collector/index.ts`, `src/dashboard/index.ts`. Test:
`test/config.test.ts`.

**Interfaces — Produces:**
```ts
// src/shared/config.ts
/** Throws SecretsMissingError listing the unset names. Call at request entry, before any crypto. */
export function requireSecrets(env: Env, names: ReadonlyArray<keyof Env>): void;
export class SecretsMissingError extends Error { constructor(public missing: string[]) }
```

- [ ] **Step 1 — failing test:** `requireSecrets({} as Env, ["AUTH_COOKIE_SECRET"])` throws
  `SecretsMissingError` whose `.missing` is `["AUTH_COOKIE_SECRET"]`; with the secret present it does not throw.
- [ ] **Step 2 — run, expect FAIL** (`config.ts` not found).
- [ ] **Step 3 — implement** `requireSecrets` (treat empty string / undefined as missing) and `SecretsMissingError`.
- [ ] **Step 4 — wire fail-closed seams.** In `handleCollect` (before `deriveVid`) call
  `requireSecrets(env, ["IDENTITY_HMAC_SECRET"])`; catch `SecretsMissingError` → return `503`
  (`"collector not configured"`), never an unhandled throw. In the dashboard auth/login/setup paths
  call `requireSecrets(c.env, ["AUTH_COOKIE_SECRET"])`; on miss render a clear "not configured —
  see deploy docs" page (500), never sign with `undefined`.
- [ ] **Step 5 — `.dev.vars.example`** (root):
  ```
  # Copy to .dev.vars for local dev; set as encrypted secrets in production (Deploy button prompts for these).
  AUTH_COOKIE_SECRET=    # session signing key — openssl rand -hex 32
  IDENTITY_HMAC_SECRET=  # cookieless visitor-hash key — openssl rand -hex 32
  CF_ACCOUNT_ID=         # Cloudflare account ID (Workers dashboard → Account ID)
  WAE_API_TOKEN=         # API token with "Account Analytics: Read" (for dashboard queries)
  ```
- [ ] **Step 6 — `package.json` `cloudflare.bindings`** so the Deploy-to-Cloudflare button prompts:
  ```jsonc
  "cloudflare": {
    "bindings": {
      "AUTH_COOKIE_SECRET":   { "description": "Session signing key. Generate: openssl rand -hex 32" },
      "IDENTITY_HMAC_SECRET": { "description": "Cookieless visitor-hash key. Generate: openssl rand -hex 32" },
      "CF_ACCOUNT_ID":        { "description": "Your Cloudflare account ID (Workers → Account ID)." },
      "WAE_API_TOKEN":        { "description": "API token with Account Analytics: Read, for dashboard queries." }
    }
  }
  ```
- [ ] **Step 7 — run tests + typecheck, expect PASS.** Add a collector test: secret unset → 503 (not a thrown 500).
- [ ] **Step 8 — commit:** `feat(deploy): fail-closed secret guard + document deploy secrets`.

---

## Task 2 — D1 schema on a cold account  **(P0)**

**Problem:** auto-provisioning creates an *empty* D1; it never runs `migrations/0001_init.sql`. No
runtime schema bootstrap exists (only a comment in `types.ts:205`). Cold account → `/setup`'s
`getOwner()` `SELECT … FROM users` throws → setup 500s.

**Decision (tech-lead):** lazy idempotent bootstrap in the Worker — most cold-account-robust (no CI
step the Deploy button can skip). Single source of truth: generate the embedded SQL from the
migration file so the runtime DDL and `migrations/` never drift.

**Files:** Create `scripts/build-schema.mjs`, `src/shared/schema.ts`, `src/shared/schema-embed.ts`
(generated). Modify `package.json` (add `build:schema`, call it in `build`), `src/dashboard/index.ts`
(call `ensureSchema` before first D1 read in setup). Test: `test/schema.test.ts`.

**Interfaces — Produces:**
```ts
// src/shared/schema.ts
/** Idempotently creates all tables (CREATE TABLE IF NOT EXISTS …). Cached per isolate; safe to call on every request. */
export function ensureSchema(db: D1Database): Promise<void>;
```

- [ ] **Step 1 — `scripts/build-schema.mjs`:** read `migrations/0001_init.sql`, emit
  `src/shared/schema-embed.ts` exporting `export const SCHEMA_SQL = ` + JSON-stringified file. (Mirrors `scripts/build-embed.mjs`.) The migration already uses `CREATE TABLE IF NOT EXISTS`; if any statement does not, make it idempotent in the migration (and re-run the test harness).
- [ ] **Step 2 — failing test:** against a **fresh** D1 with **no** migrations applied, calling
  `ensureSchema(db)` then `SELECT name FROM sqlite_master WHERE type='table'` returns the expected
  tables (`sites`, `users`, `goals`, `rollup_daily`). Run, expect FAIL.
- [ ] **Step 3 — implement** `ensureSchema`: split `SCHEMA_SQL` into statements and run via
  `db.exec`/batched `db.prepare().run()`; guard with a module-level `let ready: Promise<void> | null`
  so concurrent requests share one bootstrap and it runs once per isolate.
- [ ] **Step 4 — call site:** in the dashboard `/setup` GET+POST (and any cold read path) `await ensureSchema(c.env.DB)` before the first query.
- [ ] **Step 5 — `package.json`:** `build:schema` runs `node scripts/build-schema.mjs`; `build` runs `build:schema` then `build:script`.
- [ ] **Step 6 — run full `ci`, expect PASS** (existing `test/apply-migrations.ts` still applies migrations for other tests; the new test specifically proves the no-migration cold path).
- [ ] **Step 7 — commit:** `fix(deploy): bootstrap D1 schema on cold accounts`.

---

## Task 3 — Self-host fonts + vendor jsVectorMap  **(P0, privacy)**

**Problem:** Google Fonts `<link>` (`src/marketing/index.ts:148-150`, `src/dashboard/index.ts:242-244`)
and jsVectorMap from jsDelivr (`src/dashboard/index.ts:1052/1086/1089`) send every visitor's IP to
third parties.

**Files:** Create `public/**`, `scripts/fetch-vendor.mjs`, `scripts/check-no-external.mjs`. Modify
`wrangler.jsonc`, `package.json`, `src/dashboard/index.ts`, `src/marketing/index.ts`.

- [ ] **Step 1 — `scripts/fetch-vendor.mjs`:** download into `public/`:
  - jsVectorMap 1.6.0 `jsvectormap.min.css`, `jsvectormap.min.js`, `maps/world.js` →
    `public/vendor/jsvectormap@1.6.0/`.
  - Latin + latin-ext woff2 for Space Grotesk (400/500/600/700), Hanken Grotesk (400/500/600/700),
    JetBrains Mono (400/500) → `public/fonts/`. Drop Cyrillic/Greek/Vietnamese ranges.
  Commit the fetched files (simplest for the Deploy button; bump = deliberate PR).
- [ ] **Step 2 — `wrangler.jsonc`:** add
  ```jsonc
  "assets": { "directory": "./public", "not_found_handling": "none", "html_handling": "none" }
  ```
  No `binding` (Worker never fetches assets); HTML stays 100% SSR (asset layer answers only `/fonts/*`, `/vendor/*`).
- [ ] **Step 3 — fonts:** replace the three `<link>` lines in each file with `@font-face` rules
  (added to the existing inline `<style>`) pointing at `/fonts/*.woff2`, `font-display: swap`,
  `Cache-Control: public, max-age=31536000, immutable` is provided by the asset pipeline. Remove the
  `preconnect` to `fonts.googleapis.com`/`fonts.gstatic.com`.
- [ ] **Step 4 — map:** point `src/dashboard/index.ts:1052/1086/1089` at
  `/vendor/jsvectormap@1.6.0/jsvectormap.min.css|jsvectormap.min.js|world.js` (same-origin).
- [ ] **Step 5 — `scripts/check-no-external.mjs`:** scan `src/**` and rendered output for
  `googleapis|gstatic|jsdelivr|unpkg|cdnjs|cdn\.` → exit non-zero on any hit. Add `check:no-external`
  to scripts and to the `ci` chain.
- [ ] **Step 6 — run `ci` (incl. new guard), expect PASS.** Verify the geography view still renders
  the map from the same-origin asset (Playwright smoke optional: load `/app/geography`, assert no
  failed/3rd-party network requests).
- [ ] **Step 7 — commit:** `feat(privacy): self-host fonts + vendor jsVectorMap (zero third-party requests)`.

---

## Task 4 — CSP + security headers  **(P1)**

**Files:** Create `src/shared/security-headers.ts`. Modify `src/index.ts` (mount once at root),
`src/dashboard/index.ts` + `src/marketing/index.ts` (thread nonce into the 6 inline blocks:
dashboard `267/487/623/1068`, marketing `151/526`). Test: `test/security-headers.test.ts`.

**Interfaces — Produces:** a Hono middleware `securityHeaders` that, per request, sets
`c.set("nonce", <hex>)` and attaches the headers below. Inline blocks read `c.get("nonce")`.

- [ ] **Step 1 — failing test:** a response through the middleware carries a `Content-Security-Policy`
  header containing `script-src 'self' 'nonce-` and `frame-ancestors 'none'`, plus
  `X-Content-Type-Options: nosniff`; two requests get **different** nonces.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Nonce = `crypto.randomUUID().replace(/-/g, "")`. CSP:
  ```
  default-src 'self'; script-src 'self' 'nonce-{N}' 'strict-dynamic'; style-src 'self' 'nonce-{N}' 'unsafe-inline';
  font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';
  form-action 'self'; object-src 'none'
  ```
  Plus: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
  `Permissions-Policy: geolocation=(), microphone=(), camera=()`. (One comment documents the
  `'strict-dynamic'` rule: any future `<script src>` must be nonced.) `style-src` keeps
  `'unsafe-inline'` to cover existing `style="…"` attributes — moving them to classes is a
  documented fast-follow; `script-src` stays strict (no `'unsafe-inline'`).
- [ ] **Step 4 — mount once** in `src/index.ts` before `app.route(...)` so every response (incl.
  collector + marketing) is covered.
- [ ] **Step 5 — thread the nonce** into the 6 inline `<script>`/`<style>` blocks via the
  page-builder functions (`htmlDoc`, `liveScript`, the geography/country view, setup/login,
  marketing). The map block's runtime `createElement('script')` is covered by `'strict-dynamic'`
  (nonced parent), now loading same-origin `/vendor/*`.
- [ ] **Step 6 — run `ci`, expect PASS.** Manual/Playwright check: load `/app` and `/` → zero CSP
  violations in the console.
- [ ] **Step 7 — commit:** `feat(security): CSP nonce + security headers on all responses`.

---

## Task 5 — Honest "bounce rate" label  **(P1)**

**Problem:** the metric is a single-page-visit proxy (`src/db/queries.ts:91-103`) shown as "Bounce
Rate" (`src/dashboard/index.ts:386`, demo card `src/marketing/index.ts:300`). For an
accuracy-positioned product (ADR-0003), that's misleading.

**Decision (PM):** relabel for launch (don't fake a session metric we don't have).

**Files:** `src/dashboard/index.ts:386`, `src/marketing/index.ts:300`, `src/shared/types.ts:300`
(doc comment). Test: update `test/dashboard/dashboard.test.ts`, `test/marketing/marketing.test.ts`.

- [ ] **Step 1 — update tests** to assert the new label `Single-Page Visits` (and that the old
  `Bounce Rate` string is gone). Run, expect FAIL.
- [ ] **Step 2 — relabel** the dashboard stat-card and the marketing demo card to
  `Single-Page Visits`; update the `StatCards.bounceRate` doc comment to state it's the
  single-page-visit share (keep the field name to avoid churn across queries/tests; rename is a
  separate optional cleanup).
- [ ] **Step 3 — run `ci`, expect PASS.**
- [ ] **Step 4 — commit:** `fix(honesty): label the single-page-visit proxy accurately`.

---

## Task 6 — Deploy docs + cold-account E2E test  **(P1)**

**Files:** Modify `README.md`. Test: `test/deploy-cold.test.ts` (integration).

- [ ] **Step 1 — README:** replace stale "no product code"/"Pages" copy with: the Deploy-to-Cloudflare
  flow, the secret-generation walkthrough (`openssl rand -hex 32` for the two crypto secrets;
  click-through for `WAE_API_TOKEN` — the one secret a user can't `openssl`-generate), what
  auto-provisions (D1/KV/DO) vs. what's prompted (secrets), and the expected first-pageview time.
- [ ] **Step 2 — cold-account integration test:** with a fresh D1 (no migrations) and unset crypto
  secrets, assert the product degrades **gracefully** — `/setup` works after `ensureSchema`,
  collector returns `503` (not a thrown 500) when `IDENTITY_HMAC_SECRET` is unset, and login refuses
  to sign with an unset `AUTH_COOKIE_SECRET`. This is the automatable proxy for ADR-0006's
  clean-account test; the live run stays human-executed.
- [ ] **Step 3 — (optional) pin Wrangler exact** (`"wrangler": "4.103.0"`). Low priority —
  `package-lock.json` already pins transitively.
- [ ] **Step 4 — run `ci`, expect PASS.**
- [ ] **Step 5 — commit:** `docs(deploy): cold-account deploy guide + graceful-degradation test`.

---

## Definition of done

- `npm run ci` green (now including `check:no-external`).
- A grep of rendered dashboard + marketing HTML shows **zero** third-party hosts.
- A simulated cold account (fresh D1, unset secrets) degrades gracefully, and after secrets+setup the
  full loop works in tests.
- README documents a deploy a stranger can follow.
- **Handoff to human:** run the real "Deploy to Cloudflare" on a clean account, measure median TTFD
  + setup-failure rate (ADR-0006 / product-plan §3 Phase 5), and dogfood on the landing page. This
  plan makes that run possible and instrumented; it does not perform it.

## Cross-lane notes

- ADR-0005 already says "Single Worker (SSR + API + static assets)" — Task 3 implements it; no ADR
  change. Add one line to ADR-0006 noting assets ship with the Worker version (nothing to provision)
  and that the Deploy button prompts for the four secrets.
- If the operator later splits the collector to `collect.<domain>`, `connect-src 'self'` must gain
  that origin (documented `COLLECTOR_ORIGIN` var) — out of scope for the default deploy.

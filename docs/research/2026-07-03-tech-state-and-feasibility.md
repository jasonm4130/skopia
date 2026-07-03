# Skopia — Technical State-of-the-Repo & Feasibility Sweep

- **Date:** 2026-07-03
- **Author:** `cloudflare-tech-lead` agent
- **Purpose:** Feed the parallel product-roadmap exercise. This is a *feasibility/cost/constraint*
  assessment — HOW we build and what it costs — not a feature-priority call (that is the PM's lane).
- **Scope swept:** `src/` (collector, dashboard, rollup, shared, script), `test/` (225 tests, all
  passing), `migrations/`, `wrangler.jsonc`, `package.json`, `docs/specs/*`, all ADRs
  `docs/decisions/0001–0010`, plans `2026-06-21-harden-and-launch.md`,
  `2026-06-21-mvp-followups.md`, `2026-06-29-do-incremental-counters.md`, and
  `docs/research/2026-06-21-cloudflare-architecture.md`.
- **Verification:** load-bearing Cloudflare limits/prices re-fetched from live docs 2026-07-03 —
  see §7 verification log. Where a number is inferred, it says so with a confidence level.

---

## 0. Executive summary — top 5 findings

1. **The MVP is built, hardened, and green.** All 6 harden-and-launch tasks are done (secret
   fail-closed guard, cold-account D1 bootstrap, self-hosted fonts + vendored map, CSP/nonce,
   honest metric labels, deploy docs + cold-account test). `pnpm test` = **225/225 pass**; tracking
   script is **558 B gzipped** against the 2 KB budget (`scripts/check-script-size.mjs`) — ~1.49 KB
   of headroom. The byte budget is **not** a live constraint on new script features.

2. **Two rollup systems run in parallel right now (Phase 1), by design but as live transitional
   debt.** The 5-min cron (`src/rollup/index.ts`) still writes `rollup_daily`; the `SiteLive` DO
   (`src/dashboard/site-live.ts`) writes `rollup_daily_shadow` (`FLUSH_TABLE`, `site-live.ts:32`).
   The durability bug (ADR-0010) is fixed. Phase 2 (flip `FLUSH_TABLE` → `rollup_daily`, retire
   cron, drop shadow, lower salt TTL, delete `rotateDailySalt`) is **committed-pending the parity
   re-gate** on settled day 2026-07-03 (runs on/after 2026-07-04). Treat Phase 2 as done-bar-a-gate,
   not roadmap material.

3. **The query/data layer is far ahead of the UI.** `src/db/queries.ts` already ships
   `getTopEvents`, `getTopUtmSources`, `getTopDevices`, `getTopBrowsers`, `getTopOperatingSystems`,
   `listGoals`, `getRealtimeCount` — **none are called by any dashboard route** (verified: routes are
   only Overview/Pages/Sources/Geography). Custom events, UTM/campaigns, device/browser/OS, and goals
   are ingested **and rolled up end-to-end into `rollup_daily`**, but have **no view**. This makes
   several "new features" **UI-only (S)**, not new-pipeline work.

4. **The DO durability fix (ADR-0010) is now the dominant *billed* cost, and it re-ordered the
   free-tier ceiling.** DO SQLite storage billing went live Jan 2026 (confirmed 2026-07-03), so the
   +1 durable `put()`/event is real money on Workers Paid; WAE writes are still **$0** ("you will not
   be billed currently", confirmed 2026-07-03). The ADR's "~$15/mo @ 20M events" checks out
   arithmetically (§6). But on the **Free plan** the DO's ~3.25 rows-written/event now binds at
   **~0.9M events/mo** (100k DO rows/day ÷ 3.25) — roughly **3× tighter** than the WAE 100k-writes/day
   (~3M/mo) ceiling the 2026-06-21 spec §9 named as "first to bite". The free-tier cost story shifted
   under the DO redesign and the old spec doesn't reflect it.

5. **Two hard architectural walls that bound whole feature categories — surface these to the PM
   before they get promised:**
   - **No cross-day unique visitors is possible by design.** The daily-salt rotation
     (`src/shared/identity.ts`, ADR-0002) changes every visitor's `vid` at UTC midnight, so
     "unique visitors over 30 days" is *unavoidably* "sum of daily uniques" (over-counts; honestly
     tooltip'd at `dashboard/index.ts:533`). True period-uniques would require weakening the
     cookieless model — a privacy regression, not a bug fix.
   - **There is no sessionization.** `entryPath` is hardcoded to the current path ("no session
     tracking", `collector/index.ts:226`); no per-visitor session store exists. Real bounce rate,
     session duration, entry/exit pages, **and funnels** all need per-visitor ordered-event state
     that (a) doesn't exist and (b) can't cross a UTC-midnight `vid` rotation. The spec's "funnels
     are a cheap fast-follow because events are stored generically" is **too optimistic** (§6, funnels
     row): the event *names* are stored, but not in a per-visitor-sequence-queryable shape, and WAE
     has no JOIN/self-join.

---

## 1. Architecture as-built vs. the specs (drift)

The 5-primitive backbone (WAE + D1 + DO + KV, R2/Queues opt-in) matches ADR-0001 and the technical
spec. Real deviations:

| # | Spec / ADR says | Code does | Type | Cite |
|---|---|---|---|---|
| D1 | Collector = "a second Worker (or a route)" (tech-spec §9.1) | Single Worker, collector as route `POST /e` | **Deliberate, documented** | `wrangler.jsonc:1-12`, `src/index.ts:35-36` |
| D2 | Cron rollup queries WAE → `rollup_daily` (ADR-0003) | Cron **and** DO both live; DO writes `rollup_daily_shadow` in parallel | **Transitional (Phase 1)** | `src/rollup/index.ts`, `src/dashboard/site-live.ts:32` |
| D3 | KV `CACHE` caches dashboard responses 60–120 s (ADR-0003 §5.3) | `CACHE` binding **never referenced in `src/`** — every load hits D1 | **Unimplemented** | `wrangler.jsonc:46`, grep: 0 hits |
| D4 | Marketing moved to separate repo; product Worker does `GET / → /app` redirect (ADR-0006 addendum, ADR-0007) | Product Worker **still mounts a full 554-line landing page at `/`** | **Drift — confirm intent** | `src/index.ts:53`, `src/marketing/index.ts:551` |
| D5 | Script "fires on `visibilitychange===hidden` + `pagehide` fallback" (tracking-script docstring; tech-spec §2) | Script fires pageview **on load + SPA route change only**; no `visibilitychange`/`pagehide` listener | **Doc-vs-code drift** | `src/script/skopia.ts:8-9` (claim) vs `:74,77` (reality) |
| D6 | `ensureSchema` bootstraps the cold-account D1 (harden Task 2) | Bootstrap embeds **only `migrations/0001_init.sql`** — `0002_rollup_shadow` is invisible to it | **Latent pattern bug** | `scripts/build-schema.mjs` (hardcodes `0001_init.sql`) |
| D7 | Dashboard = "Hono … JSX/SSR" (tech-spec §7.1) | SSR is **hand-built HTML template strings** with inline styles, one 1366-line file | **Minor drift (velocity tax)** | `src/dashboard/index.ts` |

Notes on the load-bearing ones:

- **D3 (KV cache unused):** harmless at self-host latency today (D1 reads are <100 ms), but it means
  the "sub-10 ms cached dashboard" claim in ADR-0003 is not delivered, and it's the cheapest perf
  lever if a dashboard ever feels slow. Deferred explicitly in `mvp-followups.md`.
- **D4 (marketing still at `/`):** `app.route("/", dashboard)` then `app.route("/", marketing)` and
  the dashboard never registers `/`, so **`app.skopia.dev/` serves the full marketing landing**, not
  the `→/app` redirect the ADR-0006 addendum describes. Either the ADR is stale or the redirect was
  never wired. Low risk, but it's a documented contract the code doesn't honor.
- **D6 (bootstrap only sees `0001`):** during Phase 1, a genuinely cold Deploy-button account that
  relies on `ensureSchema` (not `wrangler d1 migrations apply`) will **not** have
  `rollup_daily_shadow`, so DO flushes there fail silently (caught at `site-live.ts:221`). Self-heals
  at Phase 2 (flush target returns to `rollup_daily`, which *is* embedded). The real defect is
  systemic: **any future migration `0003+` is invisible to the cold-account bootstrap** unless
  `build-schema.mjs` is generalized to concatenate all migrations. Cheap to fix; worth doing before
  the next schema change ships.

---

## 2. Tech debt & open hardening items

**Harden-and-launch sprint (`2026-06-21-harden-and-launch.md`): fully DONE** (verified against code,
not the plan file). Secret guard `src/shared/config.ts` wired at `collector/index.ts:177` +
dashboard auth paths; cold bootstrap `src/shared/schema.ts` mounted `dashboard/index.ts:61`;
self-hosted `FONT_FACES` + `/vendor/*`; CSP nonce `src/shared/security-headers.ts` mounted
`index.ts:27`; "Single-Page Visits" relabel `dashboard/index.ts:538`; `test/deploy-cold.test.ts`
present. `check:no-external` in the CI chain (`package.json:24`).

**Still-open items from `2026-06-21-mvp-followups.md` (verified against code):**

| Item | Status | Cite |
|---|---|---|
| KV response cache | **Open** — `CACHE` unused | `wrangler.jsonc:46` |
| Public-dashboard live count | **Open** — `/public/:token` renders no `liveScript`; `/live` is auth-gated | `dashboard/index.ts:1064-1113`, `:1121` |
| Rollup backfill (cron only does today + 2 days) | **Open** (mooted by Phase 2 — DO owns forward counts) | `rollup/index.ts:242` |
| Per-page bounce column | **Open** — needs new rollup + `BreakdownRow` field | — |
| Avg session time + period-over-period delta cards | **Open** — needs sessionization + prior-period query | — |
| Identity daily-salt KV write race at midnight | **Open** (minor, self-corrects) | `identity.ts:56-69` |
| Custom-event props **dropped** (not truncated) over cap | **Open** | `collector/index.ts:205-209` |
| Bot heuristic bare `"bot"` substring over-matches | **Open** (false-positive risk on legit UAs) | `cf.ts:125` |

**Additional debt found in this sweep (not previously tracked):**

- **Live top-pages data is pushed but discarded.** The DO snapshot includes `topPages`
  (`site-live.ts:333-352`), but the client `liveScript` only updates `#live-count` and ignores it
  (`dashboard/index.ts:802-821`). A "live pages right now" panel is a pure UI add — data path done.
- **Seven query helpers are dead UI-wise** (see §0.3): `getTopEvents`, `getTopUtmSources`,
  `getTopDevices`, `getTopBrowsers`, `getTopOperatingSystems`, `listGoals`, `getRealtimeCount` are
  implemented in `src/db/queries.ts` and covered by tests but called by **no** route.
- **No site/settings/admin UI at all.** The empty state literally tells the operator to run
  `wrangler d1 execute … INSERT INTO sites …` (`dashboard/index.ts:1166`). No add/edit/delete-site,
  no origin-allowlist editor, no `public_token` generation/rotation, no goal CRUD. The **data model
  supports all of it** (`migrations/0001_init.sql`), the forms don't exist. This is the single
  biggest UI gap and it gates multi-site UX, goals, public sharing UX, and deploy-experience polish.
- **IP fallback can collapse identity.** `CF-Connecting-IP ?? X-Forwarded-For ?? "0.0.0.0"`
  (`collector/index.ts:189-190`): behind an unexpected proxy topology all visitors could hash to one
  `vid`. Fine on Cloudflare's own edge; a note for the "put Skopia behind your own proxy" recipe.
- **Dashboard is one 1366-line string-HTML file** (`src/dashboard/index.ts`). Not a bug, but every
  new view pays a hand-written-HTML tax; worth a JSX/component pass *before* several UI features land
  together, not after. (Effort-multiplier input for the PM, not a blocker.)

Code hygiene is otherwise strong: **zero** `TODO`/`FIXME`/`HACK`/`@ts-ignore`/`biome-ignore` in
`src/` (grep verified); strict TS; TDD throughout.

---

## 3. Cloudflare platform constraints & cost posture

### 3.1 Limits that bite (current, verified 2026-07-03)

| Limit | Value | Why it matters to Skopia | Source |
|---|---|---|---|
| WAE retention | **3 months, hard, all plans** | Caps history to 90 days; >90 days needs R2 archival, full stop | limits doc (§7) |
| WAE write (Free) | 100k data points/**day** (~3M/mo) | Free-tier event ceiling (but see DO below) | pricing doc (§7) |
| WAE sampling onset | ~100 dp/s **per index**, order-of-magnitude ⚠️ | Accuracy (not cost) wall for a single very hot site; mitigated by the `sampled` badge | research §1 |
| DO rows written (Free) | **100k/day** | **New tightest free-tier ceiling** — DO writes ~3.25×/event → binds ~0.9M events/mo | pricing doc (§7) |
| DO rows written (Paid) | 50M/mo included, **$1.00/M** after | Dominant *billed* cost of the DO-counter design | pricing doc (§7) |
| D1 | 10 GB/db, 50M writes/mo (Paid), 1000 stmts/invocation | Rollups are batched ≤100/`batch` (`site-live.ts:214`); tiny at self-host scale | research §1 |
| WAE SQL | no JOIN/UNION; undocumented 429 rate limit | Shapes funnels/sequence analysis as *impossible via a single WAE query* | research §3 |

### 3.2 Cost sanity-check of the ADR-0010 framing ("~1 row-write/event, ~$15/mo @ 20M")

**Verdict: sound on Workers Paid; Medium confidence on the absolute number (the multiplier is
inferred, as the ADR itself flags).** Arithmetic, using confirmed current rates (§7):

- `seen` writes ≈ **2.25 × events** (spec §7 factor, `WITHOUT ROWID` + daily `DROP`) → 45M @ 20M events.
- ADR-0010 adds **1 durable `put()`/event** → +20M → **~65M DO rows/mo**.
- Paid free allowance 50M → billable 15M × $1.00/M = **~$15/mo**. ✔ matches ADR-0010.
- Rejected per-dimension write-through would have been ~205M rows → ~$155/mo — the ~10× the ADR
  correctly avoided.

Two corrections/additions to the framing:

1. **It's real money now.** DO SQLite storage billing activated **Jan 2026** (confirmed 2026-07-03),
   so this ~$15 is billed today. WAE writes remain **$0** ("you will not be billed currently",
   confirmed 2026-07-03) — so **today the DO rows-written line dominates the entire bill** while WAE
   contributes nothing until Cloudflare flips billing on.
2. **Free-tier reordering.** ~3.25 total DO writes/event (2.25 `seen` + 1 `put`) against the Free
   plan's 100k DO-rows/day → **~30k events/day (~0.9M/mo)** before the DO write cap bites — ~3×
   below the WAE 100k/day (~3M/mo) cap the 2026-06-21 spec named as first-to-bite. **Recommend
   updating tech-spec §9** to name the DO rows-written ceiling as the new free-tier binding
   constraint post-ADR-0010.

### 3.3 Cost-per-million-events (marginal, Workers Paid, above free allowances)

| Line | Writes/req per event | Rate | $/M events | Billed today? |
|---|---|---|---|---|
| DO rows written | ~3.25 | $1.00/M rows | **~$3.25** | **Yes** (dominant) |
| DO requests (waitUntil fetch) | 1 | $0.15/M | ~$0.15 | Yes |
| Workers requests | 1 | ~$0.30/M ⚠️ | ~$0.30 | Yes |
| WAE writes | 1 | $0.25/M | ~$0.25 | **No** (not yet billed) |
| D1 writes | batched, ≪1/event | $1.00/M | negligible | Yes |

DO-write free ceiling on Paid ≈ 50M ÷ 3.25 ≈ **~15M events/mo free**, so the spec's "**~$5 at
10M/mo**" still holds (10M < 15M free DO rows; WAE + Workers both include 10M). At **20M** →
~$15 (DO rows) + ~$3 (DO+Workers requests over free) ≈ **~$18–21/mo**, inside the ADR's ~$20–50
envelope. ⚠️ Workers request rate is quoted from the prior spec, not re-fetched today — re-verify
before relying on the exact per-million.

**Which limit bites first, restated:** Free plan → **DO rows-written (100k/day)**. Paid plan →
**WAE adaptive sampling (accuracy)** at a single hot site long before cost. Nothing here changes the
"$0 free / ~$5 at 10M / ~$20–50 at 100M" shape; it just moves the free-tier wall inward.

---

## 4. Feasibility & effort assessment (next feature areas)

Effort = person-days for one Workers dev (S ≤ 3d, M ≈ 1–2wk, L ≥ 2wk). "Primitives" = what it
touches. "ADR" = whether it needs a recorded decision. I enumerated the candidate list; **priority
is the PM's call.**

| Feature area | Effort | Dominant technical risk | Primitives | Cost/scale impact | ADR? |
|---|---|---|---|---|---|
| **Custom-events view** (event-name counts) | **S** | None — data + `getTopEvents` done; UI-only new route + `NAV_ITEMS` entry | D1 read | none | no |
| **Custom-event property breakdowns** (e.g. `plan=pro`) | **M** | Props live only in WAE `blob13` (`propsJson`), **not rolled up** — needs WAE SQL read path *or* new rollup dim | WAE SQL / D1 | small (read-time WAE query, debounce) | light |
| **UTM / campaign reporting** | **S** | None — 3 UTM dims rolled up; needs a Campaigns view + `getTopUtm{Medium,Campaign}` helpers (only `Source` exists) | D1 read | none | no |
| **Device / Browser / OS view** | **S** | None — dims + query helpers already built, zero callers | D1 read | none | no |
| **Goals / conversions** | **M** | No admin UI exists to CRUD goals; `path_prefix` match isn't a rollup dim (exact `page` values only → prefix needs a scan/derived dim) | D1 | small | yes (goal-eval model) |
| **Data export / stats API** | **S–M** | Auth model: only cookie auth today; reuse/extend `public_token` for API keys; shape + rate-limit | Worker route + D1 (+R2 for bulk) | negligible reads | light |
| **Realtime: live top-pages panel** | **S** | None — DO already pushes `topPages`; client ignores it | DO + WS | none | no |
| **Realtime: public-dashboard live** | **S–M** | Token-scoped `/live` auth path (currently `requireAuth`-gated); no DO change | DO + WS | none | no |
| **Multi-site / settings admin UI** | **M** | No forms-with-auth pattern beyond login/setup; needs site CRUD, allowlist editor, token gen — the biggest missing UI surface | D1 + dashboard | none | no |
| **Self-host deploy polish** ("add your first site" flow, verified clean-account run) | **M** | Clean-account "Deploy to Cloudflare" run **never verified E2E** (ADR-0006 still human-pending); the `build-schema` "only 0001" bug (D6) | Deploy button + D1 | none | no |
| **Retention controls — shorten + prune D1 rollups** | **S** | `RETENTION_DAYS` var exists but unused; WAE cap is 3mo hard (can only shorten) | D1 + var | none | light |
| **Retention / archival >90 days (R2)** | **L** | Pipelines + R2 SQL are **beta surfaces**; needs a caching layer (Icelight warning); matches spec's L/3wk | R2 + Pipelines/Queues | adds Queues 3-ops/msg + R2 storage | **yes** (touches 0001/0003) |
| **Script: outbound-link / file-download / scroll / Web-Vitals** | **S–M** each | **Byte budget is NOT the constraint** (1.49 KB headroom). Real costs: (a) needs a `visibilitychange`/`pagehide` handler that doesn't exist yet (D5); (b) each new auto-event is another beacon → another ~3.25 DO writes → **multiplies per-event cost** (2–3× event volume ⇒ 2–3× DO bill) | script + collector + WAE slots + rollup + UI | **material** — event-volume multiplier on the dominant cost line | maybe (event-volume cost) |
| **Funnels** | **L** (spec said M — **correcting down-scope claim**) | **No sessionization + WAE has no JOIN/self-join.** Event *names* are stored but not per-visitor ordered sequences; needs a new session/sequence store, and the daily-`vid` rotation means a funnel can't cross UTC midnight | new store (DO or D1 sessions) + WAE | new write path; cost depends on design | **yes** (new data model) |
| **Session metrics** (real bounce, duration, entry/exit pages) | **M–L** | Same root as funnels: no session store; `entryPath` is hardcoded (`collector/index.ts:226`); can't cross midnight `vid` rotation | new session store | new write path | **yes** |
| **Accurate period-unique visitors** | **N/A (architectural)** | **Impossible without a privacy regression** — daily-salt rotation makes cross-day dedup fundamentally unavailable; current behavior (sum of daily uniques) is the honest ceiling | — | — | would need to revisit ADR-0002 |

### 4.1 The two feasibility corrections the PM most needs

- **Funnels are L, not M.** The 2026-06-21 tech-spec §8/§10 priced funnels at ~2 wk on the premise
  that "events are stored generically." True for event *names*, but funnel conversion needs
  per-visitor **ordered** event sequences, which exist only in raw WAE — and WAE **cannot** self-join
  or window across events, plus the daily-`vid` boundary. Funnels realistically need a **new
  sessionization primitive** (a per-visitor DO or a D1 sessions table) → its own ADR and ~2–3 wk. If
  the PM wants funnels early, the *enabling* work (sessionization) is the real line item.

- **The cheap wins are UI-only.** Custom-events view, UTM/campaigns, device/browser/OS, and a live
  top-pages panel are each **S** because ingestion + rollup + query helpers are already built and
  tested with zero UI callers. If the roadmap wants "more reporting depth" fast, these are near-free.

---

## 5. What should block or reorder roadmap thinking

1. **Gate Phase 2 before layering new rollup-dependent features.** New reporting views read
   `rollup_daily`; they're safe. But anything that *writes* a new dimension or changes flush
   semantics should land **after** the Phase-2 cutover (flush target flips to `rollup_daily`, cron
   retired) to avoid building against the transitional shadow table. Phase 2 is committed-pending the
   parity re-gate; don't stack schema-writing features on top of Phase 1.

2. **Any "unique visitors over N days" or session/funnel/bounce promise hits a privacy wall.**
   Surface §0.5 before these are scoped. They are not quick — they need either a sessionization ADR
   (new store) or a deliberate loosening of the cookieless model (ADR-0002 revisit). Don't let them
   be sized as UI work.

3. **Auto-tracked script events multiply the dominant cost line.** Outbound/scroll/vitals tracking
   is cheap in bytes but each is another beacon → ~3.25 more DO writes. At self-host scale it's fine;
   flag it so "track everything" defaults don't quietly 2–3× the DO bill (§3.3). Consider making
   them opt-in and/or sampling them.

4. **Fix the `build-schema` "only 0001" bug before the next migration.** Cheap now, a cold-account
   deploy failure later (D6). Not roadmap-blocking, but a prerequisite for any feature that adds a
   table.

5. **The missing settings/admin UI is a shared dependency.** Multi-site UX, goals, public-share UX,
   and deploy polish all need the same forms-with-auth scaffolding that doesn't exist yet. Building
   it once (M) unlocks several features; sequencing them without it means repeated one-off UI.

---

## 6. Confidence & risk flags

- **HIGH:** MVP-complete + green (ran the suite); script byte headroom; query-layer-ahead-of-UI
  (grep-verified dead helpers); no-cross-day-uniques and no-sessionization walls (read from code +
  ADR-0002 design intent).
- **MEDIUM:** the ~$15/mo DO cost (the 2.25× `seen` factor is inferred; ADR-0010 itself says capture
  real `meta.rows_written` on the parity run); the funnels L-estimate (depends on the chosen
  sessionization design).
- **Watch / beta:** R2 archival path (Pipelines + R2 SQL still beta, single-source pricing — research
  §1 ⚠️); WAE billing switch-on (model holds, $-story shifts when Cloudflare enables it); Workers
  per-request rate not re-fetched today.

---

## 7. Verification log (live Cloudflare docs, fetched 2026-07-03)

- **DO pricing** (developers.cloudflare.com/durable-objects/platform/pricing/): Free — rows written
  **100k/day**, rows read 5M/day, storage 5 GB, requests 100k/day, duration 13k GB-s/day. Paid — rows
  written **50M/mo + $1.00/M**, rows read 25B/mo + $0.001/M, storage 5 GB-mo + $0.20/GB-mo, requests
  1M/mo + $0.15/M, duration 400k GB-s/mo + $12.50/M GB-s. **`put()` billed as rows written**;
  **`setAlarm()` = 1 row written**. SQLite storage billing **active since Jan 2026**.
- **WAE pricing** (developers.cloudflare.com/analytics/analytics-engine/pricing/): Free 100k dp/day +
  10k queries/day; Paid 10M dp/mo + $0.25/M, 1M queries/mo + $1.00/M. **"Currently, you will not be
  billed for your use of Workers Analytics Engine."**
- **WAE limits** (developers.cloudflare.com/analytics/analytics-engine/limits/): retention **3
  months**; 250 dp/invocation; 20 blobs / 20 doubles / 1 index; **16 KB blobs per data point**;
  index ≤ 96 bytes.
- **Prior-spec figures reused (not re-fetched today):** Workers ~$0.30/M requests; Queues 3 ops/msg;
  WAE ~100 dp/s/index sampling onset (order-of-magnitude). Re-verify before relying on exact
  per-million.

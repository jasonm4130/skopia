# Stratus — Technical Spec (MVP architecture)

- **Date:** 2026-06-21
- **Author:** `cloudflare-tech-lead` agent
- **Status:** Draft for human approval (pairs with the PM product spec of the same date)
- **Evidence base:** `docs/research/2026-06-21-cloudflare-architecture.md` (backbone HIGH;
  ingestion/query/cost MEDIUM). Load-bearing limits re-verified against live Cloudflare docs
  on 2026-06-21 — see **§9 Verification log**. ⚠️ flags from the research are honored; weak or
  corrected figures are not asserted as fact.
- **Scopes to:** the MVP defined in the product spec §4. Decisions are recorded as ADRs
  `0001`–`0006` in `docs/decisions/`; this spec is the connective tissue between them.

---

## 0. Design stance (the one-paragraph version)

Stratus is **five Cloudflare primitives wired by two Workers and one Cron**. The collector
Worker writes raw events directly to **Workers Analytics Engine (WAE)** and bumps a per-site
**Durable Object** for the live count. A **Cron Worker** rolls WAE up into exact daily/period
aggregates in **D1**, and the dashboard Worker serves SSR pages reading **D1 + KV cache**,
falling back to the **WAE SQL API** only for ad-hoc / today's-partial windows. **No Queues, no
R2, no Pipelines in the default path** — they are opt-in for archival/no-JS later. This is the
fewest primitives that meet the spec, and it keeps the self-host default on the **$0 free tier
or the $5/mo Workers Paid base**.

---

## 1. Component diagram

```
                              BROWSER (visitor)
  ┌──────────────────────────────────────────────────────────────────────┐
  │  stratus.js  (<2 KB gz)                                                │
  │   • pageview on load + history.pushState/replaceState + popstate (SPA) │
  │   • track(name, props)  custom events                                  │
  │   • collects: referrer, pathname, title, screen.width, UTM from URL    │
  │   • transport: fetch(collectorURL,{method:'POST',keepalive:true})      │
  │                fired on visibilitychange==='hidden' (+pagehide fallbk) │
  └───────────────────────────────┬──────────────────────────────────────┘
                                   │  POST /e   (one beacon per event)
                                   ▼
  EDGE ─────────────────────── COLLECTOR WORKER (collect.<domain>) ───────────────
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 1. CORS preflight + per-site origin allowlist                          │
  │ 2. validate payload (size cap, known site_id, event shape)            │
  │ 3. heuristic bot drop (UA blocklist, datacenter ASN via cf.asn/asOrg, │
  │    cf.verifiedBot where present, missing-header heuristics)            │
  │ 4. enrich from request.cf (country, colo, asn, httpProtocol, …) — 0 B │
  │    on client; UA-parse → device class / browser / OS                  │
  │ 5. identity: HMAC-SHA256(dailySalt ‖ ip ‖ ua ‖ site_id) → 16-hex vid  │
  │    (raw IP NEVER persisted; salt rotated daily in KV at UTC midnight) │
  │ 6. env.WAE.writeDataPoint({...})        ← raw event (synchronous)      │
  │ 7. ctx.waitUntil( SITE_DO.fetch('/hit', {vid}) )  ← live count, async │
  │ 8. respond 204 (beacon does not block on step 7)                      │
  └───────┬──────────────────────────────────────┬───────────────────────┘
          │ writeDataPoint                        │ /hit  (waitUntil)
          ▼                                       ▼
  ┌────────────────────┐                  ┌──────────────────────┐
  │ Workers Analytics  │                  │ Durable Object       │
  │ Engine  (WAE)      │                  │ SiteLive (1 per site)│
  │ raw events, 90-day │                  │ • WebSocket hib. API │
  │ hard retention     │                  │ • visitors last 5min │
  └─────────┬──────────┘                  │ • getWebSockets()=N  │
            │ WAE SQL (read)              └──────────┬───────────┘
            ▼                                        │ ws live count
  ┌────────────────────┐   write rollups   ┌─────────┴───────────┐
  │ CRON WORKER        │ ────────────────▶ │ D1 (SQLite)         │
  │ every 1–5 min:     │                   │ • sites, settings   │
  │  query WAE → agg   │   read rollups    │ • users / auth      │
  │  + count() check   │ ◀──────────────── │ • daily rollups     │
  └────────────────────┘                   │ • event/goal defs   │
            │ exact aggregates             └─────────┬───────────┘
            ▼ also warms                              │ SQL read
  ┌────────────────────┐                              ▼
  │ KV (dash cache)    │ ◀───────────── DASHBOARD WORKER (app.<domain>) ──────────
  │ rendered/JSON      │ ─────────────▶ │ • SSR (Hono + server-rendered HTML)    │
  │ resp, 60–120 s TTL │   read         │ • owner view  (auth: signed cookie)    │
  └────────────────────┘                │ • /public/<token> read-only per-site   │
                                        │ • /live WS proxy → SiteLive DO         │
                                        │ • ad-hoc/today → WAE SQL (debounced)   │
                                        └────────────────────────────────────────┘
   opt-in (NOT MVP): WAE/collector → Queues → R2 (Iceberg) for >90-day archival;
                     no-JS mode = collector reads request headers, no client script.
```

---

## 2. Collection layer (client script + transport)

**Budget: < 2 KB gzipped (CI-enforced; regressions are bugs — CLAUDE.md).** The byte budget is
defended by pushing *all* enrichment server-side. The script does the minimum:

| Client collects | Why client-side |
|---|---|
| `location.pathname` + search (for UTM) | only the browser knows the route |
| `document.referrer` | not reliably available server-side |
| `document.title` | page identity for "top pages" |
| `screen.width` (bucketed) | viewport class (mobile/tablet/desktop hint) |
| custom event `name` + small `props` | the `track()` API |

Everything else (country, ASN, device/browser/OS from UA, TLS/protocol) is derived **server-side
from `request.cf` and the `User-Agent` header — zero client bytes.**

**Transport:** `fetch(url, { method: 'POST', keepalive: true, body })`. `keepalive` gives the
same page-lifecycle decoupling as `sendBeacon` but one code path for pageviews + events + future
goals, and can read a response (used to receive the `site_id`-scoped config if needed). Fire on
`document.visibilitychange === 'hidden'`, with `pagehide` as fallback. **Not** `unload`/
`beforeunload` (unreliable on mobile Safari). [Research §2; MDN; Clicky 2025-10]

**SPA route changes:** monkey-patch `history.pushState`/`replaceState` (neither emits an event)
and listen to `popstate`; emit a pageview on each transition, debounced one frame.

**Custom events:** global `stratus('event', name, props)` (or `window.stratus.track`). A custom
event is *a pageview with a `name` and optional `props`* — same beacon, same schema (§4). This is
the deliberate "generic event from day one" design the PM's MVP custom-events inclusion depends
on, and it is what makes **funnels a fast-follow with no schema rework** (funnels are sequences
of already-stored named events).

**Extensibility hooks (built in MVP, not exposed):** the beacon body is a flat JSON object with a
`t` (type) field; outbound-link, file-download, scroll-depth, and Web-Vitals (all fast-follow)
are new `t` values that ride the same transport and schema with no collector change.

---

## 3. Ingestion layer (collector Worker)

A single Worker on a route like `collect.<deploy-domain>` (or the user's own domain). See
**ADR-0002** for the full decision. Pipeline per request:

1. **CORS:** answer `OPTIONS` preflight (`Access-Control-Allow-Methods: POST, OPTIONS`,
   `Max-Age: 86400`). Validate `Origin` against the **per-site allowlist** stored in D1/KV (not
   `*`) to stop cross-site beacon abuse. ⚠️ allowlisting is our hardening choice, not from the
   CF CORS example.
2. **Validate:** payload size cap (e.g. ≤ 2 KB), `site_id` exists, event shape, drop malformed.
3. **Heuristic bot drop** (free-tier only — **no** Enterprise Bot Management dependency, per the
   spec's "not the moat"): UA blocklist (GPTBot/CCBot/AhrefsBot/etc.), datacenter-ASN /
   `cf.asOrganization` heuristics, `cf.verifiedBot` where Super Bot Fight Mode surfaces it, and
   missing-header heuristics. Documented "put Stratus behind Cloudflare WAF" recipe covers the
   rest. ⚠️ granular `cf.botManagement.score` is Enterprise-only — **not used**.
4. **Enrich** from `request.cf`: `country`, `colo`, `asn`, `asOrganization`, `httpProtocol`,
   `isEUCountry`. Parse `User-Agent` → device class / browser / OS (small server-side table).
5. **Cookieless identity:** `vid = HMAC-SHA256(dailySalt ‖ clientIP ‖ UA ‖ site_id)` truncated to
   16 hex chars. **Raw IP is never written anywhere.** The daily salt lives in KV, rotated at UTC
   midnight by the Cron Worker; yesterday's salt is deleted, making cross-day correlation
   impossible. This yields **daily uniques without a cookie** (a returning visitor across a UTC
   boundary counts new — the accepted privacy/accuracy trade, documented honestly). See ADR-0002.
6. **Write to WAE** synchronously via `env.WAE.writeDataPoint(...)` (§4 schema). One data point
   per event. This is well inside the 250-dp/invocation limit (we write 1).
7. **Bump live count** via `ctx.waitUntil(env.SITE_LIVE.get(idFromName(site_id)).fetch('/hit'))`
   — async, does not block the beacon response.
8. **Respond `204`.**

**Queues are OUT of the default path** (ADR-0002 / PM Q4). At self-host volumes the direct
WAE write is simpler and free; Queues' 3-operations-per-message billing makes them the dominant
variable cost at scale for no reliability benefit here (WAE writes are already fire-and-forget at
the edge). Queues become opt-in only for the archival/no-JS fan-out later.

---

## 4. Storage layer — the backbone split (ADR-0001)

Five primitives, each doing exactly one job:

| Primitive | Role | Why it and not another |
|---|---|---|
| **WAE** | raw event ingest + ad-hoc query | purpose-built high-cardinality time-series, cheap writes, no per-dimension cost, SQL read. D1 cannot take raw ingest (single-threaded). |
| **D1** | site/user/config metadata + **exact rollups** + goal defs | relational, rich SQL, cheap reads; written by Cron not by the hot path. |
| **Durable Object** | per-site **live visitor** count + coordination | the only primitive with strongly-consistent per-key in-memory state + WebSockets. |
| **KV** | cached dashboard responses + **daily salt** | global <10 ms reads; salt needs a tiny rotating store. (Cache API is ruled out — per-PoP and disabled behind Access; ADR-0003.) |
| **R2 / Pipelines** | **NOT in MVP** — opt-in cold archival beyond 90 days | only needed if a user wants >3-month retention (ADR-0003 / PM Q2). |

### 4.1 WAE data-point schema (per event)

One `writeDataPoint` per event. **Index = `site_id`** (spreads sampling across sites; never a
per-visitor UUID, which the docs warn aggregates slowly). Limits honored: ≤ 20 blobs, ≤ 20
doubles, 1 index, ≤ 16 KB blobs, ≤ 96-byte index (all live-verified 2026-06-21, §9).

```
indexes: [ site_id ]                         // 1 index, ≤96 B — the partition key

blobs (strings, ≤16 KB total):
  blob1  = vid              // 16-hex cookieless daily visitor hash
  blob2  = pathname         // normalized page path  (top pages)
  blob3  = referrer_host    // parsed referrer hostname (sources)
  blob4  = utm_source       // sources / campaigns
  blob5  = utm_medium
  blob6  = utm_campaign
  blob7  = country          // request.cf.country  (geo)
  blob8  = device_class     // mobile|tablet|desktop  (from UA)
  blob9  = browser          // from UA
  blob10 = os               // from UA
  blob11 = event_name       // '' for pageview, name for custom event/goal
  blob12 = entry_path       // for future funnels/landing (cheap to store now)
  blob13 = props_json       // small JSON for custom-event props (capped)
  // blob14..20 reserved (Web Vitals, outbound link target, etc. — fast-follow)

doubles (numbers):
  double1 = 1               // event count (so SUM(_sample_interval*double1)=events)
  double2 = is_pageview     // 1 for pageview, 0 for custom event
  double3 = screen_width    // viewport bucket input
  // double4..20 reserved (CWV values, scroll %, revenue — later)
```

**Sampling correction is mandatory in every read** (WAE adaptive-samples at high volume):
`COUNT(*)` → `SUM(_sample_interval)`; weighted sums → `SUM(_sample_interval * x)`; uniques use
`SUM(_sample_interval)` over a `GROUP BY vid` subquery (no `COUNT(DISTINCT)` semantics survive
sampling cleanly — see §5.2). Validate accuracy with a raw `count()` check, not `_sample_interval`
alone (per CF's own warning). [Research §1 ⚠️; live-verified SQL functions §9]

### 4.2 D1 schema (sketch)

```sql
-- metadata (hot path never writes here)
sites      (id PK, name, domain, origin_allowlist, public_token, created_at)
users      (id PK, email, pw_hash, role, created_at)        -- single-owner: 1 row MVP
goals      (id PK, site_id FK, name, match_type, match_value)

-- rollups, written by the Cron Worker (exact at self-host volumes — §5.1)
rollup_daily (site_id, day, dimension, dim_value,           -- long/EAV-style
              pageviews, visitors, PRIMARY KEY(site_id,day,dimension,dim_value))
-- dimension ∈ {total, page, referrer, utm_source, country, device, browser, os, event}
```

D1 limits respected: ≤ 10 GB/db, ≤ 100 KB/statement, ≤ 1,000 queries/invocation, 30 s/query.
At self-host scale the rollup table is tiny (dimensions × values × days × sites). Writes are
idempotent upserts (so the non-retrying D1 write path is safe to re-run). [D1 limits — research §1]

---

## 5. Query & rollup layer (ADR-0003)

### 5.1 Rollup strategy (the snappy-dashboard engine)

A **Cron Worker** (Cron Trigger, can run every minute; we use **every 5 min** for finished days
and **every 1 min** for the current day's partial bucket) queries WAE with sampling-correct SQL,
`GROUP BY` each dimension, and **upserts exact aggregates into D1 `rollup_daily`**. The dashboard
reads D1, never WAE, for any finalized window. This gives:

- **Exact numbers at the volumes our personas run.** Below WAE's sampling onset (~order-of-
  magnitude 100 dp/s **per index**, workload-qualified ⚠️), WAE returns 100% of rows, so the
  rollup is exact, full stop. P1/P2/P3 (a few hundred → ~1M views/mo ≈ ≤ ~0.4 events/s avg) sit
  far below that — **honesty costs them nothing.**
- **A cheap validation check (answers PM Q1).** Each Cron pass also runs `SELECT count() ...`
  (raw, uncorrected row count) alongside the corrected aggregate. If `count()` for a (site, day)
  is at the full-resolution ceiling for the window, the data was unsampled → store
  `sampled=false`. If it's below, sampling kicked in → store `sampled=true` on that rollup row.
  The dashboard then shows the **"~ estimated" badge only on sampled rows** (PM's preferred
  option (b)). The check is one extra cheap aggregate per Cron pass — **not** per dashboard load
  — so it is effectively free.

### 5.2 Read paths

| Dashboard query | Source | Latency |
|---|---|---|
| Any finalized day / multi-day range, all dimensions | **D1 rollups** (often via **KV** cache) | <10 ms (KV) / <100 ms (D1) |
| **Today (partial, live-ish)** time-series + top-lists | **WAE SQL**, debounced 300–500 ms, sampling-corrected | ~0.5–2 s cold |
| **Live visitor count** | **DO** WebSocket (`getWebSockets().length`) | real-time push |
| Custom ad-hoc (date-picker on raw, rare) | **WAE SQL**, debounced | ~0.5–2 s |

WAE SQL constraints honored: **no `JOIN`, no `UNION`** (verified — these remain unsupported on
*WAE*; the JOIN/UNION support in CF docs is **R2 SQL**, a different engine — do not conflate, §9).
Subqueries and CTE-free aggregates are fine; we use per-dimension `GROUP BY` queries, not joins.
Mitigate the undocumented SQL-API rate limit (HTTP 429) with the 300–500 ms debounce and by
serving everything possible from D1/KV.

### 5.3 Caching

**KV, not the Cache API.** The Cache API is per-PoP *and* is disabled for Workers fronted by
Cloudflare Access — and even though we choose self-rolled auth (ADR-0005), KV is the right call
anyway: globally replicated, sub-10 ms, and it doubles as the daily-salt store. Dashboard JSON/
HTML responses are cached in KV with a 60–120 s TTL, invalidated implicitly by TTL (the Cron
refreshes D1 faster than the TTL, so staleness is bounded to one Cron interval + TTL).

---

## 6. Real-time layer (ADR-0004)

**One Durable Object class, `SiteLive`, one instance per site** (`idFromName(site_id)`):

- On each beacon, the collector calls `SITE_LIVE.fetch('/hit', {vid, path})` via `waitUntil`.
- The DO keeps an in-memory map `vid → lastSeen`, evicts entries older than **5 minutes**, and
  treats `size` as the live-visitor count.
- The dashboard opens a **WebSocket** to the DO (`/live` proxied through the dashboard Worker);
  the DO pushes the current count + top active pages on change. **`getWebSockets().length`** is
  the dashboard-viewer count; the visitor count is the `vid` map size.
- **WebSocket Hibernation API** (`ctx.acceptWebSocket` / `webSocketMessage` / `getWebSockets`)
  so the DO sleeps between messages → minimal duration billing. The
  `web_socket_auto_reply_to_close` flag is default on compat dates ≥ `2026-04-07` (live-verified,
  §9) — we set our compat date past that, so we don't hand-handle close frames.
- Eviction is driven by a **DO Alarm** (e.g. every 30 s) so counts decay even with no new hits.

This is deliberately small: no persistence needed (live state is ephemeral; the historical record
is WAE+D1), so the DO uses in-memory state only — **no SQLite storage cost** in the live path.
**Effort verdict: this fits inside ~1.5 weeks (see §8) → real-time STAYS in MVP.**

---

## 7. Dashboard & deploy

### 7.1 Dashboard hosting + framework (ADR-0005)

**A single Worker (SSR + API + static assets) using Hono.** Rationale:
- CF now directs full-stack investment to **Workers over Pages** (Pages stays supported, gets no
  new feature work ⚠️ — "deprecated" overstates it). One Worker = one deploy target = simplest
  one-click story and fewest bindings.
- **Hono** (tiny, Workers-native, JSX/SSR, great routing) keeps the dashboard server-rendered and
  light. Charts via a small client lib loaded only on the dashboard (not the tracked sites — it
  never touches the 2 KB budget). SvelteKit/Remix are viable but heavier for a read-mostly
  dashboard; Hono is the simplicity-first pick.
- **Public/shareable dashboards** = the same SSR views gated by a per-site `public_token` route
  (`/public/<token>`), read-only, no auth. Cheap because the read path is already per-site.

### 7.2 Auth (ADR-0005, answers PM Q5)

**Self-rolled signed-cookie session, not Cloudflare Access.** The product's headline UX metric is
**TTFD < 10 min** and the promise is **one-click deploy**. Cloudflare Access cannot be provisioned
by the Deploy-to-Cloudflare button — it requires a manual Zero-Trust org + policy setup, a
detour that directly threatens both goals (and the free-seat allowance for Zero Trust could not be
re-confirmed from a tier-1 source today, §9 ⚠️ — another reason not to hard-depend on it). The
self-rolled path:
- First-run: owner sets a password (prompted via `.dev.vars`/setup, or a first-load setup screen);
  stored as a salted hash (`PBKDF2`/`scrypt` via Web Crypto) in D1.
- Login issues an **HMAC-signed, HttpOnly, Secure, SameSite=Lax cookie** (Web Crypto
  `HMAC-SHA256` over `userId|expiry`), ~30-day sliding expiry.
- It is a small, auditable amount of code (login handler + cookie verify middleware). We own it,
  but it is **fully one-click-deployable** with zero manual setup → protects TTFD.
- The deploy README documents the "wrap it in Cloudflare Access instead" recipe for users who
  *want* Zero Trust / SSO — opt-in, not default.

### 7.3 Deploy (ADR-0006)

- **"Deploy to Cloudflare" button** clones the repo, provisions bindings from `wrangler.jsonc`,
  and wires Workers Builds CI/CD. It auto-provisions **KV, D1, R2, DO, Queues** (auto-provisioning
  GA'd; KV/R2/D1 confirmed Oct 2025 changelog, §9).
- **WAE datasets need no pre-provisioning** — declaring `analytics_engine_datasets` with a binding
  name creates the dataset on first write (two-source confirmed, HIGH).
- **Secrets** (the HMAC salt for identity, the auth cookie secret) are generated on first run or
  prompted via `.dev.vars.example` — the README documents generating them.
- **Manual steps (documented, minimal):** (1) the first-run owner password; (2) optional
  custom-domain routing for the collector/dashboard; (3) *nothing* for auth (self-rolled).
  Choosing self-rolled auth removes the one genuinely painful manual step (an Access policy),
  which is the whole point of ADR-0005.

---

## 8. Effort estimates

Person-weeks for one experienced Workers dev. Confidence: H/M/L. ⚠️E marks the items the PM
flagged as ranking-sensitive.

| # | Item | Effort | Confidence | Notes |
|---|---|---|---|---|
| 5 | <2 KB script (fetch+keepalive, SPA, visibilitychange, custom events) | **S — 1 wk** | H | byte budget is the constraint, not logic |
| — | Collector Worker (CORS, validate, enrich, identity, bot drop, WAE write) | **M — 1.5 wk** | H | identity HMAC + UA parse are the work |
| 4 | Cookieless daily-salt identity | (in collector) | H | salt rotation = a Cron line |
| 1 | Pageviews / uniques / top pages (WAE schema + rollup + view) | **M — 1.5 wk** | H | establishes the rollup pattern |
| 2 | Referrers/sources + UTM | **S — 0.5 wk** | H | more dimensions on same rollup |
| 6 | Device/browser/OS/geo | **S — 0.5 wk** | H | UA parse + cf.country |
| 7 | Time-series + date-range picker | **M — 1 wk** | H | range queries over rollups |
| 8 | Multi-site in one deploy | **M — 1.5 wk** | M | site CRUD, per-site index/token/allowlist |
| 9 | Custom events / goals | **M — 1 wk** | M | schema is generic from day 1 → mostly UI |
| **10** | **Real-time live view (DO + WS hibernation)** ⚠️E | **M — 1.5 wk** | **M** | **< 2 wk → STAYS in MVP** (see verdict) |
| 11 | Single-owner auth (signed cookie) | **S — 1 wk** | H | self-rolled; no Access setup |
| 12 | Public/shareable dashboards | **S — 0.5 wk** | H | token-gated reuse of read views |
| 3 | One-click deploy + auto bindings + README | **M — 1 wk** | M | mostly config + docs + test the flow |
| — | Dashboard shell (Hono SSR, charts, layout, date picker glue) | **L — 2 wk** | M | the polish the thesis sells |
| — | Sampling-honesty badge + count() validation | **S — 0.5 wk** | H | one Cron aggregate + a UI badge |
| — | **MVP total (with parallelism)** | **~9–11 wk** | M | one dev; less with two |
| **Fast-follow items (PM ranking-sensitive):** | | | | |
| 14 | **Funnels** ⚠️E | **M — 2 wk** | M | **cheaper than PM's E≈3** — events already stored; funnel = ordered `event_name` sequence query + builder UI. No pipeline rework. |
| 15 | **Server-side / no-JS mode** ⚠️E | **M — 2 wk** | M | collector reads request headers directly; ergonomics (proxy/route injection) is the cost, not the data path |
| — | Real-time (already costed above) | 1.5 wk | M | — |
| 21 | **R2 archival beyond 90 days** ⚠️E | **L — 3 wk** | L | Pipelines→R2 Iceberg→R2 SQL; beta surfaces, caching layer required; matches PM's E≈3 |

**Real-time verdict (PM Q3, the explicit ask):** real-time is **~1.5 weeks, under the 2-week
bar → it stays in MVP.** It is the *smallest* of the ⚠️E items because it needs no persistence
and the Hibernation API is well-trodden. The risk is integration polish (WS reconnect, count
decay), not core feasibility.

---

## 9. Cost & scale model

Assumes 1 request per event, the **direct-WAE-write path (no Queues)**, and the self-host
single-owner case. Prices live-verified 2026-06-21 (§ verification log).

| Volume | Where it lands | Est. monthly cost |
|---|---|---|
| **1M events/mo** (~33k/day) | **Workers Free** — 100k/day WAE writes + 100k/day Workers both cover it; D1/DO/KV within free | **$0** |
| **10M events/mo** (~333k/day) | **Workers Paid $5 base** — WAE 10M and Workers 10M both *exactly* included; D1 rollup writes & DO well within free allowances | **~$5** (Queues would add ~$11.60 → **skip them**) |
| **100M events/mo** (~38 ev/s avg) | WAE 90M overage ×$0.25 = $22.50; Workers 90M ×$0.30 = $27.00; DO live-count ~$0.60 | **~$50–60** |

**Which limit bites first:** **WAE adaptive sampling (accuracy), not cost.** Cost scales smoothly;
accuracy is the soft wall. At ~38 ev/s (100M/mo) sampling stays minimal **only if the index
(`site_id`) is spread across many sites**; a single very-hot site approaching ~100 dp/s on its own
index is where the "~ estimated" badge starts appearing (⚠️ threshold is order-of-magnitude). The
honesty mechanism (§5.1) is precisely the mitigation: we never lie, we badge.

**Free + $5 tier fit (answers the cost question):** **yes.** Effectively all P1/P2/P3 self-hosters
(hundreds → ~1M views/mo) run **$0 on free**. The mid-traffic ~10M/mo case is the **$5 Workers
Paid base with no meaningful overage**. Only the 100M/mo minority pays ~$50–60 — still no DB
server, no egress cost. The free tier's binding constraint is the **100k WAE writes/day** ceiling
(≈ 3M events/mo) — the first thing a growing free-tier user hits, and the natural nudge to the $5
plan.

### 9.1 Provisional `wrangler.jsonc` binding plan

> Specification only — **do not deploy.** Compat date set past `2026-04-07` for the
> WebSocket-auto-close default. Single Worker hosts dashboard+API; the collector is a second
> Worker (or a route) sharing the same bindings.

```jsonc
{
  "name": "stratus",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-18",
  "compatibility_flags": ["nodejs_compat"],

  "observability": { "enabled": true },

  // Raw event ingest — created on first write, no pre-provisioning needed.
  "analytics_engine_datasets": [
    { "binding": "WAE", "dataset": "stratus_events" }
  ],

  // Metadata + exact rollups (auto-provisioned by deploy button).
  "d1_databases": [
    { "binding": "DB", "database_name": "stratus", "database_id": "<auto>" }
  ],

  // Dashboard cache + rotating daily salt (auto-provisioned).
  "kv_namespaces": [
    { "binding": "CACHE", "id": "<auto>" },
    { "binding": "SALT",  "id": "<auto>" }
  ],

  // Per-site live visitor counts.
  "durable_objects": {
    "bindings": [{ "name": "SITE_LIVE", "class_name": "SiteLive" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": [] , "new_classes": ["SiteLive"] }
  ],

  // Cron: rollups every 5 min (finished days) — current-day refresh handled by a
  // shorter-interval trigger or the live DO; salt rotation runs in the daily pass.
  "triggers": { "crons": ["*/5 * * * *"] },

  // Secrets (NOT committed) — set on first run / via deploy prompts:
  //   IDENTITY_HMAC_SECRET   (cookieless visitor hash)
  //   AUTH_COOKIE_SECRET     (signed-session cookie)
  "vars": { "RETENTION_DAYS": "90" }

  // OPT-IN, NOT MVP (documented, commented out in the shipped file):
  // "queues": { "producers": [{ "binding": "ARCHIVE_Q", "queue": "stratus-archive" }] },
  // "r2_buckets": [{ "binding": "ARCHIVE", "bucket_name": "stratus-archive" }]
}
```

---

## 10. How MVP extends to fast-follow without rework

| Fast-follow | Why MVP already supports it |
|---|---|
| **Funnels** | events are stored generically (`event_name` blob); a funnel is an ordered sequence query over existing rows + a builder UI. No ingestion/schema change. |
| **Server-side / no-JS mode** | the collector already enriches entirely from `request.cf` + headers; no-JS mode is the *same* collector invoked without the client script. New ingestion *entry*, same data path & schema. |
| **Outbound/file/scroll/Web-Vitals** | new `t` (type) values + reserved blob/double slots; same beacon, same WAE schema. |
| **R2 archival (>90 days)** | the opt-in Queue→R2 fan-out attaches to the existing collector write point; commented binding stubs are already in the wrangler plan. |
| **IP truncation / configurable retention** | identity already never stores raw IP; truncation + a `RETENTION_DAYS` var (present) are a settings-UI layer over existing behavior. |
| **Stats API / export** | the D1 rollups + WAE SQL are already the query layer; an API is a thin read endpoint over them. |

---

## 11. Q&A — PM's open technical questions

**Q1 — WAE sampling honesty: is a cheap validation check feasible? Does rollup-to-D1 give exact
numbers at our personas' volumes?**
Yes and yes. (a) The check is a single extra `count()` (raw, uncorrected) aggregate per Cron pass,
compared against the resolution ceiling — **per Cron, not per dashboard load**, so effectively
free. It sets a `sampled` flag per rollup row that drives a "~ estimated" badge **only where
sampling actually occurred** (the PM's preferred option (b)). (b) At P1/P2/P3 volumes (≤ ~1M
views/mo ≈ ≤ ~0.4 ev/s, far below the ~100 dp/s/index onset ⚠️), WAE returns 100% of rows → the
D1 rollups are **exact**. Honesty costs the common case nothing; only the heavy-traffic minority
ever sees a badge. We never present a sampled number as exact.

**Q2 — Is 90-day retention acceptable for MVP, and is cheap 13-month retention available without
R2?**
90 days is acceptable for MVP (it covers the "how's traffic this quarter" job). **There is no
cheap path to 13-month retention without R2.** Confirmed: WAE retention is a **hard 3-month
window on all plans** (live-verified, §9) — not a cost ceiling you can raise, an architectural
deletion. The only extension path is exporting events to **R2 (via Pipelines, Iceberg/Parquet,
queried by R2 SQL)** — item #21, **L/3 wk, beta surfaces, needs a caching layer**. So: ship MVP at
90 days, document honestly; **keep R2 archival as opt-in Later**, exactly as the PM positioned it.
(Note for P2/CNIL: 13-month + IP-truncation matters for CNIL Sheet 16 — but that's a compliance
*opt-in* config, and it lands with the R2 archival work, not MVP.)

**Q3 — Effort confirmation on the ⚠️E items.**
Real-time **1.5 wk → stays in MVP** (verdict above). Funnels **2 wk, M confidence — cheaper than
the PM's E≈3**, because the generic event pipeline is in MVP; they could pull into an early v1.0.x.
Server-side/no-JS **~2 wk** (ergonomics, not data path). R2 archival **~3 wk, L confidence**
(beta surfaces) — matches the PM's E≈3, stays Later.

**Q4 — Queues in or out of the default path?**
**Out.** The collector writes directly to WAE (fire-and-forget at the edge). Queues add 3
billing operations per message and become the dominant variable cost at volume for **no
reliability gain** in this design — there's no downstream system that needs buffering/back-
pressure in MVP. They become opt-in only for the archival/no-JS fan-out. This keeps the free
tier covering more and the $5 tier clean.

**Q5 — Auth: Access vs self-rolled — pick + rationale.**
**Self-rolled signed-cookie session.** The deciding requirement is **TTFD < 10 min + one-click
deploy**. Cloudflare Access cannot be provisioned by the Deploy button (needs a manual Zero-Trust
org/policy setup) — a detour that breaks the headline UX promise, and whose free-seat allowance I
could not re-confirm from a tier-1 source today (§9 ⚠️). Self-rolled auth is a small auditable
amount of code, fully one-click-deployable, and we document the "wrap in Access" recipe for users
who *want* SSO/Zero-Trust as an opt-in. Security is owned but bounded (one login handler + one
verify middleware over Web Crypto HMAC).

---

## 12. Technical risks & open human decisions

1. **WAE sampling at very high single-site traffic** — accuracy degrades before cost does. Mitigated
   by the honesty badge (§5.1), not eliminated. A single 100M/mo *one-site* deploy is the edge case
   to watch; multi-site spreads the index and stays accurate longer. ⚠️ onset threshold is
   order-of-magnitude.
2. **WAE billing not yet active** — pricing is published but "you will not be billed currently"
   (live-verified). Costs in §9 are the *priced* model; real billing starts when CF flips it on.
   Watch the changelog; the model holds, the $0/$5 story may shift slightly at switch-on.
3. **WAE SQL undocumented rate limit (429)** — mitigated by debounce + serving from D1/KV. If CF
   tightens it, lean harder on rollups.
4. **Cloudflare Access free-seat count unverified** — does not affect us (we chose self-rolled), but
   note it if the human prefers Access: re-verify seat allowance before recommending it.
5. **Pipelines/R2-SQL betas** (only matters when R2 archival ships) — beta limits + pricing partly
   single-source ⚠️; re-verify before building #21.
6. **Human decisions (not ours):** license (AGPL-3.0, PM-recommended), name ("Stratus" provisional —
   trademark check), and the wedge posture (thin-polished-core MVP vs funnels-in-MVP — this spec is
   scoped to the thin-core choice; pulling funnels in adds ~2 wk).

---

## Sources / verification

See the architecture research (`docs/research/2026-06-21-cloudflare-architecture.md`) for the full
cited evidence base. Load-bearing limits re-verified live on 2026-06-21:

- **WAE limits** (developers.cloudflare.com/analytics/analytics-engine/limits/): 250 dp/invocation,
  20 blobs, 20 doubles, 1 index, 16 KB blob total, 96-byte index, **3-month retention**. ✅ live
- **WAE pricing** (.../analytics-engine/pricing/): free 100k dp/day + 10k queries/day; paid 10M
  dp/mo (+$0.25/M) + 1M queries/mo (+$1.00/M); **"you will not be billed currently."** ✅ live
- **WAE SQL** (changelogs 2025-09-26, 2025-11-12): added `argMin/argMax` etc.; **JOIN/UNION remain
  unsupported on WAE** (the JOIN/UNION/CTE support in CF docs is **R2 SQL**, a separate engine —
  not conflated). ✅ live
- **DO Hibernation** (durable-objects/best-practices/rules-of-durable-objects/):
  `acceptWebSocket`/`getWebSockets`; `web_socket_auto_reply_to_close` **default on compat ≥
  2026-04-07**. ✅ live (resolves the research's muddled compat note)
- **Wrangler auto-provisioning** (changelog 2025-10-24): KV/R2/D1 auto-provisioned on deploy. ✅ live
- **Cloudflare Access free-seat count:** ⚠️ could not re-confirm from a tier-1 source on 2026-06-21
  — flagged, and not depended upon (self-rolled auth chosen).

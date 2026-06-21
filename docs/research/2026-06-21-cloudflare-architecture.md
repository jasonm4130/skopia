# Research — Cloudflare-native analytics architecture

- **Date:** 2026-06-21
- **Method:** Deep-dive fan-out (4 angles, 2 waves, Sonnet workers, blind tier-1 citation
  verification). Run ID `wf_57f02850-6e7`.
- **Reliability:** `backbone` **high** · `ingestion` **medium** · `query` **medium** ·
  `cost-deploy` **medium**. Specific caveats flagged inline as ⚠️.
- **Audience:** the `cloudflare-tech-lead` agent. This is the cited evidence base for the
  technical spec + ADRs. All limits/pricing are current as of the cited doc dates (mostly
  2026-04-23). **Re-verify any load-bearing limit against live docs before building.**

---

## TL;DR architecture

```
 Browser              Edge (Worker)                    Storage                 Read path
┌────────┐  beacon   ┌──────────────────┐  writeDataPoint ┌──────────────┐   ┌──────────────┐
│ <2 KB  │ ────────▶ │ collector Worker │ ──────────────▶ │ Analytics    │◀──│ Cron rollup  │
│ script │  sendBea- │ • validate/CORS  │                 │ Engine (WAE) │   │ Worker → D1  │
└────────┘  con/     │ • enrich req.cf  │                 │ events, 3 mo │   └──────┬───────┘
            fetch    │ • cookieless hash│                 └──────────────┘          │
                     │ • bot filter     │  metadata/rollups ┌──────────────┐        │ KV cache
                     │ • live count ──▶ │ ─────────────────▶│ D1 (SQLite)  │◀───────┘
                     └──────────────────┘    realtime ▼     └──────────────┘
                                          ┌──────────────┐  Dashboard Worker (SSR + API),
                                          │ Durable Obj  │  fronted by Cloudflare Access,
                                          │ live visitors│  reads KV/D1, WAE SQL for ad-hoc.
                                          └──────────────┘
              optional: WAE → R2 (+Pipelines) for >3-month archival.
```

**The data backbone (high confidence):** **Workers Analytics Engine** for raw event
ingestion, **D1** for site/config metadata + pre-aggregated rollups, **Durable Objects**
for real-time live-visitor counts, **KV** for cached dashboard responses, and **R2
(+Pipelines)** only if retention beyond WAE's hard 3-month window is required.

---

## 1. Data backbone (reliability: HIGH)

**Workers Analytics Engine (WAE) is the event-ingest backbone.** It is purpose-built for
high-cardinality time-series with cheap writes and a SQL read API.

- **Write shape:** up to **250 data points per Worker invocation**; **20 blobs + 20 doubles
  + 1 index** per `writeDataPoint`; **≤16 KB** total blob payload per data point (raised from
  5 KB in June 2025); index field **≤96 bytes**. [WAE limits]
- **Retention: 3 months, hard.** Data older than 3 months is deleted on all plans. This is an
  *architectural* constraint, not a cost ceiling — design rollups/archival around it. [WAE limits]
  ⚠️ The "R2+Pipelines export is *required*" framing is our inference; Cloudflare docs only
  point to contacting them about extended retention. R2+Pipelines is a valid pattern, not an
  official prescription.
- **Pricing:** Free = 100k data points written/day + 10k read queries/day. Paid = **10M data
  points/month included, then $0.25/M**; 1M read queries/month, then $1.00/M. **No surcharge
  for cardinality / extra dimensions.** Billing is published but **not yet actively charged**
  ("you will not be billed currently"). [WAE pricing]
- **Sampling (the big gotcha):** two-stage adaptive sampling. Write-time equitable sampling +
  read-time Adaptive Bit Rate (resolutions 100% / 10% / 1%). Queries **must** correct via
  `_sample_interval`: `COUNT(*)`→`SUM(_sample_interval)`, `SUM(x)`→`SUM(_sample_interval*x)`,
  `AVG(x)`→`SUM(_sample_interval*x)/SUM(_sample_interval)`; percentiles via
  `quantileExactWeighted(q)(column, _sample_interval)`. [WAE sampling, SQL API]
  ⚠️ The "~100 data points/second per index" onset threshold is **workload-qualified**
  ("CDN-like workloads" on the FAQ), not a universal guarantee — treat as order-of-magnitude.
  ⚠️ Docs also caution that `_sample_interval` alone "does not tell you whether results are
  accurate"; validate with row `count()` checks. Pick an index that matches query patterns
  (e.g. per-site) and **avoid unique-UUID indexes** (slow aggregation).

**D1 (SQLite) for metadata + rollups, not raw ingest.** Single-threaded; throughput is
inverse to query time (~1,000 writes/s at 1 ms, ~10/s at 100 ms) — **explicitly not for
high-write analytics ingestion.** Use it for site config, users, and Cron-written
aggregates. Limits: 10 GB/db, 100 KB/statement, 30 s/query, 1,000 queries/invocation, 100
bound params. Free = 5M reads/day + 100k writes/day + 5 GB. Paid = 25B reads/mo + 50M
writes/mo included, then $0.001/M read · $1.00/M write · $0.75/GB-mo. Read queries
auto-retry (≤2) since Sept 2025; writes do not — add idempotent retry. [D1 limits/pricing]

**Durable Objects for real-time + per-site coordination.** SQLite-backed DO: 10 GB/object,
~1,000 req/s soft, 30 s CPU (→5 min configurable), 2 MB row/BLOB. Paid: unlimited SQLite
storage, 500 classes. Pricing: 1M req/mo (+$0.15/M), 400k GB-s/mo (+$12.50/M GB-s); SQLite
storage billing started **Jan 7 2026** (same row rates as D1, $0.20/GB-mo). [DO limits/pricing]

**R2 for cold archival/export (optional).** $0.015/GB-mo, Class A $4.50/M, Class B $0.36/M,
**free egress**, 10 GB free tier. ⚠️ "free egress only via Workers/S3/custom-domain" is
narrower than the docs (egress is free generally). [R2 limits/pricing]

**Pipelines + R2 Data Catalog + R2 SQL** = Cloudflare's newer "Data Platform" for long-term
Iceberg/Parquet archival beyond WAE's 3 months. Pipelines (open beta): 5 MB/s per stream,
5 MB payload, 20 streams/pipelines per account. ⚠️ Pipelines *pricing* numbers ($0.03/GB
JSON, $0.06/GB Parquet, $0.04/GB SQL transform, 50 GB/mo included **on Paid only — Free is
1 GB**) are single-source/partly unverified — confirm before relying. R2 SQL is filter-only
today; aggregations/joins planned 2026. A real reference build (Icelight, Jan 2026) used
Worker→Pipelines→R2 Iceberg→R2 SQL/DuckDB and warns that path is **not** for high-traffic
external query endpoints without a caching layer.

---

## 2. Ingestion & collection (reliability: MEDIUM)

**Client script (<2 KB gzipped target).** Achievable by pushing all enrichment server-side.
Client does only: `document.referrer`, screen width, `pathname`, page title, and transport.
- **Transport:** `fetch(url, {keepalive:true})` is the modern default — same page-lifecycle
  decoupling as `sendBeacon` but can read a response (one code path for pageviews/events/
  goals). Clicky migrated sendBeacon→fetch+keepalive Oct 2025. Fire on `visibilitychange`
  (`visibilityState==='hidden'`), **not** `unload`/`beforeunload` (unreliable on mobile);
  `pagehide` fallback. [MDN, Clicky]
- **SPA tracking:** patch `history.pushState`/`replaceState` (no native event) + listen to
  `popstate`; emit a pageview on each.

**Collector Worker.**
- **CORS:** respond to `OPTIONS` preflight; `Allow-Methods: GET,HEAD,POST,OPTIONS`,
  `Max-Age: 86400`. ⚠️ Cloudflare's example uses `Allow-Origin: *`; validating against a
  per-site allowlist (to stop cross-site beacon abuse) is our recommendation, not from the docs.
- **Enrichment from `request.cf` (free, all plans, zero client bytes):** `country`, `colo`,
  `asn`, `asOrganization`, `tlsVersion`, `clientTcpRtt`, `clientQuicRtt`, `httpProtocol`,
  `isEUCountry`. [Workers Request docs]
- **Bot filtering:** `request.cf.botManagement` (score, verifiedBot, ja3/ja4, jsDetection…)
  requires **paid Bot Management** ⚠️ (don't rely on it for a free self-host). Free-tier
  filtering = User-Agent blocklists (GPTBot/CCBot/etc.), ASN/datacenter-IP blocking,
  `asOrganization` heuristics, payload-size caps. ⚠️ The "2,000 bot sessions/week blocked"
  anecdote is from an unreachable Reddit post — techniques sound, figure unverifiable.
- **Cookieless identity:** server-computed `HMAC-SHA256(daily-rotating-salt ‖ IP ‖ UA ‖
  site-id)`, store **only** the (often 64-bit-truncated) hash; raw IP never persisted. Daily
  salt (in KV, rotated at UTC midnight) makes cross-day correlation impossible → counts daily
  uniques without a cookie banner. Simpler variant: `sha256(IP+UA+SALT+YYYYMMDD)` first 12 hex.
- **Durable fan-out:** `ctx.waitUntil(env.QUEUE.send(event))` (or Pipelines) so the HTTP
  response isn't blocked. ⚠️ For the self-host single-owner case, writing **directly** to WAE
  from the collector (skipping Queues) is simpler and avoids Queue op costs — see cost model.

**Queues** (if used for buffering): 128 KB/msg, 5,000 msg/s/queue, 100/batch, 25 GB backlog,
14-day retention (24 h free). **3 operations per message** → at high volume this is the
costliest optional piece ($0.40/M ops after 1M/mo). [Queues limits/pricing]
**Pipelines HTTP endpoint host is `{stream-id}.ingest.cloudflare.com`** (the research draft's
`*.pipelines.cloudflare.com` was wrong) ⚠️; or Worker binding `env.STREAM.send(records[])`.

---

## 3. Query, rollup & dashboard (reliability: MEDIUM)

**WAE SQL API** — `POST .../accounts/<id>/analytics_engine/sql`, "Account Analytics Read"
bearer token. Supports `SELECT … WHERE/GROUP BY/HAVING/ORDER BY/LIMIT/FORMAT` and
**subqueries** (`FROM (subquery)`). **No `JOIN`, no `UNION`.** ⚠️ (The research draft wrongly
listed subqueries/CTEs as unsupported — only JOIN/UNION are confirmed unsupported.) Rich
aggregate set: `count/sum/avg/min/max`, `countIf/sumIf/avgIf`, `topK(N)`, `topKWeighted(N)`,
`argMax/argMin`, `quantileExactWeighted`. **Undocumented rate limit** → HTTP 429 code 10429
under rapid dashboard interaction; mitigate with ~300–500 ms debounce. [WAE SQL ref; GitHub issue ⚠️ third-party]

**Pre-aggregation is mandatory for a snappy dashboard.** Don't hit the WAE SQL API on every
page load (rate limits, latency, no JOIN). Pattern: a **Cron Trigger Worker** (down to every
minute) queries WAE and writes rollups to **D1** (rich SQL) and/or **KV** (sub-10 ms global
reads). ⚠️ This pattern is sound but was mis-cited to the Cron reference page (which doesn't
mention it) — it's an architecture choice, not a Cloudflare-documented recipe.
- **Caching:** use **KV** (globally replicated, 1–2 min consistency) for cached dashboard
  results — a 3rd-party report showed 87% fewer D1 reads + <100 ms vs 1–2 s cold queries
  ⚠️(single-source figures). **Do not** use the **Cache API**: it's per-PoP only **and is
  unavailable for Workers fronted by Cloudflare Access** (which our dashboard will use). [Cache API docs]

**Real-time live visitors:** a named **Durable Object** accumulating WebSocket connections;
`ctx.getWebSockets().length` = live count. Use the **WebSocket Hibernation API** to sleep
between messages and cut cost. ⚠️ (compat-date detail in the draft was slightly muddled —
verify hibernation enablement against current DO docs.)

**Dashboard hosting:** deploy as a **single Worker** (SSR + API + static assets) — Cloudflare
now directs full-stack investment to Workers over Pages ⚠️("deprecated" overstates it; Pages
stays supported but gets no new feature work). SvelteKit / Hono / Remix(React Router v7) /
Astro / Nuxt all GA on Workers. [Full-stack Workers blog]

**Auth (single-owner self-host):** **Cloudflare Access** is lowest-friction — wraps the Worker
with zero-trust policy, issues a `CF_Authorization` JWT cookie (HttpOnly, ~24 h default),
free tier. ⚠️ Email-OTP-without-IdP and seat/free-tier specifics weren't confirmed from the
cited page — verify. **Trade-off:** Access disables the Cache API (fine — we use KV).
Alternative: a hand-rolled signed-cookie session in the Worker (password → HMAC-SHA256 cookie
via Web Crypto) ⚠️(valid pattern, mis-cited in draft) — more code to audit.

---

## 4. Cost & scale model (reliability: MEDIUM — arithmetic verified, assumes 1 req/event)

| Volume | Where it lands | Est. monthly cost |
|--------|----------------|-------------------|
| **1M events/mo** | Fits **Workers Free** (3M/mo capacity at 100k/day for both Workers + WAE writes) | **$0** |
| **10M events/mo** | **Workers Paid $5 base** — WAE 10M & Workers 10M both exactly included; D1/DO within free allowances | **~$5** (skip Queues; direct WAE write — Queues would add ~$11.60) |
| **100M events/mo** | WAE 90M overage ×$0.25 = $22.50; Workers 90M ×$0.30 = $27.00; DO ~$0.60 | **~$55–60** |

- **First constraint to bite is WAE adaptive sampling, not cost** — accuracy degrades before
  any hard wall. At ~38 events/s average (100M/mo) sampling stays minimal **if** the index is
  spread across many values (e.g. per-site). ⚠️ threshold is approximate.
- **Skip Queues for the self-host default** — 3 ops/message makes them the dominant variable
  cost at volume; write directly to WAE from the collector and reserve Queues/Pipelines for
  users who opt into archival.

**One-command deploy.** "Deploy to Cloudflare" button (Apr 2025) clones the repo, provisions
bindings from `wrangler.jsonc`, wires Workers Builds CI/CD. Auto-provisions KV/D1/R2/DO/Queues
/Vectorize/Hyperdrive/Workers AI/Secrets Store. **WAE datasets need no pre-provisioning** —
declare `[[analytics_engine_datasets]]` with just a binding name; created on first write
(two-source confirmed, HIGH). Secrets prompted via `.dev.vars.example`/`.env.example`.
`wrangler deploy` auto-provisioning went GA Feb 25 2026 (Wrangler 4.68+). ⚠️ **Manual steps
not auto-configured:** the **Cloudflare Access policy** for the dashboard and custom-domain
routing (inferred, not doc-confirmed — verify, but architecturally true: Access policies
can't be provisioned by the button).

---

## Open technical risks / decisions for the spec

1. **WAE sampling vs. accuracy** for a "count my visitors" product where users expect exact
   numbers. Need a rollup/validation strategy; decide messaging on sampled metrics.
2. **3-month retention** — is "last 90 days" acceptable for MVP, or is R2 archival in-scope v1?
3. **Queues: in or out of the default path?** (Lean: out, for cost/simplicity.)
4. **Auth: Cloudflare Access vs. self-rolled** — Access is easier but adds a manual setup step
   and a Zero-Trust dependency; self-rolled is one-click-deployable but is auth code to own.
5. **Dashboard framework** choice (Hono+HTMX for tiny, or SvelteKit for richer UX).

## Sources (grouped by angle, with dates)

**Backbone:** WAE limits/pricing/sampling/SQL/FAQ (developers.cloudflare.com/analytics/…,
2026-04-23); WAE blob-size changelog (2025-06-20); WAE SQL expansion changelog (2025-10-02);
D1 limits/pricing (2025-09-11); D1 read-retry changelog (2025-09-11); R2 limits/pricing
(2026-04-23); Pipelines limits/pricing (2026-05-28 / 2025-09-25); R2 SQL deep-dive blog
(2025-09-25); Cloudflare Data Platform blog (2025-09-25); DO limits/pricing (2026-04-23);
Icelight reference build (cliftonc.nl, 2026-01-21).
**Ingestion:** Workers CORS example; Workers Request `cf` docs; Bot Management variables;
MDN sendBeacon; Clicky fetch-vs-sendBeacon (2025-10); SPA-tracking (janit/ea); cookieless
hashing (citare.ai 2026-05-21, xolqy-com/xolqy); KV rate-limiter (CF community); Queues
limits/pricing; Pipelines SQL changelog + writing-to-streams (2025-09-25); serverless-ETL
reference architecture.
**Query:** WAE SQL reference (statements/aggregate-functions, 2026-04-23); Sink issue #164
(429s, 2025-06-30, third-party); Cron Triggers docs; Zenn 3-tier cache (third-party); Cache
API docs (2026-04-23); DO WebSockets best-practices + limits (2026-04-23); full-stack Workers
blog (2025-03-12); Cloudflare Access authorization-cookie + self-hosted-apps docs (2026-04-23).
**Cost/deploy:** Workers/D1/DO/Queues/WAE pricing pages (2026-04-23); Deploy-to-Cloudflare
changelog (2025-04-08) + deploy-buttons docs (2026-04-23); Wrangler config docs (2026-06-12);
Wrangler autoconfig GA changelog (2026-02-25).

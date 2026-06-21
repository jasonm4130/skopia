# 0001 — Data backbone (WAE + D1 + DO + KV split)

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

Skopia must ingest high-cardinality web-analytics events (pageviews + custom events) at the
edge, store them cheaply with no database server to operate, and serve a snappy multi-site
dashboard — on a self-host deploy that should cost $0 on the free tier and ~$5/mo at mid-traffic
(product spec §1, §4). No single Cloudflare primitive does all of this. We must choose a
combination and justify the split. Verified constraints to honor: WAE has a **hard 3-month
retention** and **adaptive sampling** at high volume; D1 is **single-threaded** (not for raw
ingest); Cloudflare Bot Management granular scores are Enterprise-only; the Cache API is per-PoP
and disabled behind Access.

## Decision

Five primitives, each with one job:

- **Workers Analytics Engine (WAE)** — raw event ingest and ad-hoc query. Index = `site_id`.
- **D1 (SQLite)** — site/user/config metadata, goal definitions, and **exact pre-aggregated
  rollups** written by a Cron Worker (never by the hot path).
- **Durable Objects** — per-site **live-visitor** count + coordination (in-memory, ephemeral).
- **KV** — cached dashboard responses + the rotating **daily identity salt**.
- **R2 / Pipelines** — **explicitly out of MVP**; opt-in only for >90-day cold archival.

Raw events are written **directly** to WAE from the collector (no Queues — see ADR-0002).

## Alternatives considered

**A. WAE-only (query WAE on every dashboard load).** Simplest binding count, but: WAE SQL has an
undocumented rate limit (429s under dashboard interaction), ~0.5–2 s cold latency, **no JOIN/UNION**,
and sampling means raw queries aren't exact at volume. Rejected as the *sole* store — kept for
ad-hoc/today windows only.

**B. D1 as the event store.** Relational, exact, familiar. But D1 is **single-threaded** —
throughput is inverse to query time (~1,000 writes/s at 1 ms, ~10/s at 100 ms); the docs
explicitly say it is **not for high-write analytics ingestion**. Rejected for raw ingest; kept for
metadata + rollups where write volume is tiny.

**C. R2 + Pipelines (Iceberg) as the primary store.** Unlimited retention, cheap storage, free
egress. But it's a heavier pipeline (beta surfaces), R2 SQL is filter-first with aggregations
maturing, and a reference build (Icelight) warns it needs a caching layer for external query
endpoints. Overkill for MVP's 90-day window. Kept as opt-in archival only.

**D. Durable Objects as the event store (SQLite-backed, one per site).** Strong consistency,
per-site isolation. But ~1,000 req/s soft per object becomes a hot-site bottleneck, and you'd
re-implement time-series aggregation that WAE gives for free. Rejected for storage; kept for the
one thing only a DO does well — real-time coordination.

Comparison (the deciding axes):

| | WAE | D1 | DO | R2/Pipelines |
|---|---|---|---|---|
| Raw high-write ingest | **✅ purpose-built** | ❌ single-threaded | ⚠️ per-object cap | ⚠️ beta pipeline |
| Cost at volume | cheap, no per-dim cost | cheap (low write vol) | cheap (ephemeral) | cheapest storage |
| Query for dashboard | SQL, no JOIN, sampled | rich SQL, exact | n/a | filter-first, beta |
| Retention | **90 days hard** | as long as you keep | ephemeral | unlimited |
| Real-time | ❌ | ❌ | **✅** | ❌ |

## Consequences

**Easy:** zero-ops (no DB server), $0/$5 cost story, exact dashboard numbers via D1 rollups at
self-host volumes, real-time via DO, sub-10 ms reads via KV. The split maps cleanly to the deploy
button's auto-provisioning.

**Hard / watch:** five primitives is five operational + cost surfaces (justified — each is load-
bearing). The **90-day WAE retention** is an architectural ceiling, not a knob (see ADR-0003, PM
Q2). **Sampling** means reads must always be `_sample_interval`-corrected and validated by a raw
`count()` check (ADR-0003). The rollup layer is the price of "exact + snappy" — a Cron dependency
to keep healthy. **WAE billing is published but not yet active** — model the cost, watch the
changelog for switch-on.

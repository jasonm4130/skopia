# 0002 — Ingestion pipeline & cookieless identity

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

A single collector Worker must accept beacons from a <2 KB client script, validate them, drop
obvious bots without an Enterprise Bot Management dependency, enrich them server-side (to keep the
script tiny), assign a **cookieless** visitor identity (no banner — the privacy thesis), and land
the event in WAE — all fast enough not to delay page unload. We must also decide whether Queues
sit in the default path (PM Q4). Verified constraints: granular bot scores are Enterprise-only;
`request.cf` enrichment is free on all plans; Queues bill **3 operations per message**.

## Decision

**Collector Worker, direct-to-WAE, no Queues in the default path.** Per request:

1. **CORS** — answer preflight; validate `Origin` against a **per-site allowlist** (not `*`).
2. **Validate** — payload size cap, known `site_id`, event shape; drop malformed.
3. **Heuristic bot drop** — UA blocklist, datacenter-ASN / `cf.asOrganization` heuristics,
   `cf.verifiedBot` where Super Bot Fight Mode surfaces it, missing-header heuristics. **No
   dependency on `cf.botManagement.score`** (Enterprise-only). Ship a "put it behind Cloudflare
   WAF" recipe in the docs.
4. **Enrich** from `request.cf` (`country`, `colo`, `asn`, `asOrganization`, `httpProtocol`,
   `isEUCountry`) + server-side `User-Agent` parse → device class / browser / OS. **Zero client
   bytes.**
5. **Cookieless identity** — `vid = HMAC-SHA256(dailySalt ‖ clientIP ‖ UA ‖ site_id)`, truncated
   to 16 hex. **Raw IP is never written.** Daily salt in KV, rotated at UTC midnight by the Cron
   Worker (yesterday's salt deleted → cross-day correlation impossible). Site-scoped salt → the
   same visitor on two sites is unlinkable.
6. **Write to WAE** synchronously (`env.WAE.writeDataPoint`, one data point per event).
7. **Bump live count** via `ctx.waitUntil(SITE_LIVE.fetch('/hit'))` — async, non-blocking.
8. **Respond 204.**

## Alternatives considered

**Identity — cookie / localStorage ID.** Most accurate cross-day, but writes to the device →
triggers ePrivacy Art. 5(3) → **needs a consent banner**, voiding the whole thesis. Rejected.

**Identity — persistent server-side fingerprint (no daily salt rotation).** More stable uniques,
but a stable cross-day identifier is exactly the fingerprint that voids the cookieless exemption
(EDPB Guidelines 2/2023). Rejected. The daily-salt construction is the verified canonical pattern
(Plausible/Fathom/PostHog). Accepted trade-off: a returning visitor across a UTC midnight counts
as new — documented honestly.

**Queues in the default path** (collector → Queue → consumer → WAE). Adds buffering/back-pressure,
but **3 billing operations per message** makes Queues the dominant variable cost at volume
(~$11.60/mo extra at 10M/mo) for **no reliability gain** — there is no downstream system in MVP
that needs buffering, and WAE writes are already fire-and-forget at the edge. **Rejected for
default; opt-in for archival/no-JS fan-out only.** (Answers PM Q4: out.)

**Bot filtering via Bot Management scores.** Best signal, but Enterprise-only — unavailable on the
Free/Pro/Business/Workers-Paid plans our self-hosters use. Designing the moat around it was the
research's top correction. Rejected; heuristics + WAF recipe instead.

## Consequences

**Easy:** tiny client script (all enrichment is server-side and free), no cookie banner, no
Queue cost, no Enterprise dependency, fast beacon (the only synchronous write is the WAE call;
the live-count bump is `waitUntil`).

**Hard / watch:** heuristic bot filtering is imperfect (the honest position — bot handling is a
nice-to-have, not the moat). Daily-salt rotation is a Cron dependency; if it fails, uniques skew
(monitor it). Direct WAE write has no buffer — acceptable because WAE write is cheap and lossy-
tolerant for analytics, but if WAE write reliability ever became load-bearing we'd revisit Queues.
The per-site origin allowlist is our hardening choice beyond the CF CORS example (⚠️) — adds a tiny
config surface per site.

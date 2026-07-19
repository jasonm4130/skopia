# Architecture Decision Records (ADRs)

One decision per file. Lightweight. Dated. The record of *why*, so future-us doesn't
relitigate settled tradeoffs (or relitigates them deliberately with full context).

Naming: `NNNN-short-title.md` (e.g. `0001-data-backbone.md`), numbered in order.

## Decisions

All accepted unless noted.

| # | Decision | Notes |
|---|----------|-------|
| [0001](0001-data-backbone.md) | Data backbone — Analytics Engine + D1 + Durable Objects + KV, and what each stores | |
| [0002](0002-ingestion-and-identity.md) | Ingestion pipeline & cookieless identity — the beacon path and daily-salted HMAC visitor IDs | |
| [0003](0003-query-and-rollup.md) | Query, rollup & sampling-honesty strategy | rollup half superseded by 0011 |
| [0004](0004-realtime.md) | Real-time live-visitor approach | |
| [0005](0005-dashboard-and-auth.md) | Dashboard hosting, framework & auth (Worker SSR, PBKDF2 + signed-cookie sessions) | |
| [0006](0006-deploy.md) | Deploy story — the "Deploy to Cloudflare" button | |
| [0007](0007-marketing-separate-repo-static-astro.md) | Marketing site: separate repo, static Astro | |
| [0008](0008-build-tooling-no-turborepo.md) | Build tooling: pnpm, no Turborepo | |
| [0009](0009-design-token-sharing.md) | Sharing design tokens across the product and marketing repos | |
| [0010](0010-do-pending-durability.md) | Durable pending-counter state in the SiteLive DO | |
| [0011](0011-do-rollup-cutover.md) | Phase-2 cutover: the DO becomes the sole `rollup_daily` writer | supersedes the cron half of 0003 |
| [0012](0012-public-share-link-dashboard.md) | Public share-link dashboard | |

## Template

```markdown
# NNNN — <Title>

- **Date:** YYYY-MM-DD
- **Status:** proposed | accepted | superseded by NNNN
- **Owner:** product-manager | cloudflare-tech-lead

## Context
What's the situation and the requirement forcing a decision?

## Decision
What we chose, stated plainly.

## Alternatives considered
Option A / B / C — with the comparison (cost, scale, latency, complexity, lock-in) and why
they lost.

## Consequences
What this makes easy, what it makes hard, what we're now committed to, and what to watch.
```

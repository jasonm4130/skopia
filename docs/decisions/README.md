# Architecture Decision Records (ADRs)

One decision per file. Lightweight. Dated. The record of *why*, so future-us doesn't
relitigate settled tradeoffs (or relitigates them deliberately with full context).

Naming: `NNNN-short-title.md` (e.g. `0001-data-backbone.md`), numbered in order.

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

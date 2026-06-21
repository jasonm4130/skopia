# Stratus

> Working name (provisional). Privacy-respecting, self-hostable web analytics that runs
> entirely on the Cloudflare developer platform.

**Status:** 🧪 Planning / design. No product code yet — see `docs/` for the research and
specs being assembled.

## The idea

Google Analytics, reimagined as something you deploy to *your own* Cloudflare account in a
few minutes:

- A tiny tracking script (target < 2 KB gzipped) — and optional cookieless, JS-free
  collection at the edge.
- Ingestion, storage, and aggregation on Cloudflare primitives (Workers, Analytics Engine /
  D1 / R2, Durable Objects).
- A fast dashboard on Cloudflare Pages/Workers.
- No cookies, no consent banner needed, no data sold, no vendor lock-in beyond Cloudflare —
  and you own the Cloudflare account.

## How this is being planned

Two specialist agents drive the design:

| Agent | Owns | Definition |
|-------|------|-----------|
| **Product Manager** | What we build & why — features, MVP, positioning | `.claude/agents/product-manager.md` |
| **Cloudflare Tech Lead** | How we build it on Cloudflare — architecture, cost, ADRs | `.claude/agents/cloudflare-tech-lead.md` |

Research → `docs/research/` · Specs → `docs/specs/` · Decisions → `docs/decisions/`

## Repository layout

```
.claude/agents/   PM + tech-lead agent definitions
docs/research/    Deep-dive research (competitive analysis, Cloudflare architecture)
docs/specs/       Approved design specs
docs/decisions/   Architecture Decision Records (ADRs)
CLAUDE.md         Operating contract for agents/humans in this repo
```

## License

TBD (an OSS-friendly license — MIT or Apache-2.0 — to be confirmed in the spec).

# Skopia

Cloudflare-native, self-hostable, privacy-first web analytics. Product pitch, positioning,
differentiation and non-goals: `docs/specs/2026-06-21-product-spec.md` and `README.md`.

This file is the operating contract for any AI agent or human working in this repo. It
overrides default behavior. Read it before acting.

---

## The two decision-making agents

This project is planned by two specialist agents. **Use them — don't improvise their jobs.**

- **`product-manager`** (`.claude/agents/product-manager.md`) — owns *what* we build and
  *why*. Feature prioritization, MVP definition, competitive positioning, success metrics.
- **`cloudflare-tech-lead`** (`.claude/agents/cloudflare-tech-lead.md`) — owns *how* we
  build it on Cloudflare. Data backbone, ingestion, dashboard, cost/scale, ADRs.

Dispatch them for decisions in their lane. The PM does not pick databases; the tech lead
does not pick the feature roadmap. Cross-lane conflicts are resolved by writing it down in
`docs/decisions/` and surfacing the tradeoff to the human.

---

## Engineering conventions (provisional — tech lead finalizes)

- **Bloat discipline is the product.** We are building the *opposite* of bloated analytics,
  so it applies to our own code first. The tracking script in particular is sacred: every
  byte ships to every visitor.
- **Every changed line traces to a requirement or an ADR.** Cross-lane conflicts get written
  down in `docs/decisions/` rather than settled in a diff.
- **Language:** TypeScript everywhere. Strict mode.
- **Runtime:** Cloudflare Workers. Config via `wrangler.jsonc`.
- **Docs that bind:** Cloudflare moves fast. Bias to retrieving *current* Cloudflare docs
  (via the Cloudflare docs MCP, `cloudflare-docs`) over pre-trained knowledge.
  When in doubt about a binding, limit, or pricing detail, look it up.
- **Tests:** Vitest with the Workers pool (`@cloudflare/vitest-pool-workers`) for Worker
  code. TDD for non-trivial logic.
- **The tracking script budget:** target < 2 KB gzipped. This is a product differentiator,
  not a nice-to-have. Treat regressions as bugs.
- **Privacy by default:** no cookies, no cross-site identifiers, no raw PII at rest unless
  an ADR explicitly justifies it and documents the retention/anonymization story.

## Where things live

```
.claude/agents/        The PM and tech-lead agent definitions
docs/research/         Deep-dive research outputs (cited, dated)
docs/specs/            Approved design specs (the source of truth for what we build)
docs/decisions/        ADRs — one decision per file, dated, with context + consequences
```

## Related repositories

- **`skopia-www`** (`jasonm4130/skopia-www`) — the marketing site (**skopia.dev**). Its own repo: a **static Astro**
  site deployed to **Cloudflare Workers Static Assets** (ADR-0007), **not** a workspace member
  of this repo (so the one-click Deploy button stays single-package). It no longer copies
  `src/shared/tokens.css` (ADR-0009, amended 2026-09-27); its styles live in its own
  `src/styles/site.css`. The product
  Worker serves the app/collector (`app.skopia.dev`); marketing owns the apex (`skopia.dev`).

## Workflow

1. Research lands in `docs/research/`.
2. PM + tech-lead synthesize it into a spec in `docs/specs/` and ADRs in `docs/decisions/`.
3. Specs get human approval before implementation.
4. Implementation follows the spec; deviations update the spec or open a new ADR.

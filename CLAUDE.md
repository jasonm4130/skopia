# Skopia — Cloudflare-native web analytics

> **Skopia** (Greek *skopeín*, "to observe"; domain **skopia.dev**) — a privacy-respecting,
> self-hostable web analytics tool built *entirely* on the Cloudflare developer platform.
> Think Plausible/Umami, but where the storage, compute, ingestion, and dashboard all run on
> Cloudflare primitives (Workers, Analytics Engine / D1 / R2, Durable Objects, Pages).

This file is the operating contract for any AI agent or human working in this repo. It
overrides default behavior. Read it before acting.

---

## What we are building

- **Product:** A drop-in `<script>` (and optional cookieless/server-side collection) that
  reports site traffic to a Cloudflare-hosted backend, with a dashboard for viewing it.
- **Positioning:** Open-source, **self-host on your own Cloudflare account**. One deploy =
  one owner's sites. No multi-tenant billing, no SaaS control plane (yet). Easy `deploy`
  is a first-class feature.
- **Differentiation:** *Deliberately undecided.* The strongest defensible angle (privacy-
  first vs. Cloudflare-edge-native vs. GA4-parity) is being chosen from research by the
  product + tech-lead agents. Do not assume — check `docs/specs/` for the decided thesis.
- **Non-goals (for now):** Multi-tenant SaaS billing, ad-tech/PII profiling, cross-site
  user tracking, a hosted offering. Revisit only if the spec says so.

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

## Behavioral defaults (Karpathy 4)

These are the operating rules for every change in this repo.

1. **Think before coding (and before answering).** State assumptions out loud. If multiple
   interpretations exist, ask only when guessing wrong is costly (irreversible action, lost
   work, wrong direction on multi-step work); otherwise state your interpretation and
   proceed. Ask at most one question — never a list.

2. **Simplicity first.** No features beyond what the spec asks for. No abstraction for
   single-use code. We are building the *opposite* of bloated analytics — that discipline
   applies to our own code too. If you write 200 lines and it could be 50, rewrite it. The
   tracking script in particular is sacred: every byte ships to every visitor.

3. **Surgical changes.** Touch only what you must. Don't "improve" adjacent code. Match
   existing style. Every changed line should trace to a requirement or an ADR.

4. **Goal-driven execution.** Define the success criterion, then loop until verified.
   "Fix the bug" becomes "write a test that reproduces it, then make it pass." State
   problems *before* executing a flawed plan. Confidence proportional to evidence.

## Verification before claiming complete

Before saying work is done: run typecheck/tests/lint, read the actual output, and quote a
specific success line. "Looks good" without verification is a fail. If a check can't run in
the current environment, say so explicitly rather than implying success.

## Engineering conventions (provisional — tech lead finalizes)

- **Language:** TypeScript everywhere. Strict mode.
- **Runtime:** Cloudflare Workers. Config via `wrangler.jsonc`.
- **Docs that bind:** Cloudflare moves fast. Bias to retrieving *current* Cloudflare docs
  (via the `cloudflare` skills / Cloudflare MCP / context7) over pre-trained knowledge.
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

- **`../skopia-www`** — the marketing site (**skopia.dev**). Its own repo: a **static Astro**
  site deployed to **Cloudflare Workers Static Assets** (ADR-0007), **not** a workspace member
  of this repo (so the one-click Deploy button stays single-package). Design tokens flow
  one-way: `src/shared/tokens.css` here is the **source of truth**, copied into
  `skopia-www/public/tokens.css` (ADR-0009) — edit tokens here, then re-copy. The product
  Worker serves the app/collector (`app.skopia.dev`); marketing owns the apex (`skopia.dev`).
  Local cross-repo file access is wired via `.claude/settings.local.json` (gitignored).

## Workflow

1. Research lands in `docs/research/`.
2. PM + tech-lead synthesize it into a spec in `docs/specs/` and ADRs in `docs/decisions/`.
3. Specs get human approval before implementation.
4. Implementation follows the spec; deviations update the spec or open a new ADR.

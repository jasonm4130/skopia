# 0008 — Build tooling: pnpm, no Turborepo

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

With marketing moving to Astro in its own repo (ADR-0007), the question arose whether to adopt
Turborepo (or another monorepo orchestrator) to manage builds across the product and marketing
code.

## Decision

**Stay on plain pnpm. No Turborepo (and no Nx).**

The product and marketing live in two separate, single-package repos (ADR-0007). There is no
inter-package task graph to orchestrate and no shared build cache to exploit, so a monorepo
task-runner has nothing to do here.

**Revisit trigger:** adopt a monorepo task-runner only if the project ever consolidates into a
monorepo with **4+ packages AND CI time exceeding ~2 minutes**. At that point `npx turbo init` is a
~10-minute addition — defer until then.

## Alternatives considered

**A. Turborepo.** Rejected. Research (five independent 2025–2026 sources) is consistent: Turborepo
earns its keep at 3+ engineers or when CI rebuild time is a *felt* pain. Neither applies — solo
maintainer, sub-30-second builds. Across two separate single-package repos it has literally nothing
to cache or graph, and it would add a `turbo.json` mental model plus a binary in the deploy path —
making the contributor/forker experience heavier, not lighter.

**B. Nx.** Rejected for the same reasons, with more configuration surface than Turborepo.

**C. pnpm workspaces in a single monorepo.** Moot — ADR-0007 chose two repos, not a monorepo.

## Consequences

**Easy:** contributors use only `pnpm` (familiar, zero extra concepts); no third-party remote-cache
dependency (e.g. a Vercel cache or a self-hosted cache Worker); the build chain stays simple and
fast.

**Watch:** if shared code volume across the two repos grows substantially, revisit this together
with the repo-structure decision (ADR-0007) and the design-token decision (ADR-0009) — the answer
might become "publish shared packages" or "consolidate into a monorepo (then add a task-runner)",
but only once the volume justifies it.

# 0009 — Sharing design tokens across the product and marketing repos

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

ADR-0007 puts the product (`skopia`) and marketing (`skopia-www`) in separate repos. They share a
brand surface, so we need a way to keep them visually consistent without "fighting to keep two
things in sync" (the maintainer's explicit priority).

The realistic shared surface is **design tokens** — colors, type scale, fonts, spacing, radii, a
base CSS reset, the logo — **not components** (Astro markup and Hono SSR markup don't share
component code). The product repo is the source of truth ("design comes from the deployable
worker"): the dashboard already uses these tokens directly.

## Decision

**Start by copying a single `tokens.css`; promote to a published `@skopia/design` package only when
the copy actually chafes.**

- **Now:** keep tokens as one `tokens.css` (CSS custom properties) in the product repo, and **copy
  it into the marketing repo**. Tokens change rarely once established, so a copy-on-change is less
  total effort than standing up package infrastructure for a brand-new site whose tokens will churn
  early then settle.
- **Later (trigger: the copy becomes annoying / tokens change often / real shared components
  emerge):** extract **`@skopia/design`** (tokens + base CSS only) — source in the product repo,
  consumed by the dashboard locally and by `skopia-www` via the registry. Publish to **public npm**
  so the marketing CI needs **zero auth** (a plain `pnpm install`). Automate the publish on change.

## Alternatives considered

**A. `pnpm link` / `file:` as the dependency.** Rejected as the *sole* mechanism: it works for
local dev but **breaks the marketing site's deploy** — Workers Builds doesn't have the product repo
checked out, so the link can't resolve. Fine as a local-dev override layered on top of a real
(copied or published) dependency.

**B. Git dependency on the product repo (`github:jasonm4130/skopia#tag`).** Deferred: pnpm's
git-subdirectory support is finicky and it couples the marketing build to the whole product repo
tree. A published package is cleaner once we get there.

**C. Publish `@skopia/design` immediately.** Deferred (not rejected): it's the correct end state,
but premature for a site whose tokens will churn during early design — it adds a publish/version
gate before it earns its keep (YAGNI).

**D. GitHub Packages instead of public npm.** Rejected for the eventual package: it requires auth
tokens wired into Workers Builds CI — friction for no benefit on an open-source project. Public npm
is auth-free for consumers.

**E. Design system as its own third repo.** Rejected: the product repo is the natural source of
truth (the dashboard consumes the tokens directly); a third repo adds a moving part.

## Consequences

**Easy:** immediate progress on the marketing site with no package infrastructure; the dashboard
keeps using tokens directly.

**Honest tradeoff:** a shared package consumed by two repos is *literally the monorepo use case*.
The two-repo choice (ADR-0007) means paying a small sync cost — a copy now, a publish-gate later —
to keep the repos separate and the product repo pristine. Accepted deliberately.

**Watch:** if tokens start changing frequently, or components genuinely need sharing, that's the
signal to either promote `@skopia/design` to a package (per this ADR) or reconsider the two-repo
split (ADR-0007) and build tooling (ADR-0008) together.

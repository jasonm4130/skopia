# 0007 — Marketing site: separate repo, static Astro

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

`skopia.dev` is the project's public front door and the maintainer's live (dogfood) instance.
The product is open-source self-host, and one-click "Deploy to Cloudflare" is a first-class
feature (ADR-0006: TTFD < 10 min, setup-failure rate < 10%). Today the single Worker also serves
the marketing landing page at `/` (Hono SSR). We want: (a) a richer marketing site built with
**Astro**, (b) a clean separation so forkers and contributors see only the analytics product, and
(c) neither of those to break the one-click deploy or create a cross-repo sync nightmare.

Three research passes this session (with the PM and tech-lead agents) established the binding
facts:

- Cloudflare's current direction is **Workers + Static Assets**; Pages is maintenance-mode as of
  April 2025 ("you should start with Workers… all investment going forward is on Workers").
- The **Deploy button does not support monorepos**: a subdirectory target requires full dependency
  isolation, the `root_directory` setting is dashboard-only (not committable), and the pnpm
  "installs all workspaces" behaviour (`workers-sdk#10941`) is workaround-only
  (`SKIP_DEPENDENCY_INSTALL`, dashboard-set).
- The genuinely **shared surface** between marketing and the dashboard is design *tokens*, not
  components (Astro markup ≠ Hono SSR markup).

## Decision

**Marketing lives in its own repository (`skopia-www`), as a static Astro site, deployed as its
own Cloudflare target. The product repo (`skopia`) stays single-package with `wrangler.jsonc` at
the repo root so the Deploy button is untouched.**

- **Two repos.** `skopia` = the product Worker (pristine, only the analytics product).
  `skopia-www` = the Astro marketing site.
- **Product deploy unchanged.** `wrangler.jsonc` stays at the `skopia` repo root; the Deploy
  button points at the repo root and behaves exactly as today. Forkers deploy only the product
  Worker to their own account and never touch the marketing site.
- **Marketing is static Astro** (`output: 'static'`, no adapter), deployed to its own Workers
  Static Assets target (`skopia-marketing`). Static asset requests are free and edge-cached.
- **CSP is hash-based** for the static site (a per-request nonce is impossible for a static file).
  Astro computes script hashes; the policy is set via a committed `_headers` file (and Astro's CSP
  support). The product Worker keeps its existing per-request **nonce** CSP for `/app`, `/e`, etc.
- **Domains:** `skopia.dev` → the marketing target; `app.skopia.dev` (or `*.workers.dev`) → the
  product Worker. Forkers map their own domain to their own Worker.
- The product Worker stops serving `/`; add a `GET / → /app` redirect so a forker hitting the root
  gets the dashboard, not a bare 404.

## Alternatives considered

**A. Keep marketing in the product Worker (SSR, status quo).** Rejected: couples marketing copy to
product deploys, keeps non-product content in the product repo, and forecloses Astro. (A
hand-written static `public/index.html` in the same Worker was viable, but not an Astro toolchain.)

**B. Monorepo (one repo, product + Astro packages via pnpm workspaces).** Rejected: the Deploy
button doesn't support monorepo subdirs, and a workspace marketing package drags Astro + `sharp`
into the forker's root `pnpm install`, risking a native-build failure a non-developer can't recover
from — directly threatening ADR-0006's setup-failure target. (Turborepo separately rejected in
ADR-0008.)

**C. Git submodules / subtree under a meta-repo.** Rejected: reintroduces the two-repo design-sync
cost *and* adds git friction (detached HEAD, `--recurse-submodules`, CI complexity). Submodules are
for vendoring code you don't own, not for splitting a product you do; the Deploy button gains
nothing (you'd point it at the standalone product repo regardless).

**D. Cloudflare Pages for marketing.** Rejected: Pages is maintenance-mode; Workers Static Assets
is the recommended path and is free/unlimited for static requests.

## Consequences

**Easy:** the product repo stays pristine (only the analytics product); the one-click deploy is
unchanged; marketing iterates independently in Astro on its own cadence; the marketing `/` is free
and fast (static, zero Worker invocations).

**Hard / watch:** two repos to maintain; the shared design surface needs a deliberate mechanism
(ADR-0009); the marketing target needs a one-time Workers Builds setup (maintainer-only, not a
forker concern). This **amends the single-Worker-serves-everything assumption** of ADR-0005/0006 —
the product Worker no longer serves marketing — but the Deploy button is unaffected (it points at
the product repo root). Ship the `GET / → /app` redirect with (or before) removing the marketing
route so the product root never 404s. Hash-based CSP means a marketing rebuild is required whenever
the inline script/style content changes; enforce a hash check in the marketing repo's CI.

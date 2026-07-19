# Plan: Scaffold `skopia-www` (static Astro marketing site)

> **STATUS: COMPLETE.** `skopia-www` was scaffolded and is deployed as a static Astro site
> (see [ADR-0007](../decisions/0007-marketing-separate-repo-static-astro.md)). This is the
> durable record; the per-session plan-mode scratch file is disposable.

## Context

Next-steps item #1 from the 2026-06-21 handoff. The Skopia landing page currently lives
**inside the product Worker** as a single CSS-in-JS file (`src/marketing/index.ts`, 555
lines, served via `app.route("/", marketing)`). ADRs 0007–0009 locked the decision:
marketing moves to **its own repo** (`skopia-www`), built as a **static Astro** site,
deployed to **Cloudflare Workers Static Assets** (not Pages), sharing only **design tokens**
(copied, not packaged) with the product repo. This keeps the product Worker single-package
so the one-click Deploy button keeps working.

**Goal of this execution:** stand up `~/Work/Git/skopia-www` as a buildable, CSP-hardened,
CI-checked static site that faithfully ports the existing landing page — locally verified
green. Live deploy + domain wiring (needs a Cloudflare account) and the product-Worker
`GET / → /app` redirect + `src/marketing/` removal (next-steps item #2, a coordinated
breaking change) are **explicitly deferred** so the root doesn't 404 before skopia-www is
live.

## Scope of this execution

1. **Product repo (`skopia`):** extract design tokens into `src/shared/tokens.css`
   (ADR-0009 source of truth; additive, imported by nothing → zero behavior change), add a
   "Related repositories" note to `CLAUDE.md`, gitignore `.claude/settings.local.json`, and
   commit this plan doc. Branch → PR → `gh pr merge --merge` → resync `main`.
2. **New repo `~/Work/Git/skopia-www`:** scaffold Astro + port the landing page + CSP + CI.
3. **Cross-repo Claude Code wiring** so opening either repo can read/edit the other.

Deferred (need a CF account / coordinated change): product-Worker root redirect,
`src/marketing/` removal, `wrangler deploy`, Workers Builds connection, custom-domain wiring.

## Steps

### 1 — Product repo `src/shared/tokens.css`
`:root` custom properties (colors, fonts, layout/radii/shadows) + base reset + scrollbar +
range-input + `@keyframes skopiaPulse`, extracted verbatim from the inline values in
`src/marketing/index.ts`. Not imported by the Hono Worker — canonical reference only.

### 2 — Scaffold `skopia-www`
From `~/Work/Git/`: `pnpm create astro@latest skopia-www -- --template minimal --no-install
--git false`; `pnpm install` (its OWN lockfile — **not** a workspace member; verified no
`pnpm-workspace.yaml` at `~/Work/Git/`); `pnpm add -D wrangler`; `git init`. Astro latest is
6.x (TS strict + `output:'static'` are defaults).

- `astro.config.mjs`: `output:'static'`, `outDir:'./dist'`, **no SSR adapter**, **no Astro
  `security.csp`** (see CSP note below).
- `wrangler.jsonc`: `name:"skopia-marketing"`, `assets:{directory:"./dist",
  not_found_handling:"404-page", html_handling:"auto-trailing-slash"}`, **no `main`/binding**.

### 3 — Port the landing page
`src/marketing/index.ts` → `BaseLayout.astro` + `SkopiaMark.astro` + 11 section components
(Nav, Hero, TrustStrip, HowItWorks, ProductShot, Features, Comparison, Pricing, Faq, Cta,
Footer) + `index.astro` + `404.astro`. **The page is built with inline `style="…"` attributes
— preserve them verbatim for a pixel-faithful port.** Copy the 20 `.woff2` fonts + `tokens.css`
(→ `public/tokens.css`) + `@font-face` rules (→ `public/fonts.css`). Externalise the
calculator/FAQ IIFE to `public/scripts/calculator.js`, loaded via
`<script is:inline src="/scripts/calculator.js" defer>` (same-origin → `script-src 'self'`,
no inline script). Fixes: trust-strip `Pages` → `Analytics Engine`; rewrite product-relative
CTAs to absolute (`https://deploy.workers.cloudflare.com/?url=https://github.com/jasonm4130/skopia`
for "Deploy to Cloudflare", `https://app.skopia.dev` for `/app`/`/login`,
`https://github.com/jasonm4130/skopia` for footer placeholders); in-page anchors stay.

### 4 — CSP via committed `_headers` (corrected approach)
**Deviation from the original plan, with reason.** The original plan assumed Astro's
hash-based `security.csp`. But the design uses inline `style="…"` *attributes* everywhere,
which CSP style hashes do **not** cover (only `'unsafe-inline'` or the discouraged
`'unsafe-hashes'` do); enabling Astro's meta CSP would emit a `style-src` of hashes and
**block every inline style, breaking the page**. And because the only script is externalised,
there are **no inline scripts to hash**. So the correct, stronger-where-it-matters CSP is a
single committed `public/_headers` (Astro copies it to `dist/`), no nonces, no per-page
hashes:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';
  base-uri 'none'; form-action 'self'; upgrade-insecure-requests
```

Plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy`, and immutable cache for `/fonts/*`.
Script execution stays strict (`script-src 'self'`, no inline JS). This honors the ADR-0007
intent (committed `_headers`, no per-request nonce) — the "hash check" requirement is met by
a CI guard that **fails if any inline `<script>` body appears in the built HTML** (it would be
CSP-blocked at runtime), rather than generating hashes for scripts that don't exist.

`.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → `pnpm build` → assert
`dist/_headers` has the CSP line and it's < 2000 chars → assert no inline `<script>` bodies in
`dist/**/*.html`.

### 5 — Cross-repo Claude Code wiring
`permissions.additionalDirectories` (sibling relative path) in each repo's **gitignored**
`.claude/settings.local.json` (kept out of the open-source product repo's shared settings).
Committed `CLAUDE.md` "Related repositories" note in each repo (that's what loads when the repo
is opened; `additionalDirectories` grants file access only). New `skopia-www/CLAUDE.md`:
tokens are copied FROM the product repo (edit there, re-copy), ADRs live there.

## Verification (local, before any deploy)
`pnpm build` green; `dist/index.html` has all 11 sections + `dist/404.html`; `dist/_headers`
CSP present and < 2000 chars; no `@astrojs/cloudflare`; isolated lockfile (no `node_modules`
at `~/Work/Git/`); `wrangler dev` serves with **no CSP violations** in the console; trust strip
reads `Analytics Engine`; calculator slider + FAQ accordion work (first FAQ open on load);
product repo `pnpm ci` still green (191 tests).

## Deferred (need CF account / coordinated change)
- Product Worker `app.get("/", c => c.redirect("/app", 302))` + remove `src/marketing/` —
  ship **only once skopia-www is live** (else `/` 404s). Next-steps item #2.
- `wrangler login && wrangler deploy`; Workers Builds (build `pnpm run build`, output `dist`);
  custom domains `skopia.dev` + `www.skopia.dev` 301; create `github.com/jasonm4130/skopia-www`.

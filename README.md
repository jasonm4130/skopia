# Skopia

> Working name (provisional). Privacy-respecting, self-hostable web analytics that runs
> entirely on the Cloudflare developer platform.

**Status:** 🚀 MVP shipped. Deploy to your own Cloudflare account with the button below.

## The idea

Google Analytics, reimagined as something you deploy to *your own* Cloudflare account in a
few minutes:

- A tiny tracking script (target < 2 KB gzipped) — and optional cookieless, JS-free
  collection at the edge.
- Ingestion, storage, and aggregation on Cloudflare primitives (Workers, Analytics Engine /
  D1 / Durable Objects).
- A fast dashboard served by the same single Worker.
- No cookies, no consent banner needed, no data sold, no vendor lock-in beyond Cloudflare —
  and you own the Cloudflare account.

## Deploy

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jasonmatthew/analytics)

The button clones this repo into your account and provisions the following automatically
from `wrangler.jsonc`:

| Resource | How it's provisioned |
|----------|----------------------|
| D1 database | Auto-provisioned by the button |
| KV namespaces (cache + salt) | Auto-provisioned by the button |
| Durable Object (SiteLive) | Provisioned via DO migration |
| Workers Analytics Engine dataset | Created on first write — nothing to do |
| Static assets (fonts + vendor JS) | Shipped with the Worker — nothing to provision |

**The button will prompt you for four secrets** (declared in `package.json`
`cloudflare.bindings`). Generate them before you click:

### Generating your secrets

**`AUTH_COOKIE_SECRET`** — signs the dashboard session cookie.

```sh
openssl rand -hex 32
```

Paste the output when the Deploy wizard prompts for it.

**`IDENTITY_HMAC_SECRET`** — hashes visitor identities for cookieless analytics. No two
sites' hashes are comparable even if hosted by the same operator.

```sh
openssl rand -hex 32
```

**`CF_ACCOUNT_ID`** — your Cloudflare account ID, needed for Analytics Engine queries.

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages**.
2. Your Account ID appears in the right-hand sidebar.

**`WAE_API_TOKEN`** — lets the dashboard query your Analytics Engine data. This is the one
secret you cannot generate with `openssl` — it must be minted in the Cloudflare API-token
UI:

1. Go to **My Profile → API Tokens → Create Token**.
2. Choose **Create Custom Token**.
3. Under *Permissions*, add: **Account → Account Analytics → Read**.
4. Under *Account Resources*, select your account.
5. Click **Continue to summary → Create Token**.
6. Copy the token — it is shown only once.

### After deploy

- **Dashboard shows data** once `WAE_API_TOKEN` is set — it's what powers the Analytics
  Engine queries behind every chart.
- **Ingest works** once `IDENTITY_HMAC_SECRET` is set — without it the collector returns
  `503` rather than signing with an undefined key.
- On first dashboard load, a setup screen prompts you to create your owner password. This
  is the only manual step after the Deploy wizard.
- Drop the tracking snippet on your site. **First pageview appears within minutes.**

### Local development

This project uses [pnpm](https://pnpm.io). Copy `.dev.vars.example` to `.dev.vars`
and fill in the four values, then:

```sh
pnpm install
pnpm dev
```

`wrangler dev` reads `.dev.vars` automatically. Do not commit `.dev.vars`.

### CLI / advanced deploy

```sh
pnpm install
pnpm build
wrangler deploy
```

`pnpm build` regenerates the embedded files — `src/shared/schema-embed.ts`
(cold-account D1 DDL) and `src/shared/skopia-embed.ts` (the minified tracking
script) — so `wrangler deploy` never ships stale embedded content after a fresh
clone or a migration change.

## Repository layout

```
.claude/agents/   PM + tech-lead agent definitions
design/           Frontend design system (Claude Design source — visual/behavioral spec)
docs/research/    Deep-dive research (competitive analysis, Cloudflare architecture)
docs/specs/       Approved design specs
docs/decisions/   Architecture Decision Records (ADRs)
public/           Static assets shipped with the Worker (fonts + vendored jsVectorMap)
src/              Worker source (TypeScript strict)
CLAUDE.md         Operating contract for agents/humans in this repo
```

## License

**AGPL-3.0.** Chosen to keep every feature open and unlocked while preventing a closed-source
SaaS fork — see `docs/specs/2026-06-21-product-spec.md` §6. (The `LICENSE` file is added in
Phase 0 of the build plan.)

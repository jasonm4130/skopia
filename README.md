# Skopia

> Privacy-respecting, self-hostable web analytics that runs entirely on the Cloudflare
> developer platform. *Skopia* — from the Greek *skopeín*, "to observe."

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

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jasonm4130/skopia)

See the [install guide](docs/install.md) for complete setup instructions, including secret
generation and configuration for both the Deploy button and CLI alternatives.

### Custom domain (optional)

By default your deploy is reachable at `https://skopia.<your-subdomain>.workers.dev`. To
serve it on your own domain, add a **Custom Domain** to the Worker — Cloudflare provisions
the DNS record and TLS certificate automatically. The domain must be in the same Cloudflare
account.

- **Dashboard:** Workers & Pages → your `skopia` Worker → **Settings → Domains & Routes →
  Add → Custom Domain**, then enter your domain (apex or subdomain).
- **Config:** or add a route to your own `wrangler.jsonc` and redeploy:

  ```jsonc
  "routes": [{ "pattern": "analytics.example.com", "custom_domain": true }]
  ```

Keep your own domain out of the upstream `wrangler.jsonc` if you plan to send PRs — the
committed config stays domain-agnostic so the one-click deploy works for everyone.

## Documentation

- [Install guide](docs/install.md) — add the tracking snippet, verify it, track
  multiple sites, send custom events.
- [Privacy & data collection](docs/privacy.md) — exactly what is and isn't collected.
- [Contributing](CONTRIBUTING.md) — dev setup, conventions, the tracking-script budget.
- [Security policy](SECURITY.md) — how to report a vulnerability; the security model.
- [Architecture decisions](docs/decisions/) — the ADRs behind the design.

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

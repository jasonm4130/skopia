# Security Policy

Skopia handles website visitor data, so we take security seriously. This document
explains how to report a vulnerability and summarizes the security model so you know
what to expect.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use **GitHub's private vulnerability reporting**: go to the repository's
**Security** tab → **Report a vulnerability**. This opens a private advisory visible
only to the maintainers.

> Maintainers: if you prefer an email channel, add a security contact address here.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept if you have one).
- Affected component (tracking script, collector, dashboard/auth, cron, deploy).
- Any suggested remediation.

We will acknowledge your report, keep you updated on progress, and credit you when a
fix ships (unless you prefer to remain anonymous). This is a volunteer open-source
project, so responses are best-effort.

## Supported versions

Skopia is pre-1.0. Security fixes are applied to the **latest `main`** only. If you
self-host, track `main` (or tagged releases once they exist) and redeploy to pick up
fixes.

## Security model (how Skopia protects data)

Understanding the design helps you report meaningful issues.

- **Self-hosted, single-owner.** Each deployment runs in one operator's Cloudflare
  account. There is no central Skopia server and no multi-tenant control plane; the
  operator owns all data and all secrets.
- **Secrets are never committed.** `AUTH_COOKIE_SECRET`, `IDENTITY_HMAC_SECRET`,
  `CF_ACCOUNT_ID`, and `WAE_API_TOKEN` are set via `wrangler secret put` or the
  Deploy-button prompts. `.dev.vars` is gitignored. The collector **fails closed** —
  it returns `503` rather than signing visitor IDs with an undefined key.
- **Dashboard authentication.** The owner password is hashed with **PBKDF2-SHA256,
  210,000 iterations**, using a 32-byte random salt. Sessions are **stateless,
  HMAC-signed cookies** (`AUTH_COOKIE_SECRET`) — there is no server-side session
  store to leak.
- **Cookieless visitor identity.** Visitor IDs are a daily-salted HMAC over
  `(salt, ip, ua, site_id)`. The raw IP is never persisted, and the salt rotates at
  UTC midnight (previous day deleted), preventing cross-day correlation. See
  [docs/privacy.md](./docs/privacy.md).
- **Content Security Policy.** Every response carries a per-request nonce with
  `'strict-dynamic'`; there are no inline scripts without a nonce.
- **CORS.** The collector validates each beacon's `Origin` against a per-site
  allowlist; once an allowlist is set, headerless and off-list requests are rejected.
- **Bot filtering.** Obvious automated traffic is dropped before it is stored.

## Hardening recommendations for operators

- Use a strong, unique owner password at first-run `/setup`.
- Set a per-site **origin allowlist** so only your domains can submit data
  (see [docs/install.md](./docs/install.md#3-lock-down-which-origins-can-send-data-optional)).
- Generate secrets with a CSPRNG (`openssl rand -hex 32`) and rotate them if you
  suspect exposure.
- Consider putting the dashboard behind **Cloudflare Access** for an extra
  authentication layer.
- Keep your deployment current with `main`.

## Scope

In scope: the Worker code in this repository — the tracking script, the collector,
the dashboard and its authentication, the cron rollup, and the deploy path.

Out of scope: the Cloudflare platform itself, and misconfiguration of your own
Cloudflare account (e.g. leaked API tokens, weak passwords, an over-broad origin
allowlist). Those are the operator's responsibility.

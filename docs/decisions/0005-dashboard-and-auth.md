# 0005 — Dashboard hosting, framework & auth

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

We need to host the dashboard (owner view + per-site public/shareable read-only view) and protect
the owner view with single-owner auth. Two product constraints dominate: **TTFD < 10 min** and
**one-click "Deploy to Cloudflare"** (product spec §5, §7 Q5). The auth choice is the lever:
Cloudflare Access is lowest-friction *to operate* but **cannot be provisioned by the Deploy
button** (manual Zero-Trust org + policy) — a detour that threatens both goals. The free Zero-Trust
seat count could not be re-confirmed from a tier-1 source on 2026-06-21 (⚠️). Verified: CF directs
full-stack investment to Workers over Pages; Hono/SvelteKit/Remix all GA on Workers; Access
disables the Cache API (we use KV anyway, ADR-0003).

## Decision

**Single Worker (SSR + API + static assets) using Hono. Auth = self-rolled HMAC-signed cookie
session, NOT Cloudflare Access.**

- **Hosting:** one Worker hosts the dashboard SSR, the JSON API, and static assets → one deploy
  target, fewest bindings, simplest one-click story.
- **Framework:** **Hono** — tiny, Workers-native, JSX/SSR, fast routing; right for a read-mostly,
  polish-focused dashboard. Charts via a small client lib loaded **only on the dashboard** (never
  touches the 2 KB tracking-script budget).
- **Public dashboards:** the same SSR read views, gated by a per-site `public_token` route
  (`/public/<token>`), read-only, no auth — cheap because the read path is already per-site.
- **Auth:** owner sets a password on first run (salted hash via Web Crypto `PBKDF2`/`scrypt`, stored
  in D1). Login issues an **HMAC-SHA256-signed, HttpOnly, Secure, SameSite=Lax cookie**
  (`AUTH_COOKIE_SECRET`), ~30-day sliding expiry. One login handler + one verify middleware.
- The deploy README documents an **opt-in "wrap it in Cloudflare Access"** recipe for users who
  want SSO/Zero-Trust.

## Alternatives considered

**Auth A — Cloudflare Access (chosen against).** Pros: zero auth code to own, JWT cookie, MFA/SSO
for free, GA on all plans. Cons: **not provisionable by the Deploy button** → a manual Zero-Trust
setup step that breaks one-click and hurts TTFD; free-seat allowance unconfirmed (⚠️); ties the
product to Zero-Trust. The product requirement is the *outcome* (owner logs in within TTFD without
a Zero-Trust detour) — Access fails that for the default user. **Rejected as default, offered as
opt-in.**

**Auth B — self-rolled signed cookie (chosen).** Pros: fully one-click-deployable, protects TTFD,
small auditable surface, no external dependency. Cons: it's auth code we own and must secure
(mitigated: standard signed-cookie + Web Crypto, small, well-understood). **Chosen** — it is the
only option that keeps the headline UX promise intact for the default deploy.

**Framework — SvelteKit / Remix.** Richer client UX, but heavier for a read-mostly dashboard and a
larger deploy. Hono is the simplicity-first pick; revisit only if the dashboard becomes highly
interactive.

**Hosting — Cloudflare Pages.** Still supported, but gets no new feature work (⚠️ "deprecated"
overstates it) and splits the deploy into two targets. Single Worker is simpler. Rejected.

## Consequences

**Easy:** true one-click deploy with working auth and **no manual Access policy** — the single
biggest TTFD win. Public dashboards fall out of the per-site read path for near-zero extra effort.
KV caching works (no Cache-API/Access conflict).

**Hard / watch:** we own the auth code — keep it small and audited (password reset, cookie
rotation, rate-limited login are the surfaces to get right). Self-rolled auth is single-owner by
design; multi-user/SSO is a future ADR if the product ever needs it (the Access opt-in recipe is
the interim answer for SSO-wanting users). If the human prefers Access as default, re-verify the
free-seat count first and accept the TTFD cost.

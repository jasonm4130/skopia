# 0006 — Deploy story (Deploy to Cloudflare button)

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

One-click "Deploy to Cloudflare" is a first-class product feature (product spec §1, §4, #3) and
the headline UX metric is **TTFD < 10 min** with **setup-failure rate < 10%**. We must decide how
the deploy provisions bindings and exactly which steps remain manual. Verified: the Deploy button
clones the repo, provisions bindings from `wrangler.jsonc`, and wires Workers Builds CI/CD;
**Wrangler auto-provisioning of KV/R2/D1 is GA** (changelog 2025-10-24); **WAE datasets need no
pre-provisioning** (created on first write — two-source HIGH); DO classes provision via migrations;
**Cloudflare Access policies cannot be provisioned by the button** (which is why ADR-0005 chose
self-rolled auth).

## Decision

**Ship a "Deploy to Cloudflare" button + a `wrangler.jsonc` that auto-provisions everything the
button can, and reduce manual steps to the absolute minimum by choosing self-rolled auth.**

Auto-provisioned by the button from `wrangler.jsonc`: **D1, KV (cache + salt), Durable Object
(SiteLive via migration).** **WAE dataset** auto-creates on first write (declare binding only).
Workers Builds CI/CD is wired automatically.

**Secrets** (`IDENTITY_HMAC_SECRET`, `AUTH_COOKIE_SECRET`) are generated on first run (or prompted
via `.dev.vars.example`); the README documents generating them with a one-liner.

**Manual steps — deliberately minimized to two, both optional/trivial:**
1. **First-run owner password** (a setup screen on first dashboard load) — unavoidable and fast.
2. **Optional custom-domain routing** for the collector/dashboard (a `workers.dev` subdomain works
   out of the box for TTFD; custom domain is a later nicety).
3. **No auth-policy step** — the single genuinely painful manual step (a Cloudflare Access policy)
   is removed by ADR-0005's self-rolled auth. This is the main TTFD protection.

## Alternatives considered

**A. `wrangler deploy` from a cloned repo (CLI path).** Works for developers, but it's not
"one-click" and raises the setup-failure rate for less CLI-comfortable users. Kept as the
documented advanced path; the button is the default.

**B. Pre-provision resources via a setup script the user runs.** More control, but more steps and
more failure surface — the opposite of the goal. Rejected; auto-provisioning does this for us.

**C. Default to Cloudflare Access for auth (accepting the manual policy step).** Rejected in
ADR-0005 — it reintroduces exactly the manual step this ADR exists to eliminate and pushes TTFD
past the target.

**D. Bundle R2/Queues in the default deploy.** Rejected — they're opt-in (ADR-0001/0002). Including
them adds provisioning surface and (for Queues) cost for features MVP doesn't use. The
`wrangler.jsonc` ships them commented out for users who later opt into archival/no-JS.

## Consequences

**Easy:** a genuine sub-10-min, mostly-zero-config deploy — clone, provision, set a password, drop
the script, see data. Auto-provisioning + WAE's no-provisioning + self-rolled auth together remove
every step that previously required dashboard clicking.

**Hard / watch:** the deploy flow must be **tested end-to-end on a clean account** before launch
(the setup-failure-rate metric depends on it) — the most common failure modes are secret
generation and first-run password UX, so harden those. Auto-provisioning behavior can change with
Wrangler versions — pin a known-good Wrangler in CI and re-verify on upgrades. Custom-domain
routing remains a documented manual step (acceptable — `workers.dev` covers TTFD). DO migrations
must be present in `wrangler.jsonc` or the deploy fails — keep the migration tag in sync with the
SiteLive class.

## Addendum — 2026-06-21 (harden-and-launch sprint)

**Static assets** (Latin-subset fonts: Space Grotesk, Hanken Grotesk, JetBrains Mono; and
vendored jsVectorMap 1.6.0) ship inside the Worker version via Cloudflare Workers Static
Assets (`public/` directory, same Worker — implements ADR-0005's single-Worker topology).
Nothing to provision; no CDN dependency at runtime.

**Secrets prompt:** the Deploy button prompts for all four secrets (`AUTH_COOKIE_SECRET`,
`IDENTITY_HMAC_SECRET`, `CF_ACCOUNT_ID`, `WAE_API_TOKEN`) as declared in `package.json`
`cloudflare.bindings`. The README documents how to generate each one before clicking Deploy.

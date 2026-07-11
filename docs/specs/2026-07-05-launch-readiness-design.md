# Launch Readiness — design spec

**Date:** 2026-07-05
**Status:** Approved (human sign-off 2026-07-05)
**Goal:** OSS launch readiness — a public launch moment (Show HN / Product Hunt / GitHub),
not SEO content volume.
**Inputs:** `docs/research/2026-07-05-launch-asset-inventory-pm.md` (PM inventory),
`docs/research/2026-07-05-best-in-class-analytics-marketing.md` (best-in-class teardown).

## Decisions made

1. **Demo-first.** The public share-link dashboard feature gates the launch. Every
   successful comp derives its demo from a public-dashboard product feature dogfooded on
   its own traffic; Skopia's current "Live demo" CTA points at a login wall.
2. **Honest copy now, CLI later.** The fictional `npx skopia deploy` hero copy is
   rewritten around the real one-click Deploy button; a real `npx skopia` install wizard
   goes on the post-launch roadmap (Counterscale's CLI is the proven shape).

## Track A — Public share-link dashboard (launch gate; product lane)

**What:** The owner can enable a public, **read-only** share link per site.

Requirements (product level — technical design is the tech-lead's, via ADR):

- Unguessable token URL (Umami-style `/share/<token>`), revocable by the owner.
- Renders the standard dashboard views for that one site, logged-out: overview, pages,
  sources, devices, campaigns, events. No settings, no goal management, no site list.
- Aggressively cached (existing KV response cache; ≥60 s TTL on public routes). Must
  survive HN front-page load — Umami's demo 502'ing under load was a top attack.
- Tech-lead decides: whether the live (WebSocket) view is included in the public surface,
  token storage/format, cache strategy, cost impact.
- Dogfood: enabled for skopia.dev's own site; that URL becomes THE demo, linked from the
  marketing hero's secondary CTA and a green README badge.

**Success criterion:** the public skopia.dev dashboard URL loads in a logged-out browser,
survives a load test, and every "Live demo" link points at it.

## Track B — Repo presentation (no dependency; starts immediately)

- **README rebuild** to the exemplar anatomy: logo + incumbent-naming one-liner → badge
  row (AGPL license, CI, green "Live demo" badge once Track A ships) → real dashboard
  screenshot (honest data) → linked feature claims → **Deploy button in the first
  viewport** (deploy is the differentiator; do not bury it) → **Limitations before
  Installation** → install pointer → the rest.
- **Limitations section** (owned tradeoffs, Counterscale pattern): WAE sampling; the
  90-day WAE window and the rollup/DO-counters answer to it; exactly what daily-salt
  identity cannot tell you (monthly uniques, cross-day conversion attribution); the
  Cloudflare dependency stated plainly ("self-deployed on your own Cloudflare account").
- The four-secret setup walkthrough moves from the README to `docs/install.md`.
- **`docs/privacy.md` elevated to the canonical data-policy doc**: the exact HMAC
  formula, the day-boundary salt-rotation schedule, per-site separation, links to the
  actual source files. Never the words "GDPR compliant" — describe the mechanism and let
  readers conclude.
- Social preview (og:image) and repo-public verification.

## Track C — Marketing site (skopia-www)

**Honesty pass on the existing homepage** (copy edits; no redesign dependency):

- Script size: **554 B gzipped** everywhere "1.9 KB" appears (we under-sell by 3.4×).
- `npx skopia deploy` (hero terminal, headline, CTA, FAQ) → the one-click Deploy button
  story; "One command" framing dropped until the CLI is real.
- Free-tier claim: replace "~3M pageviews/mo" with the honest **500k–0.9M** range and
  real per-10k-events cost math; no free-tier flexing.
- Remove the fabricated "Avg. time 2m14s" stat and the CSV-import FAQ (features that
  don't exist).
- "No consent banner needed" reframed to the mechanism register ("no cookies, no
  fingerprinting — here's exactly what we store", linking the data policy).
- Wording: **"self-deployed on your own Cloudflare account"**.
- Two-sided FAQ pair: "Isn't this just Cloudflare Web Analytics?" (retention, custom
  events, multi-site, data ownership, UTM breakdowns) and "Why should I trust
  Cloudflare?" (your account, your data, auditable AGPL code — and yes, a real
  dependency).
- Hero secondary CTA → the live share URL (Track A); `ProductShot.astro` mock replaced
  with a real screenshot.

**New page:** `/data-policy` — the single canonical URL for every launch-thread privacy
fight; mirrors the elevated `docs/privacy.md`.

**Deliverable for Claude Design sessions:** per-page briefs (sections, copy, key
messages) for (1) the homepage revision and (2) the data-policy page. The human runs the
design sessions from these briefs.

The vs-Cloudflare-Web-Analytics comparison remains a homepage/FAQ asset — no standalone
comparison pages at launch (punch up, never sideways; one comparison asset only).

## Track D — Launch assets + pre-flight checklist

- **Show HN title:** "Show HN: Skopia – Open-source web analytics you deploy to your own
  Cloudflare account". PH tagline: "Privacy-first web analytics on your own Cloudflare
  account."
- **Positioning one-liner:** "Skopia is open-source, cookieless web analytics you deploy
  to your own Cloudflare account in minutes — no database to run, no consent banner, and
  every feature unlocked."
- Launch post body + prepared first comment pre-answering the five recurring objections
  (why-not-X / privacy-claim skepticism / privacy-guts-business-data / self-host
  definition + friction / accuracy + adblock irony + Cloudflare trust).
- Founder-reply playbook: concede fast and change the artifact mid-thread; one canonical
  data-policy link pasted consistently; own the limitation as positioning.
- **Pre-flight checklist:** EasyPrivacy/adblock scan of `skopia.js` and the app domain;
  demo load test; measured clean-account deploy time (the headline "minutes" number —
  roadmap #9 elevated); og previews render; repo public at the deploy-button URL.

## Sequencing

1. Tech-lead ADR for Track A (dispatched at spec approval), in parallel with Track B and
   the Track C copy pass.
2. SDD plan for Track A; execute; enable for skopia.dev; load-test.
3. Claude Design sessions (human) from the Track C briefs.
4. Track D assets last; launch when Track A + the honesty pass are green.

## Out of scope for launch

The npx CLI wizard (post-launch roadmap), docs microsite, blog, comparison-page family,
star-history chart, SaaS pricing apparatus (tiers/trials/book-a-demo), any absolute
privacy/compliance claim.

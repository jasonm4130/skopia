# Skopia — OSS-Launch Asset Inventory (PM)

- **Date:** 2026-07-05
- **Author:** `product-manager` agent
- **Goal (human-chosen):** OSS launch readiness — a public launch *moment* (Show HN /
  Product Hunt / GitHub trending) across two surfaces: the **OSS repo** (`analytics`,
  GitHub) and the **marketing site** (`skopia.dev`, `skopia-www`).
- **Product state (ground truth, 2026-07-05):** MVP shipped + hardened; DO-counters
  cutover live (2026-07-05); dashboard has Overview / Pages / Sources / Devices /
  Campaigns / Events + live view; tracking script **944 B raw · ≈570 B gzipped**
  (verified: `dist/skopia.js`, `gzip -9`; CI `check:size` budget < 2 KB reports 571 B);
  one-click **Deploy to Cloudflare** button is the distribution story.
- **Lane:** WHAT ships as a launch asset and WHY, its purpose / success criterion /
  priority. Visual design is the human + Claude Design; demo-standup / CLI-build effort is
  the `cloudflare-tech-lead`'s. Where those flip a priority, I flag it, I don't decide it.
- **Evidence base:** repo state read directly (README, `dist/skopia.js`, all
  `skopia-www/src/components/*.astro`, `docs/install.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `LICENSE`, `.github/` absent); `docs/specs/2026-07-03-feature-roadmap.md` (§1 honest-claim
  constraints), `docs/research/2026-07-03-roadmap-inputs.md` (§4 competitive refresh),
  `docs/specs/2026-06-21-product-spec.md` (thesis §1, personas §2, metrics §5).

---

## 0. TL;DR

**The launch is not blocked by missing features. It is blocked by (a) the repo not yet
looking like a finished product in the first 10 seconds, (b) no clickable live demo behind
the links we already ship, and (c) a marketing homepage that makes four claims that are
false or unverifiable — on a product whose entire thesis is honest metrics.** Fix those and
we launch.

**P0 — launch-blocking (must ship before the moment):**

1. **README restructure** — hero screenshot + one-line value prop + demo & deploy CTAs
   *above the fold*; move the long secret-generation walkthrough into `docs/install.md`.
2. **One real dashboard screenshot** (honest data) — top of README *and* replaces the
   hand-drawn fake `ProductShot.astro` on the marketing site.
3. **Live public demo** at a stable URL — the hero/CTA/footer/nav already link to
   `app.skopia.dev`; it must resolve to a real, poke-able dashboard with realtime, not a 404.
4. **Honest-claims correction pass on the homepage** — kill "1.9 KB" (→ ≈570 B), the
   fictional `npx skopia deploy` CLI, the "~3M pageviews/mo free" number (→ ~500k–0.9M per
   roadmap §1 C3), the fabricated "Avg. time 2m14s" metric, and the unbuilt CSV-import FAQ.
5. **Clean-account deploy E2E + measured TTFD** — the one-click button must work end-to-end
   on a fresh account, and the headline time claim must be the *measured* number, not "60
   seconds." (This is roadmap #9, elevated to launch-gate.)
6. **Repo public + correct path + social preview image (og:image)** — the deploy-button URL
   and every shared link 404 or render blank otherwise.
7. **Launch copy decided** — positioning one-liner, Show HN title, PH tagline.
8. **Resolve the `npx skopia deploy` decision** (flag to tech-lead/human) — build the CLI or
   change all copy to "one click." Recommendation: change the copy; don't build a CLI to make
   a slogan true.

**Recommended positioning one-liner:**
> **Skopia is open-source, cookieless web analytics you deploy to your own Cloudflare
> account in minutes — no database to run, no consent banner, and every feature unlocked.**

**Show HN title:** *Show HN: Skopia – Open-source web analytics that runs on your own
Cloudflare account*

**Product Hunt tagline (recommended):** *Privacy-first web analytics on your own Cloudflare
account*

---

## 1. Framing — the launch-moment jobs, and what "ready" means

A launch moment is a spike of *skeptical, time-boxed* strangers. Assets earn their place by
serving one of five jobs in the ~30 seconds we get:

- **J1 — "What is this and is it real?"** (GitHub visitor from HN/PH/trending): understand
  the value prop and see it's polished, in ~10s → **README hero, screenshot, demo link, badges.**
- **J2 — "Let me try it without deploying."** → **live public demo.**
- **J3 — "Fine, I'll deploy it."** → **working one-click button + honest deploy docs.**
- **J4 — "Prove the claims / find the catch."** (the HN skeptic) → **honest numbers, ADRs,
  privacy page, proactively-stated trade-offs.**
- **J5 — "Can I contribute / is it alive?"** → **CONTRIBUTING, good-first-issues, a tagged
  release, responsive issues.**

**Implication for prioritization:** for Show HN and GitHub trending, **the repo is the
product** — the README and demo do 80% of the conversion work; the marketing site matters
more for Product Hunt and Twitter referral. So README + demo + honest claims dominate P0.
Anything that serves J1–J4 for a launch-day stranger is P0/P1; anything that compounds later
(SEO pages, blog, docs microsite) is P2 no matter how "nice."

---

## 2. The honest-claims audit (the sharpest finding — launch-blocking)

Our thesis is **"honest metrics you can stand behind"** (spec §1; roadmap §1). The launch
audience (HN especially) *will* fact-check. Today the marketing homepage ships a cluster of
claims that are false, stale, or unbuilt. Shipping these on launch day is the worst possible
own-goal — it hands the top HN comment to a skeptic and forfeits the exact trust we sell.
**This is copy/claims (PM lane), not visual design.** Every item is a required P0 edit.

| # | Claim on site | Where | Reality | Fix |
|---|---|---|---|---|
| H1 | **"1.9 KB" script** | Hero terminal, Features card, HowItWorks step 02, FAQ Q4 | **≈570 B gzipped** (`dist/skopia.js` 944 B raw; CI 571 B) | State the real number. It's a *stronger* differentiator — we're under-selling a 3.4× win. Use "≈0.6 KB" / "570 bytes." |
| H2 | **`npx skopia deploy` / "one command"** | Hero terminal, CTA footer, HowItWorks step 01, FAQ Q6 | **No such CLI exists.** Real path = one-click Deploy button + `wrangler deploy` (README §Deploy) | Change copy to **"one click"** (the real, working, lower-friction story), or build the CLI (tech-lead call — see §7 O1). Do not ship a slogan the audience can't run. |
| H3 | **"free up to ~3M pageviews/mo"** | HowItWorks step 03, FAQ Q3 | Roadmap §1 **C3**: real free ceiling is **~500k safe, up to ~0.9M**; the ~3M figure is explicitly stale | Publish "~500k–0.9M pageviews/mo free, then ~$5/mo." Under-promise; it's still a great number. |
| H4 | **"Avg. time 2m14s"** metric | ProductShot mock | No sessionization → **session duration does not exist** (roadmap §1 **C2**). Real cards: Visitors / Pageviews / Views-per-Visitor / Single-Page Visits | Replace the mock with a **real screenshot** (see A2); never depict a metric we don't compute. |
| H5 | **"Import historical data from a CSV export…"** | FAQ Q5 | No importer ships (not in roadmap as built) | Remove the claim, or reframe as roadmap. Don't advertise an unbuilt feature at launch. |
| H6 | **"60 seconds" / "in one command"** deploy time | Hero, CTA, CLAUDE.md legacy | TTFD is **unmeasured** on a clean account (roadmap #9); real path includes minting a `WAE_API_TOKEN` by hand | Measure it (P0 gate #5), then quote the measured median as "in minutes." |

**Confidence: HIGH** — H1/H2/H4 verified against code; H3/H5/H6 verified against the approved
roadmap's own honest-claim constraints. This audit is the single highest-leverage thing in
this document: it's cheap (copy), it's on-thesis, and it removes the launch's biggest risk.

---

## 3. Inventory (1) — OSS repo assets

The repo is the primary launch surface. Current state is a **decent start**: `README.md`,
`LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `SECURITY.md`, `docs/install.md`, `docs/privacy.md`,
and the ADRs all exist and are solid. **Gaps: no hero screenshot, no badges, no `.github/`
(issue/PR templates), no tagged release, no social preview, README buried under a long
secret-generation walkthrough.**

| Asset | Purpose (JTBD) | Success criterion | Effort | Priority |
|---|---|---|---|---|
| **README restructure** | J1 — convert a trending visitor to a star in 10s | Value prop + screenshot + demo/deploy CTA visible before any scroll; deploy walkthrough moved to `docs/install.md` | S (content, my lane) | **P0** |
| **Hero dashboard screenshot** | J1 — prove "complete, polished" instantly | One real, honest screenshot in README + on marketing ProductShot | S (capture) | **P0** |
| **Social preview / og:image** | J1 — repo link renders as a rich card on HN/PH/X | Repo + site share with a branded card, not blank | S | **P0** |
| **Badges** (license, CI, script-size, deploy button) | J1/J4 — credibility at a glance; surfaces the ≈570 B differentiator | Badge row renders; script-size badge shows the real number | S | **P1** |
| **Repo description + topics** | J1 — discoverability on GitHub search/trending | Description set; `analytics`, `cloudflare`, `privacy`, `web-analytics`, `self-hosted` topics added | S | **P1** |
| **`.github/` issue + PR templates** | J5 — shape the incoming issue flood into usable reports | Bug + feature issue templates + PR template present | S | **P1** |
| **Curated "good first issues" (~5–8)** | J5 — convert star-ers into contributors on day one | ≥5 issues labeled `good first issue` before launch | S (curation) | **P1** |
| **Tagged release (v0.1 / v1.0) + notes** | J5 — a "version" to launch; credibility signal | A tagged GitHub release exists; footer "Changelog" link is non-empty | S | **P1** |
| **Demo GIF/loop** (deploy→first pageview, or dashboard tour) | J1/J2 — motion converts; reusable in README, HN comment, PH, tweet | A ≤15s honest loop embedded in README | M (capture+edit) | **P1** |
| **`docs/` presentation** (link ADRs + install + privacy prominently) | J4 — depth signal for skeptics; already exists | README links resolve; stale "LICENSE added in Phase 0" note removed (file exists) | S | **P1** |
| **CODE_OF_CONDUCT.md** | J5 — community hygiene | File present | S | **P2** |
| **FUNDING.yml / sponsor** | community sustainability | Present if desired | S | **P2** |

### Content brief — README restructure (P0)

*This section-by-section order is the brief; the human/Claude Design executes the visual.*

- **Above the fold (no scroll):** logo + one-line positioning (§5 one-liner) → **hero
  screenshot** → primary CTA row: **[Deploy to Cloudflare]** + **[Live demo]** + star nudge.
- **What it is / why (3–5 bullets):** self-host on *your* Cloudflare account (you own the
  data) · cookieless, no consent banner · zero-ops (no DB/server) · ≈570 B script · every
  feature unlocked, AGPL-3.0. Each bullet a verifiable fact, not a slogan.
- **What you get:** the actual shipped dashboard views (Overview, Pages, Sources, Devices,
  Campaigns, Events, live) — one line each, ideally a small screenshot strip.
- **Quickstart:** the 3-step honest deploy (button → 4 secrets → drop snippet → first data in
  minutes), then a **collapsed** deep-dive linking `docs/install.md`. The current long
  secret-generation prose moves *out* of the top-level README into install.md.
- **Honest limits (J4 disarm):** one short line each — 90-day window, daily-unique multi-day
  sum (cookieless trade-off), free-tier ~500k–0.9M/mo. Then: features, how-it-works, docs
  links, contributing, license. **Key message:** finished, honest, yours. **CTA:** Deploy /
  Demo / Star.

### Hero image / GIF strategy (P0 screenshot, P1 GIF)

- **P0 — one static screenshot.** The real dashboard (dark theme, matching the site
  aesthetic), showing Overview with realtime pulse and a couple of populated panels (top
  pages, sources). **Honest data only** — real or realistic seeded traffic; never the fake
  `2m14s`/`48.2K` mock numbers. Same asset drops into `ProductShot.astro`, retiring the
  hand-drawn SVG. This is the highest-ROI visual asset for GitHub trending.
- **P1 — one short GIF/loop (≤15s).** Either the "aha" (drop snippet → pageview appears live)
  or a 4-view dashboard pan. Reused in the README, the top HN comment, the PH gallery, and
  the launch tweet — build once, place four times.
- **Out of lane:** exact framing/motion design is the human's; I'm specifying *what to
  capture and that it must be honest*, not how it looks.

---

## 4. Inventory (2) — marketing-site pages

Current: **one polished homepage** (Nav / Hero / TrustStrip / HowItWorks / ProductShot /
Features / Comparison / Pricing / FAQ / Cta / Footer) + 404. The homepage is genuinely good
and, once the §2 claims are fixed, **carries the launch on its own.** The discipline here is
*ruthless subtraction*: almost no new page is launch-blocking.

| Page / asset | Purpose (JTBD) | Success criterion | Effort | Priority |
|---|---|---|---|---|
| **Homepage honest-claims edit** (§2) | J4 — don't hand HN the top comment | All six §2 items corrected; no unverifiable claim remains | S (copy) | **P0** |
| **Live demo instance** (behind `app.skopia.dev`) | J2 — try before deploy; the #1 non-repo asset | Stable URL resolves to a real public dashboard w/ realtime + honest data; not a 404 | flag tech-lead (S–M) | **P0** |
| **Real screenshot in ProductShot** | J1 — replace fabricated mock | Honest screenshot swapped in | S | **P0** |
| **Marketing `/privacy` page** | J4 + persona Priya — "exactly what we collect"; also serves as skopia.dev's *own* data statement | Page live; ports `docs/privacy.md`; homepage FAQ links to it | S | **P1** |
| **Comparison page: "vs Cloudflare Web Analytics"** | J4/SEO — freshest, most on-audience contrast (our users are already on CF) | Page live; claims honest per roadmap §1; cites 7-day-unsampled + perf-pivot | S–M | **P1** |
| **Comparison page: "vs Plausible CE"** | J4/SEO — the zero-ops + no-gating contrast | Page live; honest | S–M | **P2** (launch-week if time) |
| **Docs microsite** | ongoing reference | — | M+ | **P2 / cut for launch** |
| **Blog / launch-post system** | SEO + ongoing content | — | M | **P2 / cut for launch** |
| **Public roadmap page** | "is it alive" signal | — | S | **P2 / cut** (GitHub issues serve this) |
| **Changelog page** | version history | — | S | **P2 / cut** (footer links GitHub /releases) |

### Ruthless "does NOT make the launch" list — and why

- **Docs microsite** — the README + `docs/install.md` are the docs. A microsite is
  infrastructure that serves *returning* users, not launch-day strangers (J1–J4). Cut.
- **Blog system** — the Show HN post + README *are* the announcement. A blog needs Astro
  content plumbing and one post won't move launch-day conversion. Build it *after* if we want
  ongoing SEO. Cut.
- **Comparison pages beyond one** — the **homepage already has a comparison table** (Skopia
  vs Hosted SaaS vs Other self-host), which covers the launch-day "why not X" need. Dedicated
  pages are compounding SEO, not launch-moment conversion. Ship *one* ("vs Cloudflare Web
  Analytics") in launch-week; the rest are P2.
- **Public roadmap / changelog pages** — GitHub issues + releases already do this and are
  more credible for an OSS audience. Cut.
- **About / careers / integrations** — no launch-moment job. Cut.

### Content brief — marketing `/privacy` page (P1)

- **Purpose:** the "prove it" page for persona Priya and the HN privacy skeptic — *and*
  skopia.dev's own honest data statement (a privacy-analytics site with no privacy page is a
  bad look).
- **Sections:** what we collect (cookieless daily-salt identity, country, device/browser/OS
  from UA, UTM, custom events) · what we **never** collect (cookies, cross-site IDs, raw PII
  at rest, fingerprints) · where it lives (your Cloudflare account, not ours) · retention (90
  days) · the honest trade-off (multi-day uniques sum daily uniques — roadmap C1).
- **Key message:** "no consent banner because there's nothing to consent to — and here's the
  exact list." **CTA:** Deploy / read the `docs/privacy.md` source on GitHub.
- **Source:** port `docs/privacy.md`; keep claims inside roadmap §1 guardrails.

### Content brief — comparison "vs Cloudflare Web Analytics" (P1)

- **Purpose:** the sharpest, freshest contrast for our exact audience (already on Cloudflare),
  with 2026 ammunition (roadmap-inputs §4).
- **Sections:** side-by-side table — full 90-day exact data **vs CF's ~7-day unsampled then
  ~10% sampled** · UTM / custom events / funnels / live view (we have, CF lacks) · CF is
  pivoting to *performance/RUM*, not marketing analytics · you own the raw data.
- **Key message:** "when you outgrow Cloudflare's built-in Web Analytics but want to stay on
  Cloudflare, Skopia is the full-featured next step." **CTA:** Deploy / Live demo.
- **Guardrail:** every claim honest and dated per roadmap §1; no GA-style user-stitching implied.

---

## 5. Inventory (3) — the launch-moment assets

### The one-sentence positioning (recommended + rationale)

**Recommended:**
> **Skopia is open-source, cookieless web analytics you deploy to your own Cloudflare account
> in minutes — no database to run, no consent banner, and every feature unlocked.**

**Why this one:** it leads with the *moat* (self-host on your own Cloudflare + zero-ops), not
with cookieless (table-stakes — everyone in the privacy segment has it; spec §1). It is
verifiable end to end (no "one command," no "60 seconds," no "1.9 KB"). "Every feature
unlocked" plants the anti-gating wedge vs Plausible CE. Shorter memorable variants for
tweets/cards:

- **"Web analytics that runs on your Cloudflare account, not ours."** (crispest ownership hook)
- **"Own your analytics. Deploy to your own Cloudflare in minutes."**

*Alternatives considered and why not led-with:* "Plausible without the ops" (spec's internal
thesis — great for the body, too inside-baseball for a cold one-liner); "cookieless, no
consent banner" (true but table-stakes, not differentiating); anything with "one command / 60
seconds / 1.9 KB" (fails the honesty test — see §2).

### Show HN

- **Title (recommended):** *Show HN: Skopia – Open-source web analytics that runs on your own
  Cloudflare account.* (Plain, specific, novel hook. Avoid adjectives; HN strips marketing.)
- **Alt title:** *Show HN: Skopia – Cookieless analytics you self-host on Cloudflare (no
  server, no database).*
- **Angle:** first-person, honest, builder-to-builder. "I wanted Plausible without running a
  ClickHouse box, so I built analytics that lives entirely on *your* Cloudflare account." HN
  rewards candor and punishes spin — so **lead with the trade-offs**, which is on-brand: the
  ≈570 B script, 90-day window, the cookieless multi-day-unique trade-off (roadmap C1), and
  the real free-tier numbers. Link the **live demo** first, repo second. Close by inviting
  feedback on the deploy flow (we want TTFD data anyway).
- **Success criterion:** front-page reach; deploy/star lift; and — because our thesis is
  honesty — *no top comment successfully catches us in an unverifiable claim* (§2 prevents this).

### Product Hunt taglines (≤60 chars; pick one)

1. **Privacy-first web analytics on your own Cloudflare account** ← recommended
2. Cookieless web analytics you own — self-hosted on Cloudflare
3. Own your web analytics. Deploy to Cloudflare in minutes.
4. Self-hostable, cookieless analytics that runs on Cloudflare
5. Google Analytics, reimagined for your own Cloudflare account

*Recommend #1:* leads with the benefit (privacy-first) + the differentiator (your own CF
account) in-budget. If doing PH, it also needs a 3–5 image gallery (reuse the screenshot +
GIF + comparison table) and a maker's first comment (reuse the Show HN body). PH gallery +
first comment = **P1**.

### Supporting launch-moment assets

| Asset | Purpose | Success criterion | Effort | Priority |
|---|---|---|---|---|
| **og:image / social card** (repo + site) | rich rendering on HN/PH/X/Bluesky | Link previews show a branded card | S | **P0** |
| **Launch tweet/thread** (X, Bluesky, Mastodon, LinkedIn) | distribution beyond HN/PH | Thread posted; demo GIF embedded | S (my lane to draft) | **P1** |
| **PH gallery + description + first comment** | PH conversion | Present if launching on PH | M | **P1** (if PH) |
| **Maker's launch-day FAQ prep** (internal) | answer HN skeptics fast & consistently | Crisp pre-written answers to: why AGPL, why Cloudflare "lock-in," how vs CF's own tool, cross-day uniques, why not just use Plausible | S (my lane) | **P1** |

---

## 6. Consolidated priority table

**P0 — launch-blocking**

1. README restructure (hero + value prop + demo/deploy CTA above the fold)
2. Real dashboard screenshot (README + ProductShot)
3. Live public demo instance resolving at `app.skopia.dev` *(effort → tech-lead)*
4. Homepage honest-claims correction pass (§2, all six items)
5. Clean-account deploy E2E + measured TTFD *(roadmap #9, elevated)*
6. Repo public/correct-path + og:image social card
7. Launch copy decided (one-liner, Show HN title, PH tagline)
8. `npx skopia deploy` decision resolved *(→ tech-lead/human, §7 O1)*

**P1 — launch-week**

Badges · repo description/topics · `.github` issue+PR templates · ~5–8 good-first-issues ·
tagged release · demo GIF · marketing `/privacy` page · "vs Cloudflare Web Analytics"
comparison · launch tweet/thread · PH gallery+first comment (if PH) · maker's FAQ prep ·
docs-link cleanup (remove stale "LICENSE in Phase 0" note).

**P2 — after**

"vs Plausible CE" + further comparison pages · docs microsite · blog system · public roadmap
page · changelog page · CODE_OF_CONDUCT · FUNDING.

---

## 7. Open questions / cross-lane flags

- **O1 — `npx skopia deploy` (tech-lead + human, blocks §2 H2 and the one-liner).** The site
  sells "one command" via a CLI that doesn't exist. **Recommendation: change all copy to "one
  click" (the real Deploy button)** rather than building a CLI to make a slogan true — the
  button is lower-friction and already works. If the tech-lead judges an `npx skopia deploy`
  wrapper trivial *and* better UX, that's a valid alternative — but it's a build decision, not
  a copy decision. **Do not launch with the claim unresolved.**
- **O2 — live demo standup (tech-lead, blocks P0 #3).** The demo is P0 and the links already
  point at it. It needs a stable public URL, a seeded/real-traffic site, and realtime enabled
  on a public token. Feasibility/effort is the tech-lead's call (the `/public/:token` path
  ships; public-live count is roadmap #7). **What it must show (PM):** real views only,
  realtime pulse, the honest metric set — no fabricated numbers.
- **O3 — TTFD is unmeasured (tech-lead/human, blocks P0 #5 and every time claim).** We cannot
  put a number on the deploy time until roadmap #9 runs on ≥3 clean accounts. Until then the
  headline is "in minutes," not "60 seconds."
- **O4 — repo/DNS gates (human/ops, blocks P0 #3, #6).** Confirm before launch: the repo is
  **public** at `github.com/jasonm4130/skopia` (the deploy-button URL 404s otherwise), and
  `app.skopia.dev` (+ `/login`) **resolves** (hero/CTA/footer/nav all link to it).
- **O5 — Product Hunt yes/no (human).** Determines whether the PH gallery/first-comment (P1)
  and tagline work is needed. Show HN + GitHub trending are the higher-fit channels for this
  audience; PH is optional upside.
- **O6 — screenshot data honesty (PM/human).** The demo/screenshot must use real or clearly
  realistic seeded data. If we seed, seed plausibly (no `48.2K/2m14s` theatrics) — the whole
  pitch is that our numbers are honest.

---

## Sources

**Repo state (read directly, 2026-07-05):** `analytics/README.md`, `dist/skopia.js`
(944 B raw / ≈570 B gzip), `analytics/CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`,
`docs/install.md`, `docs/privacy.md`, `.github/` (absent); `skopia-www/src/components/*`
(Hero, Features, HowItWorks, Pricing, Faq, ProductShot, Comparison, TrustStrip, Nav, Cta,
Footer), `skopia-www/src/pages/index.astro`.

**Specs/research:** `docs/specs/2026-07-03-feature-roadmap.md` (§1 honest-claim constraints
C1–C4; #9 TTFD; #10 comparison pages), `docs/research/2026-07-03-roadmap-inputs.md` (§4
mid-2026 competitive refresh, dated web citations), `docs/specs/2026-06-21-product-spec.md`
(thesis §1, personas §2, success metrics §5).

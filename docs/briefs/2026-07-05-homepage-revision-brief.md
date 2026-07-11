# Claude Design brief — skopia.dev homepage revision

**Date:** 2026-07-05 · **Repo:** `../skopia-www` (Astro static, Workers Static Assets)
**Parent spec:** `docs/specs/2026-07-05-launch-readiness-design.md` (Track C)
**Research basis:** `docs/research/2026-07-05-best-in-class-analytics-marketing.md`,
`docs/research/2026-07-05-launch-asset-inventory-pm.md`

## Job of the page

Convert a skeptical developer (Show HN / GitHub referral) in under 30 seconds:
what it is → see it live → deploy it to *their* Cloudflare account. Audience fact-checks
every claim; honesty is the conversion register, not a constraint on it.

## Positioning (locked)

- One-liner: **"Open-source, cookieless web analytics you deploy to your own Cloudflare
  account in minutes — no database to run, and every feature unlocked."**
- Wording rule: **"self-deployed on your own Cloudflare account"** — never plain
  "self-hosted" without that qualifier (HN litigates the definition).
- Register: PostHog-grade candor, zero snark. Concede tradeoffs in-place.

## Banned claims (every one currently on the page; all must go)

| Current claim | Location | Replace with |
|---|---|---|
| "1.9 KB" script (×4) | `Hero.astro:36`, `HowItWorks.astro:13`, `Features.astro:23`, `Faq.astro:19` | **"under 1 KB"** / exact **554 B gzipped** (we under-sell 3.4× today; re-verify against CI size report at design time) |
| `$ npx skopia deploy` terminal + "one command" | `Hero.astro:28`, `Cta.astro:12` | The real story: **one-click Deploy to Cloudflare button** (+ "or `wrangler deploy` if you prefer the CLI"). No fictional commands. |
| "~3M pageviews/mo free" | `HowItWorks.astro:19`, `Faq.astro:15`, `Pricing.astro:41` | Honest range: **"≈500k–1M pageviews/mo on Cloudflare's free tier"** (roadmap §O5; ceiling = DO 100k rows-written/day). Real cost math beats free-tier flexing — "100k requests free is an odd flex" was a live HN attack. |
| "Avg. time 2m14s" fabricated stat | `ProductShot.astro:37` | Remove; replace mock with **real dashboard screenshot** (honest data). No sessionization exists — never show a time-on-site metric. |
| CSV-import FAQ answer | `Faq.astro:23` | Remove (no importer exists). |
| "No consent banner needed" framing | `Hero.astro:7,14`, `Features.astro:20`, `Faq.astro:10,11`, `Footer.astro:33` | Mechanism register: **"No cookies. No fingerprinting. Nothing stored about a person — here's exactly what we keep"** → link `/data-policy`. Never "GDPR compliant" (the Umami lesson). |

## Section order (teardown-validated)

1. **Nav** — add **Docs** link (→ repo `docs/install.md` for now) and keep GitHub. Add
   **Live demo** once the share URL ships.
2. **Hero** — headline names the incumbent category ("…alternative"); sub = the locked
   one-liner. Primary CTA **"Deploy to Cloudflare"** (deep-link the README `#installation`
   anchor, Counterscale-style). Secondary CTA **"View live demo"** → public share
   dashboard of skopia.dev's own traffic (Track A; placeholder until shipped —
   do NOT link app.skopia.dev's login wall).
3. **TrustStrip** — only verifiable numbers: 554 B script, $0 software cost, 90-day+
   rollups retention story, AGPL open source.
4. **ProductShot** — real screenshot; caption it as skopia.dev's own data ("You're
   looking at this site's real traffic" once the demo ships).
5. **HowItWorks** — 3 steps around the button: click Deploy → four secrets (name them
   honestly; link install guide) → paste the snippet. Cite the **measured** deploy time
   once the clean-account run exists (Track D) — until then "minutes", never "60 seconds".
6. **Features** — linked claims (each → docs/README anchor). Include **honest metrics**
   as a feature: the dashboard tells you what it *can't* know (Count-column caveats).
7. **Comparison** — keep one table; the launch-critical column is
   **vs Cloudflare Web Analytics** (retention, custom events, multi-site, data ownership,
   UTM breakdowns). Punch up (GA, CF WA) — never sideways at Plausible/Umami.
8. **Pricing → rename "Cost"** — "Skopia is free. You just pay Cloudflare." + a small
   real-math table (free-tier range; the ~$5 Workers-paid step and what it buys). No
   tiers, no trials, no book-a-demo.
9. **FAQ** — add the two-sided pair: *"Isn't this just Cloudflare Web Analytics?"* and
   *"Why should I trust Cloudflare with my analytics?"* (answer: your account, your data,
   auditable AGPL code — and yes, a real dependency; owned tradeoff). Add *"What can't it
   tell me?"* (monthly uniques, cross-day journeys — daily salt) linking `/data-policy`.
   Remove CSV answer; reframe consent answers per banned-claims table.
10. **CTA** — Deploy button + demo link + GitHub. No fictional terminal.
11. **Footer** — add `/data-policy` link.

## Design constraints

- Tokens: `analytics/src/shared/tokens.css` is the source of truth, copied to
  `skopia-www/public/tokens.css` (ADR-0009) — design within the existing token palette.
- Static Astro, no client JS beyond what exists; page must stay fast (it advertises a
  554 B script — the marketing site being heavy is an attack surface).
- Keep components; this is a revision, not a rebuild — Hero, TrustStrip, ProductShot,
  HowItWorks, Features, Comparison, Pricing, Faq, Cta, Footer all survive with new
  content.

# Roadmap Inputs — Product Sweep (pre-feasibility)

- **Date:** 2026-07-03
- **Author:** `product-manager` agent
- **Purpose:** First-pass INPUTS for the next-quarter feature roadmap. Candidates, rationale,
  competitive context. **Prioritization is held loosely** — provisional P0/P1/P2 tiers here get
  re-ranked against the `cloudflare-tech-lead`'s parallel feasibility sweep in a second pass.
- **Scope discipline:** This is WHAT and WHY only. No architecture/technology calls (that's the
  tech lead's lane). Where effort clearly flips a ranking, it's flagged `⚠️E` for the tech lead.
- **Evidence base:** in-repo specs/plans/code (cited inline), the 2026-06-21 competitive research
  (`docs/research/2026-06-21-competitive-landscape.md`), and a fresh mid-2026 competitive refresh
  (web sources dated + linked in §4).

---

## 0. Executive summary

**The thesis (as already decided in the spec, restated — not invented):**
> *"Plausible's analytics without Plausible's ops. The first complete, polished web-analytics
> tool you deploy to your own Cloudflare account in ~60 seconds — no server, no database to run,
> no ClickHouse to babysit, a sub-2 KB script, and every feature unlocked."*
> (`docs/specs/2026-06-21-product-spec.md` §1). Moat = **zero-ops + finished + open**;
> cookieless privacy is table-stakes, not the whole moat; bot-signal fusion is explicitly NOT the
> moat (Enterprise-gated).

**The single most important finding of this sweep — a promise/reality gap, not a missing capability.**
The ingestion pipeline already collects **11 dimensions** (`src/dashboard/event-dimensions.ts`:
total, page, referrer, utm_source, utm_medium, utm_campaign, country, device, browser, os, event),
and the D1 read layer already has query functions for **all** of them
(`src/db/queries.ts`: `getTopDevices`, `getTopBrowsers`, `getTopOperatingSystems`,
`getTopUtmSources`, `getTopEvents`, `listGoals`). **But the dashboard only surfaces four views**
— Overview, Pages, Sources, Geography (`src/dashboard/index.ts` nav, lines ~357-360). Device /
browser / OS, UTM campaigns, and custom events/goals each have **zero UI call sites** (verified by
grep). They are collected and queryable but invisible. And there is **no site-management UI at
all** — `docs/install.md` §3-4 tells users to add sites and set origin allowlists via
`wrangler d1 execute` SQL.

So the cheapest, highest-integrity roadmap work is **not** net-new features — it's **surfacing
what we already collect** and **making self-host completable without a CLI**. Those close the gap
between the spec's stated MVP "IN scope" (`product-spec.md` §4: "device/browser/OS … **UTM** …
custom events/goals display … multi-site management") and what actually ships.

**Top candidate features (provisional tiers — see §6 for evidence + metrics):**

| Tier | Candidate | Why it's here |
|------|-----------|---------------|
| **P0** | Surface **device / browser / OS** breakdown | Collected, queryable, zero UI. Table-stakes everywhere. |
| **P0** | Surface **UTM campaign** breakdown | Headline MVP feature (spec §2/§3); collected, zero UI. |
| **P0** | Surface **custom events / goals** display | MVP-scoped; `track()` API ships data no one can see today. |
| **P0** | **Site-management UI** (add/edit site, allowlist, snippet) | Self-host isn't completable without dropping to `wrangler` SQL. Undercuts TTFD + Agency persona. |
| **P1** | **Funnels** (free funnel UI) | The decided marquee wedge (spec §4 v1.1); Plausible still gates it in CE (confirmed 2026). |
| **P1** | **Data export / ungated Stats API** | Anti-gating positioning; Fathom shipped rich export Jan 2026, Plausible gates its Stats API. |
| **P1** | Marketing **comparison pages** (`skopia-www`) | Thesis is comparative; CF's 2026 perf-pivot + 7-day-unsampled retention is fresh ammunition. |
| **P2** | Server-side / no-JS collection mode | Edge-native wedge; strict-German P2 closer (spec §4 v1.2). |
| **P2** | IP truncation + configurable retention | P2 compliance closer (CNIL 13-month). |
| **P2** | Landing/exit pages, custom date range, CWV | Floor-raisers (Fathom/Umami 2026); weigh against scope discipline. |

**Candidate milestone themes (next quarter):** (A) **Complete the dashboard** — surface the
hidden dimensions + ship site management; (B) **Earn the announcement** — clean-account TTFD
proof, positioning pages, honest-data polish; (C) **The wedge** — funnels + ungated export.
Rationale in §7.

**Confidence:** HIGH on the promise/reality gap (verified in code, not inferred). HIGH on the
thesis (already decided + still holds against the 2026 refresh). MEDIUM on tier ordering (pending
feasibility — several items are UI-only over an existing pipeline, which the tech lead should
confirm cheapens them decisively).

---

## 1. What actually ships today (ground truth from code, not the spec's word)

Read the pipeline and dashboard directly. Current shipped surface:

**Tracking script (`src/script/skopia.ts`, ~957 B minified — well under the 2 KB budget):**
pageviews on load, SPA route changes (history patch + popstate), `skopia.track(name, props)` /
`window.skopia('event', …)` custom events, `fetch`+`keepalive` transport. Cookieless (CI-audited).
No cookies/localStorage. ✅ Solid, on-thesis.

**Collector (`src/collector/index.ts`):** CORS/preflight, per-site validation + origin allowlist,
cookieless daily-salt HMAC identity, `request.cf` enrichment (country), UA-derived
device/browser/OS with screen-width tiebreak, UTM parse, custom-event props (capped 512 B), writes
to Analytics Engine and drives the SiteLive DO. Fail-closed on missing secrets (503). ✅

**Dashboard (`src/dashboard/index.ts`) — what a logged-in owner can actually see:**
- **Overview** (`/app`): 4 stat cards (Visitors, Pageviews, Views/Visitor, **Single-Page Visits**
  — honestly relabeled from "Bounce Rate"), a time-series chart with a **7d / 30d / 90d** range
  picker (presets only, no custom range), Top pages (5), Top sources (5), Top countries (5), live
  count via WebSocket.
- **Pages** (`/app/pages`): top-pages table.
- **Sources** (`/app/sources`): top-**referrer** table (Source, Visitors, Share). *Note: this is
  referrer host, **not** UTM — UTM is collected but not shown here or anywhere.*
- **Geography** (`/app/geography`): world map (self-hosted jsVectorMap) + top-countries list.
- **Real-time** (`/live`, `liveScript`): SiteLive Durable Object + WebSocket live visitor count. ✅
- **Public/shareable** (`/public/:token`): read-only per-site view (no auth). ✅ *But no live count
  on public views — `docs/plans/2026-06-21-mvp-followups.md` flags `/live` is auth-gated.*
- **Auth**: `/setup` (first-run owner password), `/login`, `/logout`. Single-owner. ✅
- Honest **sampling badge** threaded through the view models (`OverviewView.sampled`). ✅

**Deploy story:** one-click Deploy-to-Cloudflare button + `cloudflare.bindings` prompts for 4
secrets + cold-account hardening (fail-closed secret guard, lazy D1 schema bootstrap, self-hosted
fonts/vendor, CSP + security headers) — the `2026-06-21-harden-and-launch.md` sprint appears
shipped (its files exist: `src/shared/config.ts`, `schema.ts`, `security-headers.ts`,
`check-no-external` in the CI chain; README documents the real deploy walkthrough). ✅

**Collected but NOT surfaced (the gap):**

| Collected dimension | Query exists | UI call sites | Spec says it's… |
|---------------------|:---:|:---:|---|
| device / browser / os | ✅ `getTopDevices/Browsers/OperatingSystems` | **0** | MVP IN-scope (§4) |
| utm_source / medium / campaign | ✅ `getTopUtmSources` | **0** | MVP IN-scope, **headline** (§2/§3) |
| custom events (`event`) | ✅ `getTopEvents` | **0** | MVP IN-scope ("custom events display") |
| goals | ✅ `listGoals` | **0** | MVP IN-scope (§4.2) |

**Not built at all:**
- **Site-management UI.** Sites are added and allowlists set via `wrangler d1 execute` SQL
  (`docs/install.md` §3-4: *"there is no site-management UI in the MVP"*). The seeded `default` site
  ships with an **empty (open) allowlist** — accepts beacons from any origin (a footgun).
- Funnels, server-side/no-JS mode, data export/Stats API, custom date range, landing/exit pages,
  Core Web Vitals, scroll depth, IP-truncation/retention UI, email reports — all correctly OUT of
  MVP per the spec; candidates below.

**Open engineering items still in-flight (NOT roadmap material, flagged for the tech lead):**
- **Rollup→DO incremental counters migration** — mid-flight, cutover gated on a data-parity check
  ~2026-07-04 (per MEMORY + `docs/decisions/0010`). Committed work; spoken-for capacity.
- **Historical backfill.** `mvp-followups.md` notes the cron rolled up *only today + 2 prior days*
  (WAE rate-limit dodge). If that limitation survives the DO migration, a 90-day range on an
  established deploy would show gaps — a possible **honesty/correctness** issue given we sell on
  accuracy. **Flag for the tech lead** — do not assume; it may be resolved by the migration.

---

## 2. Personas + top unmet needs (given what actually ships)

Personas are unchanged from `product-spec.md` §2 (still valid). What's new is mapping each to the
**gap between their JTBD and the shipped surface**.

- **P1 — Indie Hacker Ivan (PRIMARY).** JTBD: "know if anyone's using my project and where they
  came from, no SaaS fee, no DB, no cookie banner." **Top unmet need:** he *can* see pageviews and
  referrers, but **not where his launch traffic came from by campaign (UTM)** and **not whether his
  `track()` events fire** — the two things a launch-day indie checks first. Also: **adding a second
  project means editing D1 by hand**, which breaks the "ship it and check stats" loop.
- **P2 — Privacy-Conscious SMB Dev Priya (PRIMARY).** JTBD: "accurate-enough, demonstrably
  compliant analytics I can defend to a DPO." **Top unmet need:** the privacy posture is strong
  (cookieless-by-architecture, zero third-party requests after the harden sprint), but she has **no
  UI to set IP-truncation / retention** for the strict CNIL/German bars, and **no server-side/no-JS
  mode** for the strictest case. Compliance story is *architecturally* there but not *operable*.
- **P3 — Agency Aisha (SECONDARY).** JTBD: "one deploy covering all client sites, hand each client
  a link, no per-site bill." **Top unmet need — acute:** multi-site works at the data layer (site
  switcher, `/public/:token`), but **onboarding each client site is a `wrangler d1 execute`
  command**. That is not an agency-grade workflow and directly blocks her core job. Site management
  is P3's make-or-break.
- **P4 — Product-Minded Maya (TERTIARY).** JTBD: "see where users drop off without paying for
  Plausible Business or standing up PostHog." **Top unmet need:** funnels (still the decided
  marquee fast-follow) — and, prerequisite to funnels being trustworthy, a **visible events view**
  so she can confirm the events a funnel is built from actually arrive.

**Cross-persona:** the deploy-to-first-data path (the headline TTFD < 10 min metric,
`product-spec.md` §5) currently ends at a dead-end — after deploy, the user must leave the
dashboard for a CLI to register their real site (the seeded one is `default` with an open
allowlist). **Site management is the missing last mile of the self-host promise for everyone.**

---

## 3. The differentiation thesis — what it implies we must ship vs must NOT ship

The thesis is **decided** (`product-spec.md` §1, `product-plan.md` §1). Restated and turned into a
build filter:

**Must ship (the thesis obligates these):**
- **Finished & polished core.** "First *complete, polished* CF-native tool" means the promised core
  metrics must actually be *visible*. Collected-but-hidden UTM/device/events **violate the "complete"
  claim** — closing that gap is thesis-mandated, not optional.
- **Self-host that's actually completable in the browser.** "Deploy in 60 seconds, every feature
  unlocked" is contradicted if adding your own site requires SQL. Site management is thesis-critical.
- **Zero feature-gating, openly.** Everything Plausible gates (funnels, Stats API, revenue) we ship
  free. This makes **funnels** and an **ungated export/Stats API** thesis-aligned wedge features.
- **Honest data.** Accuracy positioning means the sampling badge, honest labels, and (see §1)
  resolving any historical-backfill gap must hold.

**Must NOT ship (the thesis forbids, and the 2026 refresh reinforces):**
- **Session replay, heatmaps, A/B, e-commerce revenue.** The spec already cuts these
  (`product-spec.md` §3). The 2026 refresh shows Umami adding exactly these (v3.1 replay, v3.2
  heatmaps + revenue — §4). That is *their* bloat becoming *our* contrast. Recreating it would
  dissolve the "lean, finished, on-thesis" position. Hold the line.
- **Cross-site tracking / fingerprinting, multi-tenant SaaS billing, hosted control plane.** Fixed
  constraints (CLAUDE.md non-goals). Not relitigated.
- **Bot-signal fusion as a headline.** Enterprise-gated; already demoted to heuristics + a WAF
  recipe doc (research §"Most important correction").

---

## 4. Competitive refresh (mid-2026) — gaps & table-stakes only

Focused deltas since the 2026-06-21 research that move the bar for a self-hosted tool. Not a
re-research.

**Plausible (2026).** Funnels got *stronger* (strict-order funnels, in-settings funnel editing,
custom-property goal filters) and shared dashboards can now be locked to a filtered segment.
Crucially, **Community Edition still excludes funnels, e-commerce revenue, SSO, and the Sites API**,
and CE ships only **twice a year**. → *Implication:* our "free funnels + ungated API, shipped
continuously" wedge is intact and arguably sharper — the gating grievance is unchanged.
([Plausible changelog](https://plausible.io/changelog), [CE announcement](https://plausible.io/blog/community-edition))

**Umami (2026).** v3.1 added Web Vitals, Session Replay, and Boards (custom dashboards); **v3.2
added Heatmaps, session-replay controls, and revenue reports.** Umami (MIT, full self-host) is
climbing *up-market into PostHog territory.* → *Implication:* two-sided. (a) It **raises the floor**
on a couple of items — **Core Web Vitals** is now free-self-host table-stakes-adjacent, worth
weighing. (b) It **validates our contrast**: the OSS incumbent is bloating; "lean, finished,
zero-ops" is a cleaner story than ever. Do **not** chase replay/heatmaps.
([Umami releases](https://github.com/umami-software/umami/releases), [v3.1 review](https://gardinerbryant.com/umami-3-1-is-amazing/))

**Fathom (2026, SaaS-only, $15+/mo).** Shipped **enhanced data export** (Jan 2026: customizable
dimensions/metrics, one-click all-dashboard CSV zip), **search-term tracking** (Feb), **rebuilt
engine + landing/exit pages** (Mar), and **added bot detection** (Apr). → *Implication:* **landing/
exit pages** and **data export** are now expected in a polished tool; export doubly reinforces our
ungated-export wedge (Fathom is closed + paid).
([Fathom changelog](https://usefathom.com/changelog), [pricing](https://usefathom.com/pricing))

**PostHog (2026).** Free tier **unchanged at 1M events/mo** (Mixpanel, by contrast, cut its free
tier 20M→1M in late 2025). PostHog remains the full product-analytics suite (replay, flags,
experiments). → *Implication:* no change to our position — we are deliberately *not* the
product-analytics suite. PostHog is the "graduate to a heavier tool" endpoint, not our contest.
([PostHog pricing](https://posthog.com/pricing))

**GA4 (2026).** June 15 2026 consent split (`ad_storage` becomes sole authority for Google Ads
data), IP-address encryption, and beta natural-language ("why did mobile conversions drop") query
UX. → *Implication:* GA4 is getting **more** consent-entangled and AI-heavy, not less — reinforces
the cookieless/no-banner contrast for P2. Table-stakes for us, not a new bar.
([GA4 consent update](https://linkutm.com/blog/google-analytics-consent-mode-news), [Merkle: GA data controls](https://www.merkle.com/en/merkle-now/articles-blogs/2026/updates-to-google-analytics-data-controls.html))

**Cloudflare Web Analytics (2026) — our most direct competitor.** Confirmed: **unsampled beacon
data is retained only ~7 days, then aggregated to ~10%**; sampling is dynamic (0.0001–100%). CF is
pivoting Web Analytics into a **performance/RUM** platform (navigation-type reporting, network-path
insights, one-click EU-data exclusion). → *Implication:* **strong, fresh ammunition.** CF's own tool
(a) keeps *exact* data only 7 days vs our exact-at-most-volumes over 90 days, and (b) is doubling
down on *performance monitoring*, **not** marketing/traffic analytics (still no UTM, events, funnels,
or full retention). The gap the spec identified just widened. Update the earlier research's stale
"~6 months retention" figure to **7 days unsampled / then ~10% sampled.**
([CF Web Analytics changelog](https://developers.cloudflare.com/changelog/product/web-analytics/), [RUM navigation types](https://developers.cloudflare.com/changelog/post/2026-04-30-rum-navigation-types/), [The RUM Diaries](https://blog.cloudflare.com/the-rum-diaries-enabling-web-analytics-by-default/))

**Net read:** the thesis holds and is arguably stronger. The *floor* rose slightly (export, landing/
exit pages, and — from Umami — Core Web Vitals). The *ceiling* competitors are chasing (replay,
heatmaps, revenue) is exactly the bloat we should keep refusing.

---

## 5. (reserved — merged into §6)

---

## 6. Candidate feature list

Each candidate: **user problem · evidence · impact hypothesis · success metric · provisional
tier + one-line rationale.** Tiers are provisional pending the tech lead's feasibility pass; items
whose effort could flip the ranking carry `⚠️E`. RICE-style scoring is deferred to the second pass
(needs confirmed effort). Grouped by theme.

### Group A — Surface what we already collect (close the promise/reality gap)

**A1. Device / Browser / OS breakdown view**
- *Problem:* Owners can't see what devices/browsers their visitors use — a universal analytics
  expectation and part of the spec's MVP "IN scope."
- *Evidence:* Collected + queryable, **zero UI** (`getTopDevices/Browsers/OperatingSystems`, 0 call
  sites). Table-stakes across every competitor (research §2 Tier A). Spec §4 lists it IN-scope.
- *Impact hypothesis:* Removes a glaring "why is this missing?" gap; low effort (UI over existing
  queries) `⚠️E` (tech lead: confirm it's UI-only).
- *Success metric:* view is reachable and renders non-empty for any site with traffic; closes a
  spec-vs-shipped discrepancy (binary: promised MVP metric now visible).
- *Tier:* **P0** — cheapest possible "make the product match its own spec."

**A2. UTM campaign breakdown (source / medium / campaign)**
- *Problem:* An indie who tags a launch post with `?utm_campaign=…` cannot see campaign performance
  — despite UTM being a **headline** MVP feature.
- *Evidence:* Collected (`parseUtm`, three utm dimensions) + `getTopUtmSources` exists, **zero UI.**
  Spec §2/§3 call UTM a headline table-stakes item; research §2 Tier A.
- *Impact hypothesis:* Directly serves P1's launch-day job; converts already-collected data into a
  visible answer. Low effort (UI over existing queries) `⚠️E`.
- *Success metric:* UTM breakdown visible on the Sources view (or a Campaigns view); ≥1 non-empty
  UTM row renders for a site receiving tagged traffic.
- *Tier:* **P0** — headline MVP feature currently invisible.

**A3. Custom events / goals display**
- *Problem:* The `track()` API works and events are ingested, but there is **no way to see them** —
  the API produces write-only data.
- *Evidence:* `getTopEvents` + `listGoals` exist, **zero UI.** Custom events are "effectively
  table-stakes" (research §2 Tier B); spec §4 lists "custom events/goals display" IN-scope.
- *Impact hypothesis:* Unlocks P1/P4 value and is the **prerequisite for trustworthy funnels**
  (you must see events before you can build/verify a funnel on them). Low-med effort `⚠️E`.
- *Success metric:* an Events view lists event names with counts; goal definitions render;
  ≥X% of active deploys have fired ≥1 custom event *and can see it*.
- *Tier:* **P0** — write-only data is a broken promise; also unblocks the funnels wedge.

**A4. Live count on public/shareable dashboards**
- *Problem:* Public dashboards (an indie/agency deliverable) can't show the live count because
  `/live` is auth-gated.
- *Evidence:* `docs/plans/2026-06-21-mvp-followups.md` ("Public-dashboard live"). Public dashboards
  are a decided MVP feature (`product-spec.md` §3 note).
- *Impact hypothesis:* Makes the "build in public" share link feel live/impressive (P1) and a
  better client deliverable (P3). Low effort (token-scoped live path).
- *Success metric:* public link shows a live count; count of public links created per deploy > 0
  (the existing §5 metric) with live enabled.
- *Tier:* **P1** — small, on-persona polish; not blocking.

### Group B — Complete the self-host / adoption story

**B1. Site-management UI (add/edit/delete site, origin allowlist, get snippet)** ← *biggest gap*
- *Problem:* Self-host isn't completable in the browser — adding your real site (the seeded one is
  `default` with an **open** allowlist) requires `wrangler d1 execute` SQL. Breaks TTFD and blocks
  the Agency persona's core job.
- *Evidence:* `docs/install.md` §3-4 ("there is no site-management UI in the MVP"); no site CRUD
  routes exist (verified). Multi-site is spec §3 MVP-critical for P3; §5 tracks median
  sites-per-deploy > 1 as a success metric — **unmeasurable/unusable without this UI.**
- *Impact hypothesis:* Converts "deploy" into "deploy → add my site → see data" without leaving the
  browser; directly protects the TTFD < 10 min headline metric and unlocks P3. Med effort `⚠️E`.
- *Success metric:* a user adds a second site and sets an allowlist entirely in-dashboard; median
  sites-per-deploy > 1 becomes measurable; setup-failure rate < 10% (spec §5) holds on clean deploys.
- *Tier:* **P0** — the missing last mile of the self-host promise; make-or-break for P3.

**B2. In-dashboard install/snippet UX (copyable snippet with correct `data-endpoint` prefilled)**
- *Problem:* The install path has a documented footgun — `data-endpoint` defaults to `/e`
  *relative to the visited page*, so cross-origin installs silently fail unless the user reads the
  gotcha in `install.md`.
- *Evidence:* `docs/install.md` "The `data-endpoint` gotcha (read this)" — a whole section warning
  about a 404-on-`/e` failure mode. TTFD/setup-failure metrics (spec §5) are exposed to this.
- *Impact hypothesis:* Generating the exact snippet (with the deploy's own origin baked in) removes
  the #1 silent-failure setup path. Low effort; pairs naturally with B1.
- *Success metric:* copy-paste snippet from the dashboard "just works" cross-origin; drop in
  setup-failure issues referencing `/e` 404s.
- *Tier:* **P1** — directly serves the TTFD metric; strongest paired with B1.

**B3. Clean-account TTFD measurement run + instrumentation**
- *Problem:* The headline metric (TTFD < 10 min) is **defined but not yet measured** on a real
  clean account — the harden sprint explicitly handed this to the human.
- *Evidence:* `2026-06-21-harden-and-launch.md` "Definition of done → Handoff to human"; spec §5.
- *Impact hypothesis:* We can't defend "60-second self-host" publicly without a measured number;
  this de-risks the launch claim. Process/gate item, not a dashboard feature.
- *Success metric:* a measured median TTFD and setup-failure rate on ≥3 clean deploys.
- *Tier:* **P1** — launch-readiness gate; cheap but blocks the announcement's core claim.

### Group C — The decided wedge (differentiation punch)

**C1. Funnels (free funnel UI)**
- *Problem:* P4 needs conversion drop-off insight without paying for Plausible Business or standing
  up PostHog.
- *Evidence:* The **decided marquee fast-follow** (`product-plan.md` §4 v1.1; `product-spec.md` §3
  item 14). 2026 refresh confirms Plausible CE **still excludes funnels** (§4). Events already in
  the pipeline. Depends on A3 (events must be visible/trustworthy first).
- *Impact hypothesis:* The headline "the free funnel UI Plausible charges Business for" launch
  moment; strongest single wedge feature. Heavier effort (spec est ~2 wk) `⚠️E`.
- *Success metric:* % of active deploys that create ≥1 funnel within 30 days (spec §5).
- *Tier:* **P1** — the marquee wedge, but sequenced *after* the core is complete (A-group) so the
  "complete, polished" claim is true when funnels land on top of it.

**C2. Data export / ungated Stats API**
- *Problem:* Owners/agencies want their raw data out (client reports, archiving, own tooling) —
  the exact thing Plausible gates to Business and Fathom sells.
- *Evidence:* Anti-gating positioning (spec §3 item 16; research §2 Tier B — "gating these is
  exactly the OSS grievance we exploit"). 2026 refresh: Fathom shipped rich export Jan 2026, raising
  the bar; Plausible still gates its Stats API. Thin read layer over existing D1/WAE.
- *Impact hypothesis:* Reinforces the "every feature unlocked" wedge with a concrete, cited contrast;
  serves P3/P2. Low-med effort.
- *Success metric:* CSV export + a documented read endpoint exist and are ungated; export used on
  ≥X% of active deploys.
- *Tier:* **P1** — cheap, on-thesis, and freshly differentiated by Fathom/Plausible gating.

**C3. Server-side / no-JS collection mode**
- *Problem:* The strictest German (TDDDG §25) pure-server-side bar and ad-blocked audiences need a
  no-JS path.
- *Evidence:* Decided fast-follow (`product-plan.md` §4 v1.2; spec §3 item 15). Edge-native wedge
  (research §4 pillar 4). Effort uncertain `⚠️E` (proxy/header ergonomics).
- *Impact hypothesis:* Closes P2's strictest compliance case and is a genuinely edge-native story no
  SaaS can match. Real but narrower reach than A/B/C1.
- *Success metric:* a documented no-JS collection path works end-to-end; adopted by ≥1 P2-type deploy.
- *Tier:* **P2** — genuine wedge, but narrower; sequence after funnels/export.

### Group D — Floor-raisers & compliance (weigh against scope discipline)

**D1. Configurable retention + last-byte IP truncation UI**
- *Problem:* P2 can't operably meet CNIL Sheet 16 (IP truncation + 13-month cap) / German bars from
  the dashboard.
- *Evidence:* Spec §3 item 19 (fast-follow); research §3 (CNIL/TDDDG). Currently a "sane default"
  with no UI.
- *Impact hypothesis:* Turns the *architectural* compliance story into an *operable* one Priya can
  show a DPO. Med effort (retention beyond 90 days ties to the R2/archival question) `⚠️E`.
- *Success metric:* owner can set IP-truncation + retention in-dashboard; a P2-type deploy cites it
  in a compliance sign-off.
- *Tier:* **P2** — real for P2, but check the retention-window feasibility with the tech lead first.

**D2. Landing / exit pages**
- *Problem:* Owners want to know where visitors enter and leave — a standard "top pages" companion.
- *Evidence:* Fathom shipped this Mar 2026 (§4), making it an expected polish item; natural
  extension of the existing top-pages rollup.
- *Impact hypothesis:* Modest polish that closes a visible gap vs Fathom/Plausible. Effort depends
  on whether entry/exit is derivable from the current rollup `⚠️E`.
- *Success metric:* landing + exit page lists render for a site with multi-page sessions.
- *Tier:* **P2** — nice floor-raiser; not thesis-critical.

**D3. Custom date range picker**
- *Problem:* Only 7d/30d/90d presets; users expect arbitrary ranges (and month/quarter compares).
- *Evidence:* `src/dashboard/index.ts` range picker is preset-only; universal expectation.
- *Impact hypothesis:* Small UX completeness win. Low effort.
- *Success metric:* arbitrary from/to range renders correctly.
- *Tier:* **P2** — low-cost completeness; bundle with A-group dashboard work.

**D4. Core Web Vitals (LCP/INP/CLS)**
- *Problem:* Performance-conscious owners increasingly expect CWV in an analytics tool.
- *Evidence:* Umami self-host free added CWV in v3.1 (§4), raising the floor; but CF is *also*
  pivoting its free tool to performance/RUM (§4) — so this is the one place a competitor's free
  product overlaps us. Spec had CWV as a later fast-follow (§3 item 18).
- *Impact hypothesis:* Uncertain — could be scope creep toward the "monitoring" lane CF owns, or a
  cheap floor-match. **Deliberately held as P2/consider**, not endorsed, pending a thesis check.
- *Success metric:* (if pursued) CWV percentiles render per page.
- *Tier:* **P2 (consider)** — flag the thesis tension: don't drift into CF's performance-monitoring
  lane. Recommend *not* prioritizing over A/B/C.

### Group E — Positioning / launch assets (not dashboard features)

**E1. Marketing comparison pages on `skopia-www` ("vs Plausible CE", "vs Cloudflare Web Analytics")**
- *Problem:* The thesis is inherently comparative ("Plausible's analytics without Plausible's ops"),
  but a prospect has nowhere to see the contrast made legible.
- *Evidence:* Thesis is comparative by construction (spec §1). Fresh 2026 ammunition: CF WA keeps
  exact data only ~7 days and is pivoting to performance (§4); Plausible CE still gates funnels/API
  and ships twice a year (§4). `skopia-www` is the owned surface for this (CLAUDE.md).
- *Impact hypothesis:* Converts differentiation into acquisition; supports the GitHub-stars and
  deploys success metrics (spec §5). Marketing-repo work (PM ask, not product-Worker code).
- *Success metric:* comparison pages live; referral/deploy attribution where measurable without
  tracking users.
- *Tier:* **P1/P2** — high leverage for adoption, low product-eng cost; sequence with the launch.

### Explicitly NOT candidates (hold the line — thesis + fixed constraints)

Session replay, heatmaps, A/B testing, e-commerce/revenue (Umami is adding these — that's *their*
bloat, our contrast, §3/§4); cross-site tracking/fingerprinting; multi-tenant SaaS billing / hosted
control plane; paid Bot Management integration. All previously cut (`product-spec.md` §3); the 2026
refresh strengthens the case to keep them cut.

---

## 7. Candidate milestone themes (next quarter)

Three sharp themes, sequenced. Each is a defensible announcement.

**Theme A — "Complete the dashboard" (make the product match its own spec).**
Ship A1 (device/browser/OS), A2 (UTM), A3 (events/goals) + B1 (site-management UI) + B2 (snippet
UX). *Why first:* it's mostly UI over an **already-built pipeline** (likely cheapest work with the
highest integrity payoff), it makes the spec's own "MVP IN-scope" true, and it removes the
self-host dead-end. **You cannot credibly announce anything while headline MVP metrics are
invisible and adding a site needs SQL.** Success: every collected dimension is visible; a stranger
adds a site without a CLI; median sites-per-deploy becomes measurable.

**Theme B — "Earn the announcement" (launch readiness).**
B3 (clean-account TTFD measurement), E1 (comparison pages), A4 (public-dashboard live), honest-data
polish (confirm no historical-backfill gap survives the DO migration — §1 flag). *Why second:*
turns "complete" into "provable and positioned." Success: a measured TTFD we can quote; live
comparison pages; the differentiation is legible to a first-time visitor.

**Theme C — "The wedge" (differentiation headline).**
C1 (funnels — marquee) + C2 (ungated export/Stats API), then C3 (server-side/no-JS) as it lands.
*Why third:* the wedge hits hardest when it lands on a **complete, polished, provable** base — "the
free funnel UI Plausible charges Business for, on a tool you deployed in 10 minutes and can export
freely." Success: % of deploys creating a funnel within 30 days; export in use.

*Sequencing logic:* A unblocks C1 (events must be visible before funnels are trustworthy) and makes
B honest; B makes C's announcement land. The order is dependency-driven, not just priority-driven.

---

## 8. Open questions / flags for the tech lead (second-pass inputs)

1. **Are A1/A2/A3 truly UI-only** over the existing queries, or is there rollup/schema work? This
   decides whether "close the gap" is a cheap sprint or not (it flips the whole tier order).
2. **Site-management UI (B1) effort** — is site CRUD + allowlist edit in-dashboard small or medium?
   It's P0 by value; effort sets how much else fits this quarter.
3. **Historical backfill / retention (§1 flag):** does the DO-counters migration resolve the
   "only today + 2 prior days rolled up" limitation? If not, a 90-day range shows gaps — an
   accuracy/honesty issue that would jump up the priority list.
4. **Funnels (C1) effort** on the current event pipeline — spec assumed ~2 wk; confirm.
5. **Configurable retention beyond 90 days (D1)** — is there a cheap path to ~13-month retention
   (CNIL cap) short of the full R2/archival build? If yes, D1 reprioritizes up for P2.
6. **Server-side/no-JS (C3) effort** — the `⚠️E` proxy/header ergonomics estimate.

---

## Sources

**In-repo:** `docs/specs/2026-06-21-product-spec.md`, `docs/specs/2026-06-21-product-plan.md`,
`docs/research/2026-06-21-competitive-landscape.md`, `docs/plans/2026-06-21-harden-and-launch.md`,
`docs/plans/2026-06-21-mvp-followups.md`, `docs/install.md`, `README.md`, and code:
`src/script/skopia.ts`, `src/collector/index.ts`, `src/dashboard/index.ts`, `src/db/queries.ts`,
`src/dashboard/event-dimensions.ts`.

**Web (mid-2026 refresh, dated in §4):**
[Plausible changelog](https://plausible.io/changelog) ·
[Plausible CE](https://plausible.io/blog/community-edition) ·
[Umami releases](https://github.com/umami-software/umami/releases) ·
[Umami v3.1 review](https://gardinerbryant.com/umami-3-1-is-amazing/) ·
[Fathom changelog](https://usefathom.com/changelog) ·
[Fathom pricing](https://usefathom.com/pricing) ·
[PostHog pricing](https://posthog.com/pricing) ·
[GA4 consent update](https://linkutm.com/blog/google-analytics-consent-mode-news) ·
[Merkle: GA data controls](https://www.merkle.com/en/merkle-now/articles-blogs/2026/updates-to-google-analytics-data-controls.html) ·
[CF Web Analytics changelog](https://developers.cloudflare.com/changelog/product/web-analytics/) ·
[CF RUM navigation types](https://developers.cloudflare.com/changelog/post/2026-04-30-rum-navigation-types/) ·
[CF: The RUM Diaries](https://blog.cloudflare.com/the-rum-diaries-enabling-web-analytics-by-default/)
</content>
</invoke>

# Skopia — Product Spec

- **Date:** 2026-06-21
- **Author:** `product-manager` agent
- **Status:** Draft for human approval, then tech-lead effort review
- **Evidence base:** `docs/research/2026-06-21-competitive-landscape.md` (primary),
  `docs/research/2026-06-21-cloudflare-architecture.md` (feasibility). Both **medium**
  reliability overall; ⚠️ flags from those reports are honored here — corrected/weak figures
  are not quoted as fact.
- **Fixed constraints (not relitigated):** OSS, self-host on the user's own Cloudflare
  account, single-owner per deploy, no multi-tenant SaaS billing / hosted control plane,
  cookieless-by-architecture default, one-click deploy is first-class.

---

## 1. Differentiation thesis

> **"Plausible's analytics without Plausible's ops. The first complete, polished web-analytics
> tool you deploy to your own Cloudflare account in 60 seconds — no server, no database to
> run, no ClickHouse to babysit, a sub-2 KB script, and every feature unlocked."**

**Who we beat and how:**

- **vs Plausible CE / Umami / Matomo (self-hosted OSS):** they make *you* run the database.
  Plausible CE's ClickHouse is extensively documented crash-looping VPSs (disk exhaustion,
  OOM, CPU); Matomo is PHP+MySQL+Redis; Umami is Node+Postgres. **Ops burden is the #1 churn
  driver in self-hosted analytics, and the Workers + Analytics Engine backbone eliminates the
  server class entirely** (competitive report §4, pillar 1, well-supported ✅). We win on
  *zero-ops* and *zero-feature-gating* — Plausible CE deliberately withholds funnels/SSO/
  revenue/Stats-API; we ship them all open (the #1 OSS grievance, §1).
- **vs Plausible / Fathom (privacy SaaS):** same cookieless-no-banner privacy posture and a
  comparably tiny script, but **self-hosted on infrastructure you already own, at ~$0–5/mo for
  most sites** (architecture §4) instead of $9–15/mo with your data on a vendor's box.
- **vs GA4:** cookieless (no consent banner), sub-2 KB vs a heavy script, your data stays in
  your account, no surveillance funding. Table-stakes for this segment.
- **vs Cloudflare's own Web Analytics:** CF's free product **10% samples, caps lists at 15
  items, and has no UTM / no custom events / no funnels / no live view** (§1, verified ✅).
  We are the full-featured tool for people who outgrew it but want to stay on Cloudflare.
- **vs existing CF-native OSS (Counterscale, EdgeStat, et al.):** they **prove the
  architecture but are MVP-level** — no rich funnels, unpolished dashboards, weak bot handling
  (§4). **The open gap is a complete, polished, full-featured CF-native OSS tool.** That is
  the product. First-mover on *finished*, not first-mover on *exists*.

**Confidence:** HIGH on the zero-ops pillar (well-supported, multiple independent sources).
MEDIUM on cost magnitude — claim "dramatically cheaper at mid-traffic," **not** a precise
multiple (the "10–50×" ratio was loosely derived, §4 ⚠️). Cookieless privacy is **necessary
but not sufficient** — everyone in the privacy segment has it; it is table-stakes, not the moat.

**Explicitly NOT the moat:** Cloudflare bot-score / WAF-signal fusion. Granular Bot Management
scores are Enterprise-only and unavailable on the Free/Pro/Business/Workers-Paid plans our
self-hosters use (top correction, both reports). Bot handling is a **nice-to-have**: free-tier
heuristics (UA blocklists, datacenter-ASN detection, `verifiedBot` where available) + a
documented "put it behind Cloudflare WAF" recipe.

---

## 2. Target personas + Jobs-To-Be-Done

Four personas, ranked by how central they are to the wedge. Reach estimates feed §3.

### P1 — "Indie Hacker Ivan" (PRIMARY)
- **Who:** Solo developer / small-team founder running 1–10 side projects and SaaS apps, already
  on Cloudflare (Pages/Workers), traffic from a few hundred to ~1M views/mo.
- **JTBD:** *"When I ship a project, I want to know if anyone's using it and where they came
  from, without paying a monthly SaaS fee, running a database, or bolting a cookie banner onto
  my landing page."*
- **Why Skopia wins:** One-click deploy to an account he already has; $0 on free tier;
  no ops; cookieless = no banner; **public/shareable dashboard** to "build in public."
  This persona is the wedge — he feels the ops pain *and* the SaaS-fee pain.

### P2 — "Privacy-Conscious SMB Dev Priya" (PRIMARY)
- **Who:** Developer or technical lead at a small EU/UK business or agency-built site that must
  be GDPR/ePrivacy-clean and wants to drop GA4.
- **JTBD:** *"When the business asks for traffic numbers, I need accurate-enough analytics that
  are demonstrably compliant (no consent banner, data not shipped to a US ad vendor) and that I
  can stand behind to a DPO."*
- **Why Skopia wins:** Cookieless-by-architecture (no client storage at all → ePrivacy Art.
  5(3) doesn't trigger, §3 ✅); optional last-byte IP truncation + configurable retention to
  clear CNIL Sheet 16 and German TDDDG §25 bars; data lives in the org's own Cloudflare account.
  The **server-side / no-JS collection mode** (fast-follow) is the closer for the strictest
  German pure-server-side requirement.

### P3 — "Agency Aisha" (SECONDARY)
- **Who:** Small web/dev agency running analytics across many client sites.
- **JTBD:** *"I want one analytics deploy that covers all my clients' sites, that I can hand a
  client a link to, and that doesn't add a per-site SaaS bill or a server I have to maintain."*
- **Why Skopia wins:** **Multi-site** in one deploy; per-site public/shareable dashboards as a
  client deliverable; flat near-zero infra cost regardless of client count (no per-site SaaS
  pricing). Multi-site is therefore MVP-critical, not optional.

### P4 — "Product-Minded Maya" (TERTIARY / fast-follow demand)
- **Who:** Founder/PM who needs conversion insight, not just traffic counts.
- **JTBD:** *"I want to see where users drop off in signup/checkout without paying for Plausible
  Business or standing up PostHog."*
- **Why Skopia wins:** **Free funnel UI** — funnels are the single most-requested feature
  beyond core and are gated to Plausible Business / a Matomo paid plugin and absent in
  Fathom/Umami-UI/GoatCounter (§2 Tier C). A free, polished funnel builder is a real wedge.
  This persona justifies funnels as the **marquee fast-follow**, not MVP (see §3 rationale).

---

## 3. Prioritized feature roadmap (RICE)

**Method:** RICE = (Reach × Impact × Confidence) / Effort. Reach = relative share of our four
personas served (1–10). Impact = value to the thesis/persona (3=massive, 2=high, 1=medium,
0.5=low). Confidence = our certainty in the estimate (1.0/0.8/0.5). **Effort is provisional —
the tech lead must confirm; items where effort flips the ranking are flagged ⚠️E.** Effort in
person-weeks (lower = cheaper). Scores are relative, for ordering, not absolute truth.

| # | Feature | Persona | R | I | C | E | RICE | Tier |
|---|---------|---------|---|---|---|---|------|------|
| 1 | Pageviews / unique visitors / top pages | all | 10 | 3 | 1.0 | 1 | **30.0** | MVP |
| 2 | Referrers / sources + **UTM campaign tracking** | all | 10 | 3 | 1.0 | 1 | **30.0** | MVP |
| 3 | One-click "Deploy to Cloudflare" + auto bindings | all | 10 | 3 | 0.8 | 1 | **24.0** | MVP |
| 4 | Cookieless daily-salt identity (no banner) | all | 10 | 3 | 1.0 | 1.5 | **20.0** | MVP |
| 5 | <2 KB script (fetch+keepalive, SPA, visibilitychange) | all | 10 | 2 | 1.0 | 1 | **20.0** | MVP |
| 6 | Device / browser / OS / country geo | all | 10 | 2 | 1.0 | 1 | **20.0** | MVP |
| 7 | Time-series + date-range picker | all | 10 | 2 | 1.0 | 1 | **20.0** | MVP |
| 8 | **Multi-site** in one deploy | P3, P1 | 9 | 3 | 0.8 | 1.5 | **14.4** | MVP |
| 9 | **Custom events / goals** (`track(name, props)`) | P1, P4 | 8 | 2 | 0.8 | 1.5 | **8.5** | MVP |
| 10 | Real-time / live-visitor view | P1, P3 | 8 | 2 | 0.8 | 2 ⚠️E | **6.4** | MVP |
| 11 | Single-owner auth (dashboard login) | all | 10 | 3 | 0.8 | 1 | **24.0** | MVP |
| 12 | **Public / shareable dashboards** | P1, P3 | 8 | 2 | 0.8 | 1 | **12.8** | MVP |
| 13 | Outbound-link & file-download tracking | P1, P4 | 7 | 1 | 0.8 | 1 | **5.6** | Fast-follow |
| 14 | **Funnels** (free funnel UI) | P4, P1 | 6 | 3 | 0.5 | 3 ⚠️E | **3.0** | Fast-follow |
| 15 | **Server-side / no-JS collection mode** | P2, P1 | 6 | 2 | 0.5 | 2.5 ⚠️E | **2.4** | Fast-follow |
| 16 | Data export / REST Stats API (ungated) | P3, P2 | 6 | 2 | 0.8 | 1.5 | **6.4** | Fast-follow |
| 17 | Scroll depth | P1, P4 | 6 | 1 | 0.8 | 1 | **4.8** | Fast-follow |
| 18 | Core Web Vitals | P2, P1 | 6 | 1 | 0.8 | 1.5 | **3.2** | Fast-follow |
| 19 | Last-byte IP truncation + configurable retention | P2 | 5 | 2 | 0.8 | 1 | **8.0** | Fast-follow |
| 20 | Email reports (scheduled) | P3, P2 | 5 | 1 | 0.8 | 1.5 | **2.7** | Later |
| 21 | R2 archival beyond 90-day WAE window | P2, P3 | 4 | 1 | 0.5 | 3 ⚠️E | **0.7** | Later |
| 22 | Custom dimensions / properties | P4 | 4 | 1 | 0.5 | 2 | **1.0** | Later |
| 23 | Heuristic bot filtering + WAF recipe doc | all | 7 | 1 | 0.8 | 1 | **5.6** | Fast-follow |
| 24 | Cohorts / retention | P4 | 3 | 1 | 0.5 | 3 | **0.5** | Later |
| 25 | Session replay | P4 | 3 | 1 | 0.5 | 5 | **0.3** | Won't-do (v1) |
| 26 | Heatmaps | P4 | 2 | 1 | 0.5 | 5 | **0.2** | Won't-do (v1) |
| 27 | A/B testing | P4 | 2 | 1 | 0.5 | 4 | **0.25** | Won't-do (v1) |
| 28 | E-commerce / revenue tracking | P4 | 2 | 1 | 0.5 | 4 | **0.25** | Won't-do (v1) |
| 29 | Multi-tenant SaaS billing / hosted control plane | — | — | — | — | — | **CUT** | Won't-do (fixed constraint) |
| 30 | Cross-site user tracking / fingerprinting | — | — | — | — | — | **CUT** | Won't-do (voids privacy thesis) |

### Decisions on the explicitly contested items

- **Custom events → MVP (IN).** Research moved these from "nice" to **effectively
  table-stakes**; the API is near-identical across tools (`track('name', {props})`, §2 Tier B).
  P1 and P4 both expect them. The walking skeleton ingests events generically, so events are
  cheap incremental work over pageviews (they *are* pageviews with a name + props). RICE 8.5,
  above the MVP cut line. Confidence MEDIUM (effort assumes generic event schema from day one).
- **Public / shareable dashboards → MVP (IN).** Cheap to build, disproportionately loved by the
  indie/build-in-public persona (P1) and a concrete agency deliverable (P3) (§2 Tier B). It is
  also *anti-Plausible-CE positioning* (a free, open feature where competitors gate). RICE 12.8.
  Confidence MEDIUM — depends on the dashboard already supporting per-site read-only views,
  which the architecture supports cheaply. **This is a deliberate non-obvious inclusion:** it
  earns its MVP slot because it is low-effort *and* directly serves the primary persona's job.
- **Funnels → Fast-follow (OUT of MVP).** Funnels are the strongest single *wedge* feature
  (most-requested-beyond-core, gated everywhere, §2 Tier C) and the reason P4 exists — but they
  are Tier C, the heaviest MVP candidate (E≈3, ⚠️E), and depend on a solid event pipeline that
  MVP establishes. The thesis is "**complete, polished, full-featured**," and the fastest path
  to *polished* is to nail the core beautifully first, then ship funnels as the **marquee v1.x
  launch feature** ("the free funnel UI Plausible charges Business for"). RICE 3.0 keeps it
  below the MVP line; its strategic weight makes it the **#1 fast-follow**, not "later."
- **Server-side / no-JS collection mode → Fast-follow (OUT of MVP).** A genuine edge-native
  wedge and the closer for P2's strictest (German pure-server-side) bar (§2 Tier C, §4 pillar
  4). But the MVP walking skeleton is the `<script>` path; no-JS is a *second* ingestion mode
  layered on the same collector. Effort uncertain (⚠️E — proxy/header-injection ergonomics).
  Ship right after funnels. RICE 2.4.

**Won't-do (v1) rationale:** session replay, heatmaps, A/B testing, e-commerce are the heavy
"upgrade reasons" for PostHog/Matomo (§2 Tier C). They are bloat relative to our thesis, costly,
and several are privacy-fraught (session replay). The competitor's bloat is our opportunity —
we do **not** recreate it. Multi-tenant SaaS and cross-site tracking are cut by fixed
constraint / thesis violation.

---

## 4. MVP definition

**The smallest thing worth deploying:** a self-hoster runs one deploy, drops a sub-2 KB script
on their site(s), and within minutes sees real-time and historical pageviews, visitors,
sources (with UTM), top pages, geo, and devices — across multiple sites, on a dashboard only
they can see, with a per-site public link they can share, with zero server or database to run
and no cookie banner.

### Walking skeleton (must work end-to-end)
```
<2 KB script  →  collector Worker  →  event store  →  dashboard shows core metrics
   (P1/P2's      (validate, CORS,      (raw events)     (auth'd owner view +
    site)         cookieless hash,                       per-site public view)
                  request.cf enrich)
```
A pageview fired by the script must land, be counted cookielessly, and appear (real-time and in
the time-series) on the owner's dashboard. That loop closing = MVP heartbeat.

### IN scope (MVP)
- Sub-2 KB gzipped tracking script: pageviews, SPA route changes, custom events
  (`track(name, props)`); `fetch`+`keepalive`, fired on `visibilitychange`.
- Collector Worker: CORS/preflight, per-site validation, cookieless daily-salt identity, free
  `request.cf` enrichment (country/device-class via UA), basic heuristic bot drop (UA blocklist).
- Core metrics dashboard: pageviews, unique visitors, top pages, referrers/sources, **UTM**,
  device/browser/OS, country geo, time-series with date-range picker, **real-time live view**.
- **Multi-site** management in one deploy.
- **Custom events / goals** display.
- Single-owner **auth** for the dashboard.
- **Public / shareable per-site dashboard** (read-only link).
- **One-click "Deploy to Cloudflare"** with auto-provisioned bindings + a setup README that
  documents the one or two manual steps the deploy button can't do (e.g. auth policy,
  custom-domain routing — confirm with tech lead, §4 architecture ⚠️).
- Honest data presentation: a visible note when figures may be sampled (see §7 Q1).

### OUT of scope (MVP — be ruthless, YAGNI)
- Funnels, server-side/no-JS mode, REST Stats API, data export.
- Scroll depth, Core Web Vitals, outbound-link/file-download tracking.
- Email reports, R2 archival (MVP lives within the 90-day WAE window — see §7 Q3).
- Custom dimensions, cohorts/retention, session replay, heatmaps, A/B, e-commerce.
- Configurable retention / IP truncation UI (fast-follow; MVP ships a sane privacy default).
- Paid Bot Management integration (Enterprise-gated; heuristics + WAF doc only).
- Anything multi-tenant / billing / hosted.

**Confidence in MVP scope:** HIGH on the core-metrics + deploy + cookieless set (table-stakes,
well-supported). MEDIUM on multi-site, public dashboards, and real-time all landing in MVP
without effort blowup — these are the items most likely to slip to fast-follow if the tech lead
flags effort (⚠️E on real-time #10). If something must be cut to ship, cut in this order:
real-time → public dashboards → custom events. Multi-site stays (P3 depends on it).

---

## 5. Success metrics

**Product-level (first 6 months post-launch):**
- **GitHub stars:** ≥ 2,000 (Counterscale, the incumbent CF-native, is ~2.1k★ — beating it
  signals we won the "complete CF-native" position). Stretch: 5,000.
- **Deploys:** ≥ 500 successful one-click deploys (instrument the deploy flow / template repo
  traffic where possible without tracking users).
- **Time-to-first-data (TTFD):** median **< 10 minutes** from clicking "Deploy" to seeing the
  first pageview on the dashboard. This is the headline UX metric — it operationalizes "60
  seconds to self-host." Target the deploy+config path, measure via setup docs funnel + issues.
- **Setup-failure rate:** < 10% of deploys generate a "couldn't get it working" issue.
- **Script size:** stays < 2 KB gzipped (CI budget; regressions are bugs, per CLAUDE.md).

**Per major feature:**
- *One-click deploy:* % of deploys needing zero manual GitHub-issue help; TTFD median.
- *Cookieless identity:* zero cookies/localStorage set (automated audit in CI); daily-unique
  counts within sane bounds vs raw event counts.
- *Multi-site:* median sites-per-deploy among active installs > 1 (proves P3 value).
- *Public dashboards:* count of public links created per active deploy (proves P1/P3 demand).
- *Real-time:* live-view used in ≥ 30% of dashboard sessions (else reconsider its MVP slot).
- *Funnels (v1.x):* % of active deploys that create ≥ 1 funnel within 30 days (proves the wedge).

---

## 6. Recommended license: **AGPL-3.0**

**Recommendation: AGPL-3.0** (with a CLA optional, tech-lead/legal call).

Our entire pitch is **"every feature unlocked, no feature-gating"** — that is the wedge against
Plausible CE. AGPL is the license that lets us keep that promise *and* protect it: anyone can
self-host and modify freely, but a competitor who runs a modified Skopia as a hosted SaaS must
release their changes. That blocks the failure mode where a closed-source SaaS forks our work,
adds the polish, and out-markets us while contributing nothing back — exactly the dynamic that
pushed Plausible itself to AGPL. MIT (Umami's choice) maximizes raw adoption but invites that
closed fork, and since we are *not* running a hosted offering, we don't need MIT's permissiveness
to enable our own SaaS. AGPL costs us a sliver of enterprise adoption (some legal departments
ban AGPL) — acceptable, because our target personas (indie, SMB dev, agency) self-host on their
own account, which AGPL fully permits. **Confidence: MEDIUM-HIGH** — Plausible's AGPL precedent
in this exact market is strong evidence; the only real downside is enterprise legal aversion,
which our personas largely sidestep.

---

## 7. Open tradeoffs / questions for the tech lead + human

**For the tech lead (effort/feasibility that affects my prioritization):**

1. **WAE sampling honesty (REQUIRED before launch — product is sold on accuracy).** WAE
   adaptive-samples at high volume; queries must correct via `_sample_interval`, and Cloudflare
   itself warns `_sample_interval` alone doesn't confirm accuracy (architecture §1 ⚠️).
   **My product requirement:** never silently show a sampled number as if exact. Acceptable
   approaches, your call on which is cheapest: (a) a per-metric "~ estimated" badge with a
   tooltip when the underlying query was sampled, driven by a row-`count()` validation check;
   (b) Cron-built rollups into D1 that are exact at the volumes most self-hosters run, with the
   badge only appearing above the sampling onset (~order-of-magnitude 100 dp/s/index). I lean
   (b) — most of our personas (P1/P2/P3) run well below the sampling threshold, so honesty
   costs us nothing for them and we only caveat the heavy-traffic minority. **Need:** is the
   rollup-validation check cheap enough to run per dashboard load / per Cron pass?

2. **90-day retention for MVP — acceptable?** WAE retention is a hard 3-month window
   (architecture §1). **My position:** **yes, 90 days is acceptable for MVP.** It covers the
   indie/SMB/agency "how's traffic this quarter" job; R2 archival (item #21) is heavy
   (⚠️E≈3), low RICE (0.7), and serves a minority. Ship MVP at 90 days, document the limit
   honestly, and treat R2 archival as a *Later* opt-in for the few who need year-over-year.
   **Need from you:** confirm there's no cheap way to get, say, 13-month retention (which would
   clear CNIL Sheet 16's cap) without the full Pipelines→R2→Iceberg path — if there is, item
   #19/#21 reprioritize upward for P2.

3. **Effort confirmation on ⚠️E items** — these flip rankings: real-time live view (#10,
   Durable Object), funnels (#14), server-side/no-JS mode (#15), R2 archival (#21). If
   real-time is materially more than ~2 weeks, it drops out of MVP to fast-follow. If funnels
   are cheaper than I've assumed (event pipeline already in MVP), they could pull into a faster
   v1.0.x. Give me effort estimates and I'll re-rank.

4. **Queues in or out of the default path?** Architecture leans *out* for cost/simplicity
   (direct WAE write). I have no product reason to require Queues for MVP — your call, but my
   prioritization assumes the simpler, cheaper direct-write path so the free tier covers more.

5. **Auth approach (Cloudflare Access vs self-rolled).** This affects the one-click-deploy
   promise: Access adds a manual setup step the deploy button can't provision (§4 ⚠️), which
   hurts TTFD; self-rolled is fully one-click-deployable but is auth code we own and must
   secure. **My requirement is the product outcome, not the mechanism:** the owner must be able
   to log in within the < 10-min TTFD target without a confusing Zero-Trust detour. Pick the
   path that best protects TTFD; if Access wins on security but costs setup steps, document
   them crisply in the deploy README.

**For the human (decisions above the agents' pay grade):**

6. **License sign-off:** AGPL-3.0 recommended (§6). Confirm, and decide CLA yes/no.
7. **Name:** "Skopia" is provisional (CLAUDE.md). Confirm or flag a trademark/availability
   check before we build brand into the dashboard/docs.
8. **Wedge posture confirmation:** this spec chooses **"thin & polished core in MVP, funnels +
   server-side as the marquee fast-follow"** over **"push the wedge features into MVP"**
   (competitive report open question §1). If you want funnels in MVP as the launch headline,
   say so now — it pushes the launch date and the walking skeleton expands.

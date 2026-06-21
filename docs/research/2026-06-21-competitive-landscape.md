# Research — Competitive landscape, feature expectations & differentiation

- **Date:** 2026-06-21
- **Method:** Deep-dive fan-out (4 angles, 2 waves, Sonnet workers, blind tier-1 citation
  verification). Run ID `wf_7b78ceb2-7eb`.
- **Reliability:** all four angles **medium**. Verification corrected several load-bearing
  figures — see ⚠️ flags. **Treat competitor pricing/feature facts as directional; verify the
  specific number before quoting it publicly.**
- **Audience:** the `product-manager` agent. This is the cited evidence base for the product
  spec (thesis, personas, roadmap, MVP).

---

## ⚠️ Most important correction (read first)

The research draft proposed **"Cloudflare-exclusive bot-score + WAF-signal fusion"** as a core
differentiator. **Verification substantially weakened this.** Cloudflare's granular bot scores
(`request.cf.botManagement.score`, JA3/JA4, detectionIds) require **Bot Management — an
Enterprise-only paid add-on.** They are **not** available on Free, Pro, Business, or the
$5/mo Workers Paid plan that our self-hosters will use. The real-world "bot inflation fixed
4–10×" result came from **Cloudflare WAF rules**, which apply to *any* analytics tool placed
behind Cloudflare — not a Workers-native exclusive. The `verifiedBot` flag has *partial*
availability via Super Bot Fight Mode (Pro+), but full scoring does not.

**Implication for the thesis:** bot-signal fusion is **not** the moat. Demote it to a
*nice-to-have*: free-tier **heuristic** bot filtering (UA blocklists, datacenter-ASN
detection, `verifiedBot` where available) plus a **documented "put it behind Cloudflare WAF"
recommended setup**. The defensible moat is elsewhere (see §4).

---

## 1. Market structure (reliability: MEDIUM)

Three tiers in 2026:

1. **GA4** — free, surveillance-funded, cookie-dependent, **~135 KB** script ⚠️(figure from
   competitor Plausible's marketing page — directionally true, GA4 is heavy, but verify).
   GA4 360 enterprise starts **~$150k/yr** ⚠️(the draft's "$50k" was wrong; the cited source
   says ~$150k start, $80–120k mid, $300–500k high). Free-tier retention 14 months.
2. **Privacy-first SaaS** — Plausible, Fathom: ~1–2.5 KB scripts, cookieless, EU-hosted,
   ~$9–15/mo entry.
3. **Self-hosted / OSS** — Umami (MIT), Matomo (GPL), GoatCounter (EUPL), PostHog (MIT),
   plus Cloudflare-native newcomers (Counterscale et al.).

**Competitor snapshot** (✅ verified / ⚠️ corrected / ❓ unverified):

| Tool | License | Self-host | Cookieless | Script | Entry price | Notable gaps |
|------|---------|-----------|-----------|--------|-------------|--------------|
| **Plausible** | AGPL-3.0 ✅ | Yes (CE, feature-gated) ✅ | Yes ✅ | ~2.5 KB | $9/mo ✅ | CE withholds funnels/SSO/revenue/Sites-API ✅; annual save is **~17% ("2 months free"), not 33%** ⚠️ |
| **Fathom** | Closed ✅ | No ✅ | Yes ✅ | ~1.6 KB | $15/mo ✅ | SaaS-only; "EU/US smart routing" claim **not on current pricing page** ⚠️ |
| **Umami** | MIT ✅ | Yes (full) ✅ | Yes ✅ | ~2 KB | Cloud free ≤1M/mo | Session replay + Core Web Vitals shipped **v3.1, Apr 2025 (not Mar 2026)** ⚠️ |
| **GoatCounter** | EUPL-1.2 ✅ | Yes ✅ | Yes ✅ | **~0.9 KB gzip** ✅ (the "3.5 KB" figure is uncompressed ⚠️) | $5/mo | No funnels/goals/ecommerce; **no-JS pixel** (rare, valued) |
| **Matomo** | GPL core ✅ | Yes (paid plugins) ✅ | Optional | larger | €29/mo cloud | Heavy PHP+MySQL+Redis ops; Enterprise on-prem **~€3,400/mo (not €2,834)** ⚠️ |
| **PostHog** | MIT ✅ | Yes ✅ | Optional ✅ | larger | Cloud free ≤1M/mo ✅ | Full product-analytics suite; paid **identified** events ~$0.000248 (not $0.00005 — that's anonymous only) ⚠️ |
| **Cloudflare Web Analytics** | Closed | n/a | Yes | n/a | Free | **10% sampling, 15-item caps, no UTM/events/funnels/live** ✅; retention is **~6 months per CF's own docs, NOT 30 days** ⚠️ (the 30-day figure came from a competitor page and is contradicted by Cloudflare docs) |

**What the OSS segment values** (well-supported): zero data egress to third parties; full
raw-data access; **no artificial feature-gating on self-hosted builds** (the #1 grievance —
Plausible CE deliberately withholds funnels/SSO/revenue); **low ops burden**; permissive
licensing.

---

## 2. Feature expectations (reliability: MEDIUM)

Practitioner consensus (⚠️ the "80% only need tiers 1–2" stat is an author's editorial
framing, not survey data — directionally credible, not hard data):

**Tier A — table-stakes (MVP floor).** Universal across all tools: pageviews, unique
visitors, top pages, referrers/sources, device/browser/OS, country geo, time-series,
**real-time view**, **UTM campaign tracking**. *New* floor-raisers: **scroll depth**
(Plausible, early 2025 ✅) and **Core Web Vitals** (Umami v3.1, Apr 2025 ✅ — ⚠️ the draft
wrongly attributed CWV to Plausible too).

**Tier B — commonly wanted (fast-follow).** Custom events/goals (now effectively table-stakes,
near-identical `track('name', {props})` API ✅); outbound-link & file-download tracking;
**multi-site**; **data export / REST API** (Plausible gates Stats API to Business ✅,
GoatCounter gates API on hosted ✅, Umami self-host free ✅ — *gating these is exactly the OSS
grievance we exploit*); email reports (Plausible/Matomo only); **public/shareable
dashboards** (valued by indie/build-in-public — consider MVP for that persona).

**Tier C — advanced / differentiator (later or out).** **Funnels** (the most-requested
beyond core; gated to Plausible Business, Matomo paid plugin; absent in Fathom/Umami-UI/
GoatCounter — *a free funnel UI is a real wedge*); custom dimensions/properties; cohorts/
retention; **session replay** (Umami v3.1, Matomo plugin, PostHog — heavy, privacy-fraught);
heatmaps (Matomo/PostHog only; Plausible's most-voted-but-unshipped ❓vote-count unverifiable);
A/B testing; **e-commerce/revenue**; **server-side / no-JS tracking** (Matomo & GoatCounter;
niche but a genuine privacy/ad-block wedge — and *natural* for an edge-native tool).

**Top reasons users upgrade to heavier tools** (⚠️ the specific ranking was unsupported, treat
as hypothesis): funnel UI, session replay, e-commerce revenue.

---

## 3. Privacy & compliance (reliability: MEDIUM — legal claims corroborated, vendor stats weak)

- **The canonical cookieless construction** (✅ verified against Plausible, PostHog, Fathom
  data pages): server-side `hash(daily_salt + site_id + ip + user_agent)`; salt rotated &
  **deleted every 24 h**; raw IP/UA never stored. Site-scoped salt → same visitor on two
  sites is unlinkable. This is **cookieless by *architecture*, not configuration** — one
  cookie/localStorage/fingerprint probe voids the exemption (EDPB Guidelines 2/2023, Oct 2024).
- **Why no consent banner** (✅): nothing is written to the device → ePrivacy Art. 5(3)
  (consent for terminal-equipment storage/access) doesn't trigger; GDPR Art. 6(1)(f)
  legitimate interest covers aggregate measurement (per a published legal assessment).
- **Jurisdiction floor:** Germany **TDDDG §25** is strictest — no legitimate-interest path,
  only pure server-side qualifies (✅ corroborated). **CNIL Sheet 16** gives opt-out exemption
  under 7 cumulative conditions incl. **last-byte IP truncation + 13-month cap** (✅). **UK
  DUAA 2025** (Royal Assent 19 Jun 2025; PECR provisions in force **5 Feb 2026**) added a
  **statutory** analytics-cookie consent exemption (✅).
- **Accuracy trade-off** (✅ core / ⚠️ vendor stats): a returning visitor crossing a UTC-day
  boundary counts as new; no cross-session/cross-day journey stitching without a persistent
  ID. The "50–85% accuracy on 100% of traffic vs 90–95% on 40%" figures are **single-source
  vendor (Swetrix)** and one example used an **inverted** accept-rate stat — *do not quote.*

**Design takeaways:** cookieless daily-salt hashing is mandatory and table-stakes; offer
optional last-byte IP truncation + configurable retention to clear CNIL/German bars; be
genuinely cookieless-by-architecture (no client storage at all).

---

## 4. Differentiation — the defensible thesis (reliability: MEDIUM, post-correction)

Existing **Cloudflare-native OSS tools prove the architecture but are MVP-level.**
Counterscale (MIT, ~2.1k★, v3.4.1 Dec 2025: Workers + Analytics Engine + R2/Arrow export, has
UTM ⚠️draft wrongly said it didn't) and a cluster of others (EdgeStat ✅ has funnels+Queues;
Chickadee/InsightFlare/Xolqy ❓unverified) **all lack** rich funnels, polished dashboards, and
robust bot handling. **The gap is a *complete, polished, full-featured* CF-native OSS tool.**

**Defensible pillars, ranked by evidence strength:**

1. **Zero-infra / zero-ops (STRONGEST — well-supported ✅).** No ClickHouse, Postgres, PHP, or
   containers. Plausible CE's ClickHouse is *extensively* documented crashing VPSs
   (disk exhaustion, OOM, CPU crash-loops — multiple independent GitHub issues). Matomo =
   PHP+MySQL+Redis; Umami = Node+Postgres. **Ops burden is the #1 churn driver in self-hosted
   analytics, and Workers+Analytics-Engine eliminates it entirely.** This is the headline.
2. **Cost (STRONG, directional ✅).** $0 on free tier (~50–100k pageviews/day); ~$5/mo for
   ~5–10M pageviews/mo; ~$55/mo at 100M (see architecture report). No DB server, **zero
   egress cost.** ⚠️ The "10–50× cheaper" ratio was loosely derived — claim "dramatically
   cheaper at mid-traffic," not a precise multiple.
3. **Cookieless-by-construction privacy (table-stakes, solid ✅).** Server-side daily-salt
   hashing; no banner; clears EU/UK/German bars. Necessary, not sufficient — everyone has it.
4. **Edge / first-party server-side collection (MODERATE).** Collection runs at the edge on
   the user's own domain → resistant to ad-blockers, and request enrichment (country, ASN,
   TLS, RTT) is free from `request.cf` with **zero client-script bytes** → tiny script. A
   **no-JS / server-side** collection mode is a natural, genuine edge-native wedge.
5. **One-click deploy to your own account (MODERATE).** "Deploy to Cloudflare" button +
   auto-provisioned bindings makes "self-host" a 60-second action, not a weekend — directly
   attacking the ops-burden grievance from a different angle.

**Demoted to nice-to-have:** bot-signal fusion (Enterprise-gated — see top correction). Ship
*heuristic* bot filtering + a documented WAF recipe instead.

**One-line thesis candidate:** *"The full-featured, privacy-first web analytics you deploy to
your own Cloudflare account in 60 seconds — no server, no database, no ops, and a sub-2 KB
script. Plausible's features without Plausible's ClickHouse."*

---

## Open product questions (for the PM spec)

1. **Scope of the wedge:** lean *thin & polished* (Plausible-class core done beautifully) or
   push the *free-funnels* / *server-side-collection* wedge into MVP?
2. **Sampling honesty:** WAE adaptive-samples at high volume; how do we present possibly-
   sampled numbers to users who came here *for* accuracy? (Messaging + rollup strategy.)
3. **Retention:** is "last 90 days" (WAE limit) acceptable for v1, or is R2 archival MVP?
4. **Public dashboards** in MVP? (Cheap, loved by the indie/build-in-public persona.)
5. **License:** AGPL (Plausible-style copyleft, protects against closed SaaS forks) vs MIT
   (Umami-style, max adoption). Strategic call given "no feature-gating" is our pitch.

## Sources (grouped by angle, with dates)

**Competitors:** analytics-alternatives.com GA4 cost calc (2026-05-25) & self-hosted/GoatCounter
reviews (2026); trysight.ai GA pricing (2026-05-09); plausible.io pricing/self-hosting/
vs-cloudflare/lightweight (2026-06); usefathom.com pricing (2026); github.com/umami-software/
umami (2026-06-04); posthog.com/pricing (2026-06-01); matomo.org/pricing (2026); reddit
r/selfhosted (2024); openpanel.dev comparison (2026-04-28).
**Features:** ossalt.com (2026-04-13); draftedby.com (2026-04-19); databuddy.cc (2026-04-10);
apiscout.dev (2026-03-08); plausible nolt.io roadmap (403 ⚠️) & changelog; technologychecker.io
umami (2026-03-10); bigiron.cc, birjob.com, datasaas.co comparisons (2026).
**Privacy:** plausible.io/data-policy + legal-assessment + cookieless (2024–2026); cnil.fr
Sheet 16 (2020-06-11); statnive.com playbook (2026-05-16 ⚠️vendor); posthog.com cookieless
tutorial (2025-08-27); usefathom.com/data; cookiebot.com DUAA (2026-02-05); swetrix.com
(2026 ⚠️vendor); hoganlovells.com CNIL 2025 (403 ⚠️); sealmetrics.com (2026-03-02).
**Differentiation:** plausible vs-cloudflare; WAE pricing/limits/changelog (developers.
cloudflare.com, 2026-04-23 / 2026-01-07); github counterscale (2025-12-15) & EdgeStat
(2026-04-06); bot-management-variables docs (2025-04-30); loopwerk.io protect-analytics
(2026); Workers pricing (2026-04-23); reddit r/selfhosted (2024).

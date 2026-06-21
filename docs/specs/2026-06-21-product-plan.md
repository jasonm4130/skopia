# Skopia — End-to-End Product Plan

- **Date:** 2026-06-21
- **Status:** Draft for human approval. This is the master plan that reconciles the product and
  technical specs into one build sequence.
- **Reconciles:**
  - Product spec → `docs/specs/2026-06-21-product-spec.md` (PM agent)
  - Technical spec → `docs/specs/2026-06-21-technical-spec.md` (tech-lead agent)
  - ADRs `0001`–`0006` → `docs/decisions/`
  - Research → `docs/research/2026-06-21-{competitive-landscape,cloudflare-architecture}.md`
- **Reconciliation note:** the two specs are **fully consistent** — no conflicts to resolve.
  The tech-lead's effort review confirmed every PM ⚠️E ranking: real-time stays in MVP (1.5 wk
  < 2 wk bar), funnels are cheaper than assumed (2 wk → strong #1 fast-follow), Queues out,
  self-rolled auth, 90-day retention acceptable. Three decisions remain **for the human** (§6).

---

## 1. The product in one page

**What:** Skopia — open-source, privacy-first web analytics you deploy to your **own Cloudflare
account in ~60 seconds**. No server, no database to run, a sub-2 KB script, every feature
unlocked.

**Thesis:** *"Plausible's analytics without Plausible's ops."* We beat self-hosted OSS
(Plausible CE / Umami / Matomo) on **zero-ops** (no ClickHouse/Postgres/PHP to babysit — the #1
self-host churn driver) and **zero feature-gating**; we beat privacy SaaS (Plausible/Fathom) on
**cost + data ownership** (~$0–5/mo on infra you already own); we beat Cloudflare's own Web
Analytics on **features** (it 10%-samples, caps lists, has no UTM/events/funnels/live); and we
beat existing CF-native OSS (Counterscale et al.) by being the first **complete, polished** one.
The moat is **zero-ops + finished + open**, *not* bot-signal fusion (Enterprise-gated — demoted).

**Architecture:** five Cloudflare primitives, two Workers, one Cron. Collector Worker →
`writeDataPoint` to **Analytics Engine** (raw events) + bump a **Durable Object** (live count);
**Cron** rolls WAE → exact aggregates in **D1**; **dashboard** Worker (Hono SSR) reads **D1 + KV
cache**, hitting WAE SQL only for today/ad-hoc. No Queues/R2 in the default path. Cookieless
daily-salt HMAC identity (raw IP never stored). Self-rolled signed-cookie auth. One-click deploy.

**Cost:** $0 free tier (≤ ~1M views/mo), ~$5/mo at 10M, ~$50–60 at 100M. First constraint is
WAE **sampling (accuracy), not cost** — mitigated by an honest "~ estimated" badge, never a lie.

---

## 2. MVP scope (locked across both specs)

**IN:** sub-2 KB script (pageviews + SPA + `track()` custom events) · collector Worker (CORS,
cookieless identity, `request.cf` enrichment, heuristic bot drop) · core dashboard (pageviews,
uniques, top pages, referrers/sources, **UTM**, device/browser/OS, geo, time-series + date
picker, **real-time**) · **multi-site** · **custom events/goals** · single-owner auth ·
**public/shareable per-site dashboards** · **one-click Deploy to Cloudflare** · honest sampling
badge.

**OUT (post-MVP):** funnels (fast-follow #1) · server-side/no-JS mode · Stats API/export ·
scroll depth · Core Web Vitals · outbound/download tracking · email reports · R2 archival ·
IP-truncation/retention UI · session replay · heatmaps · A/B · e-commerce · anything
multi-tenant/billing.

**If we must cut to ship, cut in this order:** real-time → public dashboards → custom events.
**Multi-site never cuts** (Agency persona depends on it).

---

## 3. Build sequence (~9–11 weeks, one experienced Workers dev; less with two)

Each phase is a **shippable increment**. The ordering front-loads the riskiest integration (the
end-to-end loop) and defers polish. Effort numbers trace to technical spec §8.

### Phase 0 — Foundations (~0.5 wk)
Repo conventions ✅ (done this session). Add: `wrangler.jsonc` per the binding plan (tech spec
§9.1), TypeScript strict + Vitest with `@cloudflare/vitest-pool-workers`, D1 schema + migrations
skeleton, and **two CI gates from day one**: (1) **script-size budget** (< 2 KB gz — fail the
build on regression, per CLAUDE.md) and (2) **cookieless audit** (assert the script sets zero
cookies/localStorage). *Exit:* `wrangler dev` runs; CI is red-on-violation.

### Phase 1 — Walking skeleton (~2–3 wk)  ← the MVP heartbeat
The whole loop closing, end to end, for **one site**: `<2 KB script (pageview only)` → collector
Worker (CORS, validate, `request.cf` enrich, cookieless HMAC identity, `writeDataPoint`) →
**Cron rollup → D1** → dashboard (behind self-rolled auth) shows a **pageviews time-series** for
that site. *Exit:* a real pageview fired in a browser appears on the dashboard. This proves WAE
write + rollup + read + auth in one slice. (Effort: script 1 wk ∥ collector 1.5 wk ∥ pageviews
schema+rollup 1.5 wk — overlap with 2 devs.)

### Phase 2 — Core metrics + honesty (~1.5–2 wk)
All remaining dimensions on the established rollup pattern: referrers/sources + **UTM** (0.5),
device/browser/OS/geo (0.5), top pages, **time-series + date-range picker** (1). Add **KV cache**
on the read path and the **sampling-honesty badge + `count()` validation** in the Cron (0.5).
*Exit:* the full single-site dashboard a Plausible user would recognize, with honest sampling.

### Phase 3 — Multi-site + custom events (~2 wk)
Multi-site management (site CRUD, per-site index/token/allowlist — 1.5) and **custom events/goals**
display (the generic event schema is already in WAE from Phase 1, so this is mostly UI — 1). Add
SPA route tracking + `track()` to the script. *Exit:* multiple sites in one deploy; events show.

### Phase 4 — Real-time + public dashboards (~2 wk)
`SiteLive` Durable Object + WebSocket (hibernation) live view (1.5) and **public/shareable
per-site dashboards** via `public_token` route (0.5 — reuses the read views). *Exit:* live
visitor count updates in real time; a public link renders read-only.

### Phase 5 — One-click deploy + polish (~2 wk)
**Deploy to Cloudflare button** + binding auto-provisioning + setup README documenting the ≤2
manual steps (1), dashboard shell polish + charts (2, overlaps), and a **full end-to-end deploy
test on a clean Cloudflare account** measuring **TTFD**. *Exit:* a stranger clicks Deploy and
sees their first pageview in < 10 min. **This is the launch gate.**

**Critical path:** Phase 1 (the loop) gates everything; the rollup pattern it establishes is
reused by Phases 2–4. Phases 2/3 dimensions and 4's two features can parallelize across two devs.
Phase 5's clean-account deploy test cannot be faked and should start as soon as Phase 1 lands.

---

## 4. Post-MVP roadmap

| Order | Release | Feature | Effort | Why now |
|-------|---------|---------|--------|---------|
| 1 | **v1.1 (marquee)** | **Funnels** — free funnel UI | 2 wk | Strongest wedge; "the free funnel UI Plausible charges Business for." Events already stored → no pipeline rework. Launch headline. |
| 2 | v1.2 | **Server-side / no-JS collection mode** | 2 wk | Edge-native wedge; closes the strict German pure-server-side bar for Persona P2. |
| 3 | v1.3 | **Stats API / data export** (ungated) | 1.5 wk | Anti-gating positioning; thin read layer over D1/WAE. Agency/SMB demand. |
| 4 | v1.3 | **IP truncation + configurable retention** | 1 wk | CNIL Sheet 16 / German compliance opt-in for P2. |
| 5 | v1.4 | **Outbound/download + scroll depth + Core Web Vitals** | ~1.5 wk | Reserved blob/double slots already exist; new `t` types only. |
| 6 | v1.5 | **Heuristic bot filtering polish + WAF recipe doc** | 1 wk | Improves accuracy without the Enterprise dependency. |
| 7 | Later | **R2 archival beyond 90 days** | 3 wk (beta ⚠️) | Pipelines→R2 Iceberg→R2 SQL; needs caching layer; minority need. |
| — | **Won't-do v1** | session replay, heatmaps, A/B, e-commerce, multi-tenant SaaS | — | The competitors' bloat = our opportunity; several are privacy-fraught. |

The MVP is **deliberately architected so every fast-follow attaches without rework** (technical
spec §10): generic event schema → funnels; collector-side enrichment → no-JS mode; reserved
schema slots → new metric types; commented binding stubs → R2 archival.

---

## 5. Success metrics (launch + 6 months)

- **GitHub stars ≥ 2,000** (beating Counterscale's ~2.1k signals we won the "complete CF-native"
  position); stretch 5,000.
- **≥ 500 successful one-click deploys.**
- **Median TTFD < 10 min** (the headline UX metric — operationalizes "60-second self-host").
- **Setup-failure rate < 10%.**
- **Script stays < 2 KB gz** (CI budget; regressions are bugs).
- Per-feature: cookieless audit green in CI; median sites-per-deploy > 1 (proves multi-site);
  public-links-created > 0 (proves the indie/agency demand); live-view used in ≥ 30% of sessions
  (else reconsider its MVP slot); ≥ X% of deploys create a funnel within 30 days (v1.1 wedge).

---

## 6. Decisions: locked vs. open

**Locked (agent decisions, consistent across both specs):** backbone = WAE + D1 + DO + KV
(ADR-0001) · cookieless daily-salt HMAC, Queues out of default path (ADR-0002) · Cron rollups +
KV cache + honesty badge (ADR-0003) · in-memory `SiteLive` DO for real-time (ADR-0004) · single
Hono SSR Worker + self-rolled signed-cookie auth (ADR-0005) · Deploy-to-Cloudflare button
(ADR-0006) · real-time in MVP · funnels as marquee fast-follow · 90-day retention for MVP.

**Resolved by the human (2026-06-21):**

1. **License → AGPL-3.0 ✅** (confirmed; keeps + protects the "no feature-gating" promise).
   Add the `LICENSE` file in Phase 0. CLA decision deferred (not blocking).
2. **Name → "Skopia" ✅** (kept as working name). Trademark/availability check is a
   **pre-launch task** (Phase 5 readiness), not a blocker now.
3. **Wedge posture → thin polished core, funnels as the v1.1 marquee ✅** (confirmed). MVP scope
   in §2 stands; funnels remain the #1 fast-follow.

**Technical risks to watch (not blockers):** WAE sampling at very-high single-site traffic
(badge mitigates) · WAE billing not yet active (cost model is the priced projection) · WAE SQL
429 rate limit (debounce + serve from D1/KV) · Pipelines/R2-SQL betas (only when R2 archival
ships). Full list: technical spec §12.

---

## 7. Next step

On human sign-off of the three decisions in §6, the next action is to invoke the **writing-plans**
workflow to turn **Phase 0 + Phase 1 (the walking skeleton)** into a concrete, task-by-task
implementation plan with tests — building the smallest end-to-end slice first, then iterating
phase by phase. We do **not** write product code before that plan + approval (per CLAUDE.md
"plan before non-trivial work" and the brainstorming gate).

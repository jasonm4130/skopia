# Skopia — Feature Roadmap (next quarter)

> **STATUS: APPROVED 2026-07-03 (Jason).** O1 — the funnels demotion to a dependency-gated P2
> with the sessionization ADR elevated to P1 — was accepted at approval. This spec reconciles the
> product sweep with the tech-lead feasibility sweep and authorizes implementation in Theme
> order (§3).

- **Date:** 2026-07-03
- **Author:** `product-manager` agent, reconciled with `cloudflare-tech-lead` feasibility.
- **Evidence base (cite both):**
  - Product/competitive inputs → `docs/research/2026-07-03-roadmap-inputs.md`
  - Feasibility/effort/constraints → `docs/research/2026-07-03-tech-state-and-feasibility.md`
  - Prior decided scope → `docs/specs/2026-06-21-product-spec.md`, `…-product-plan.md`
- **Effort letters (S ≤ 3d · M ≈ 1–2 wk · L ≥ 2 wk) are the tech lead's — not re-estimated here.**
- **Lane note:** priority, scope, sequencing, success metrics, and honest-marketing claims are the
  PM's call. Architecture (sessionization design, R2 archival, auth-key model) is the tech lead's —
  recorded here only as **"requires cloudflare-tech-lead ADR"** dependencies, not designed.

---

## 0. What this draft decides, and what changed vs the provisional pass

**The thesis is unchanged and holds** (`product-spec.md` §1, re-validated against the mid-2026
competitive refresh): *"Plausible's analytics without Plausible's ops — the first complete,
polished web-analytics tool you deploy to your own Cloudflare account in ~60 seconds, sub-2 KB
script, every feature unlocked."* Moat = **zero-ops + finished + open**.

**Two feasibility facts reordered the roadmap:**

1. **The cheapest, highest-integrity work is UI-only.** Device/browser/OS, UTM/campaigns, and
   custom-events are ingested, rolled up, and have tested query helpers with **zero UI callers**
   (tech doc §0.3, §4). Surfacing them is **S** each and reads the stable `rollup_daily` table, so
   it's **safe to build now** (no dependency on the pending Phase-2 cutover). These firm up to **P0**.

2. **Funnels are L, not M, and are blocked by an architecture wall.** Funnel conversion needs
   per-visitor *ordered event sequences*; none exist (`entryPath` is hardcoded, no session store),
   WAE has no JOIN/self-join, and the daily-salt `vid` rotation means a funnel can't cross UTC
   midnight (tech doc §0.5, §4.1). Funnels therefore require a **new sessionization primitive**
   (tech-lead ADR) before they can be built. **This moves funnels from the spec's "v1.1 marquee
   fast-follow" to a dependency-gated P2** — demoted on *sequencing*, not on *strategic value*.

**Tier changes vs the provisional roadmap-inputs list:**

| Item | Provisional | Final | Why it moved |
|---|---|---|---|
| Device/Browser/OS, UTM, Custom-events views | P0 | **P0 (firm)** | Confirmed S, UI-only, safe pre-Phase-2 |
| Site-management / settings admin UI | P0 | **P0 (firm, keystone)** | Confirmed the single shared enabler for multi-site, goals, public-share, deploy polish (tech §5.5) |
| **Funnels** | P1 (marquee) | **P2 (gated)** | L not M; requires sessionization + ADR (tech §4.1). Enabler, not the feature, is the near-term line item |
| Landing/exit pages | P2 (floor-raiser) | **P2 (gated on sessionization)** | Not cheap — same session-store root as funnels (tech §4) |
| Live top-pages panel | (not listed) | **P1** | Newly found near-free: DO already pushes `topPages`, client ignores it (tech §2) |
| Data export / Stats API | P1 | **P1** | Held; S–M, light ADR for API-key auth (tech §4) |
| Retention/IP-truncation UI | P2 | **P2 (reframed)** | Shorten/prune = S; 13-month "extend" not needed for CNIL (we're under the cap) — see §1 |
| Core Web Vitals | P2 (consider) | **Not building now** | Thesis-tension (CF's performance lane) *and* a per-event cost multiplier (tech §3.3) |

---

## 1. Constraints we communicate honestly

These are architectural facts (from tech doc §0.5, §3) that shape **marketing claims, docs, and
UI copy** — squarely the PM's lane. We lead with honesty because "accuracy you can stand behind"
is part of the thesis; over-claiming here would forfeit the exact trust we sell.

**C1 — No true cross-day unique visitors (by design, and we keep it that way).**
The daily-salt rotation changes every visitor's identity at UTC midnight, so "unique visitors over
N days" is unavoidably *the sum of daily uniques* (it over-counts a returning visitor). Fixing it
would mean a persistent cross-day identifier — a **privacy regression**, not a feature. Already
tooltip'd honestly in-product (`dashboard/index.ts:533`).
- **We say:** "daily-accurate unique visitors; multi-day totals sum daily uniques (cookieless
  trade-off)." **We never claim:** deduplicated multi-day/returning-visitor counts, cross-session
  user journeys, or cohort/retention analysis. Comparison pages must not imply GA-style user
  stitching.

**C2 — No sessionization yet (bounds bounce, duration, entry/exit, funnels).**
There is no per-visitor session store, so real bounce rate, session duration, entry/exit pages, and
funnels are **not** available until a sessionization primitive is built (P2, ADR-gated). We already
did the honest thing by relabeling the single-page proxy to **"Single-Page Visits"** (not "Bounce
Rate").
- **We say:** "Single-Page Visits" (a page-level proxy). **We never claim:** session-based bounce
  rate, average session duration, or funnel conversion — until C2 is lifted by the sessionization
  build.

**C3 — Free-tier capacity is smaller than the old spec implied (docs honesty).**
Post the DO-durability redesign (ADR-0010), the binding free-tier limit is **DO rows-written
(~0.9M events/mo)**, ~3× tighter than the ~3M/mo the 2026-06-21 spec named (tech doc §3.2). This
affects what we tell self-hosters about "free."
- **We say:** free tier comfortably covers typical indie/SMB traffic (hundreds of thousands of
  monthly events); heavy sites move to Workers Paid (~$5/mo at 10M events). **We don't** repeat the
  stale ~3M/mo free ceiling. (Open question O5 tracks confirming the exact number.)

**C4 — 90-day history is the WAE limit (honest, and compliant).**
WAE retention is a hard 3-month cap on all plans (tech §3.1). This is **under** CNIL Sheet 16's
13-month maximum, so it *helps* compliance rather than hurting it. Year-over-year history is a
separate, minority need that requires the L R2 archival build (§3, Later).
- **We say:** "up to 90 days of history" plainly; frame it as privacy-forward, not a gap.

---

## 2. Prioritized roadmap

Priority = value-to-thesis/persona ÷ effort, with dependencies and the Phase-2 gate respected.
Every P0 item is read-only over `rollup_daily` and therefore **safe to start now** (no wait on the
pending Phase-2 cutover). Personas per `product-spec.md` §2.

### P0 — Complete the product's own promise (near-term, unblocked)

| # | Feature | Problem it solves | Effort | Success metric | Depends on |
|---|---|---|---|---|---|
| 1 | **Device / Browser / OS view** | Owners can't see visitor devices — a universal expectation and spec-designated MVP scope; collected but invisible | **S** | View renders non-empty for any site with traffic; closes a spec-vs-shipped gap | none (query helpers exist) |
| 2 | **UTM / campaigns view** | An indie who tags a launch link can't see campaign performance — despite UTM being a *headline* MVP feature; collected, no view | **S** | ≥1 non-empty UTM row renders for tagged traffic | +2 query helpers (`getTopUtm{Medium,Campaign}`) |
| 3 | **Custom-events view** | `track()` ingests events but there's no way to see them — write-only data today | **S** | Events view lists event names + counts; ≥X% of active deploys can see a fired event | none (`getTopEvents` exists) |
| 4 | **Site-management / settings admin UI** (add/edit/delete site, origin-allowlist editor, `public_token` gen/rotate) | Self-host isn't completable in-browser — adding a real site needs `wrangler d1 execute` SQL; the seeded `default` site ships an *open* allowlist. Blocks the Agency persona's core job and the TTFD headline metric | **M** | A user adds a 2nd site + sets an allowlist entirely in-dashboard; median sites-per-deploy > 1 becomes measurable | **keystone enabler** (tech §5.5); build-schema fix (O-prereq) |

*Why these are P0:* items 1–3 make the product match its own MVP spec at near-zero cost and are the
highest integrity-per-effort work available; item 4 is the missing last mile of the self-host
promise **and** the shared UI scaffolding that later features (goals, public-share UX, deploy
polish) all reuse — build once, unlock several.

### P1 — Earn the announcement (launch readiness + wedge groundwork)

| # | Feature | Problem it solves | Effort | Success metric | Depends on |
|---|---|---|---|---|---|
| 5 | **In-dashboard install/snippet UX** (copyable snippet with correct `data-endpoint` prefilled) | The `/e`-relative-default footgun silently 404s cross-origin installs (`install.md` warns of it) | **S** | Copied snippet works cross-origin first try; drop in `/e`-404 setup issues | pairs with #4 |
| 6 | **Live top-pages panel** (real-time) | The DO already pushes `topPages` every tick; the client discards it | **S** | Live "pages right now" panel updates on the Overview/live view | none (data path done) |
| 7 | **Public-dashboard live count** | Public share links (indie/agency deliverable) show no live count; `/live` is auth-gated | **S–M** | Public link shows a live count | token-scoped `/live` path |
| 8 | **Data export / ungated Stats API** | Owners/agencies want raw data out — exactly what Plausible gates to Business and Fathom sells; anti-gating wedge | **S–M** | CSV export + a documented read endpoint exist, ungated; used on ≥X% of deploys | **light ADR** (API-key auth model) |
| 9 | **Clean-account Deploy E2E + TTFD measurement** | The headline TTFD < 10 min metric is defined but never measured on a real clean account (ADR-0006 human-pending) | **M** | A measured median TTFD + setup-failure rate on ≥3 clean deploys | build-schema fix (O-prereq) |
| 10 | **Marketing comparison pages** (`skopia-www`: "vs Plausible CE", "vs Cloudflare Web Analytics") | The thesis is comparative but a prospect can't see the contrast; fresh 2026 ammunition (CF keeps exact data only ~7 days + pivots to performance; Plausible CE still gates funnels/API) | n/a (marketing repo) | Pages live; deploy/star lift where measurable without tracking users | honest claims per §1 |
| 11 | **Commission the sessionization ADR** (tech-lead) — *decision, not build* | Sessionization is the shared prerequisite for the funnels marquee **and** session metrics; the design choice (DO vs D1 sessions table) gates cost and timeline | ADR only | An accepted ADR sizing the enabler + its per-event cost | **requires cloudflare-tech-lead ADR**; Phase-2 cutover first |

### P2 — Depth & the wedge (dependency-gated)

| # | Feature | Problem it solves | Effort | Success metric | Depends on |
|---|---|---|---|---|---|
| 12 | **Sessionization primitive (build)** | The enabler for #13/#14; per-visitor ordered-event state | **M–L** | Sessions recorded within a UTC day; unblocks funnels + session metrics | **ADR #11**; Phase-2 cutover |
| 13 | **Funnels (free funnel UI)** — *the strategic marquee, now gated* | P4's conversion drop-off job, unpaid; Plausible CE still excludes funnels (2026) | **L** | % of active deploys creating ≥1 funnel within 30 days | **#12 sessionization**; scoped by ADR #11 |
| 14 | **Session metrics** (real bounce, duration, entry/exit pages) | Real session-level insight vs today's page-level proxy; landing/exit pages are a Fathom-2026 floor-raiser | **M–L** | Session-based metrics render; "Single-Page Visits" can gain a true bounce companion | **#12 sessionization** |
| 15 | **Goals / conversions CRUD** | Define goals in-UI (today `listGoals` has no admin surface); `path_prefix` isn't a rollup dim | **M** | Owner defines a goal in-dashboard; conversions display | **#4 settings UI**; **ADR** (goal-eval model) |
| 16 | **Retention controls** (shorten + prune D1; last-byte IP-truncation-into-hash option) | P2 compliance operability (CNIL/German) from the dashboard; `RETENTION_DAYS` exists but is unused | **S** | Owner sets retention/IP option in-dashboard | #4 settings UI; legal-nuance open Q (O4) |
| 17 | **Custom date-range picker** | Only 7d/30d/90d presets today; arbitrary ranges are expected | **S** | Arbitrary from/to range renders correctly | none |
| 18 | **Custom-event property breakdowns** (e.g. `plan=pro`) | Event *names* are visible (#3) but property values aren't; props live only in WAE `blob13`, unrolled | **M** | A property breakdown renders for an event with props | WAE SQL read path |

### Later / not this quarter

| Feature | Effort | Why deferred |
|---|---|---|
| **R2 archival > 90 days** (year-over-year) | **L** | Beta surfaces (Pipelines + R2 SQL), needs caching layer, **requires ADR**; minority need; 90 days already covers indie/SMB/agency + is CNIL-compliant (§1 C4) |
| **Script auto-events** (outbound-link / file-download / scroll depth) | S–M each | Bytes aren't the constraint (1.49 KB headroom), but each auto-event ~3.25× multiplies the dominant DO cost line (tech §3.3) → must be **opt-in / sampled**, not default; low persona pull |
| **Email reports** | — | Low RICE in the prior spec; revisit after the wedge lands |

---

## 3. Dependency-sequenced milestones

Three themes, ordered by dependency (not just priority). The sequencing is load-bearing:
Theme A unblocks trustworthy funnels (you must *see* events before you can build a funnel on them)
and is safe now; Theme B builds the shared scaffolding and earns the announcement; Theme C spends
the expensive, ADR-gated sessionization budget on the marquee.

**Theme A — "Complete the dashboard" (ship now; reads-only; no ADR).**
Headline items: **Device/Browser/OS, UTM/campaigns, Custom-events views** (P0 #1–3) + **live
top-pages panel** (#6). All are S, UI-only over the stable `rollup_daily`, and **safe before the
Phase-2 cutover**. *Outcome:* the product finally shows everything it already collects — the
"complete, polished" claim becomes true. *You cannot credibly announce while headline MVP metrics
are invisible.*

**Theme B — "Settings & the self-host last mile" (shared enabler + launch readiness).**
Headline items: **Site-management / settings admin UI** (P0 #4, the keystone), **in-dashboard
snippet UX** (#5), **public-dashboard live** (#7), **data export / Stats API** (#8), **clean-account
Deploy E2E + TTFD measurement** (#9), **marketing comparison pages** (#10). Prerequisite hygiene:
fix `build-schema.mjs` (embeds only `0001`) before any table-adding feature (tech §5.4). *Also in
this window: commission the sessionization ADR (#11) so Theme C isn't blocked on a cold start.*
*Outcome:* self-host is completable in-browser (unlocks the Agency persona), the TTFD claim is
measured, and the differentiation is legible on the marketing site.

**Theme C — "The wedge" (ADR-gated; the marquee lands on a complete, provable base).**
Headline items: **sessionization build** (#12) → **funnels** (#13) + **session metrics** (#14),
then **goals CRUD** (#15) and **retention controls** (#16). Gated on: the Phase-2 cutover, the
sessionization ADR (#11), and the settings UI (#4). *Outcome:* "the free funnel UI Plausible charges
Business for — on a tool you deployed in minutes and can export freely," landing on a base that is
finally complete and honest.

**Hard sequencing constraints honored (tech §5):**
- Rollup-*writing* features wait for the **Phase-2 cutover** (parity re-gate on/after 2026-07-04).
  Theme A is read-only and exempt.
- **Sessionization is a shared enabler** for funnels + session metrics — sized once (ADR #11 → #12),
  not per-feature.
- The **settings/admin UI is a shared enabler** for multi-site, goals, public-share, deploy polish —
  built once (#4) in Theme B.

---

## 4. Explicitly not building (hold the line)

The thesis wins by being *finished and lean*, not by matching competitor feature counts. The
mid-2026 refresh shows Umami adding exactly the heavy features below (v3.1 session replay, v3.2
heatmaps + revenue) — that is *their* bloat and *our* contrast (`roadmap-inputs.md` §3–4).

- **Session replay** — heavy, privacy-fraught; contradicts the cookieless/no-PII thesis outright.
- **Heatmaps** — heavy, not on-thesis; Umami/Matomo/PostHog territory.
- **A/B testing** — a product-experimentation tool, not web analytics; PostHog's lane.
- **E-commerce / revenue tracking** — heavy upsell feature; off-thesis and privacy-adjacent.
- **Cross-site user tracking / fingerprinting** — voids the privacy thesis; fixed non-goal.
- **Multi-tenant SaaS billing / hosted control plane** — fixed non-goal (single-owner per deploy).
- **Core Web Vitals / performance monitoring** — declined *now* on two grounds: it drifts into
  Cloudflare's own performance/RUM lane (where their free tool is doubling down, per §4 refresh),
  and each auto-event multiplies the DO cost line. Reconsider only if persona demand proves it.
- **Accurate cross-day / returning-visitor uniques** — architecturally impossible without weakening
  the cookieless model (§1 C1). Not a backlog item; a stated trade-off.
- **Paid Bot Management integration** — Enterprise-gated; stays heuristics + a WAF-recipe doc.

---

## 5. Open questions (for the human and, where noted, the tech lead)

- **O1 — Funnels demotion sign-off (human).** The 2026-06-21 spec named funnels the **v1.1 marquee
  fast-follow**. Feasibility says they're **L + sessionization ADR**, so this draft moves them to
  a dependency-gated P2 and elevates the *enabler* (sessionization ADR) to P1. **Confirm** this
  reordering, or accept a later launch to keep funnels as the headline. *Recommendation: accept the
  reordering — ship the complete/legible base (Themes A/B) first; the funnels moment is stronger
  landing on it.* **RESOLVED 2026-07-03: accepted at approval — the reordering stands.**
- **O2 — Should data export (#8) ship in Theme B or wait?** It's read-only and needs only a light
  API-key auth ADR, so it *can* land early as an anti-gating win. *Recommendation: include it in
  Theme B* — cheap, on-thesis, freshly differentiated by Fathom/Plausible gating.
- **O3 — Marketing-site scope (human).** Comparison pages (#10) live in `../skopia-www`. Confirm
  this is in-scope for the PM to spec and that honest-claim constraints (§1) are the guardrails.
- **O4 — IP-truncation legal nuance (flag, not a call).** Skopia is cookieless-by-architecture: raw
  IP is hashed with the daily salt and discarded, never stored. Whether last-byte truncation *into
  the hash* is required for CNIL Sheet 16 is a legal question above the agents' pay grade. **Flag
  for human/legal**, not resolved here. (Retention shortening itself is a confirmed S — tech §4.)
- **O5 — Free-tier number (tech lead, MEDIUM confidence).** The ~0.9M events/mo free-tier ceiling
  and ~$15/mo @ 20M rest on the inferred 2.25× `seen` multiplier; ADR-0010 plans to capture real
  `meta.rows_written` on the Phase-2 parity run. **We should not publish a precise free-tier number
  until that lands** — §1 C3 uses a hedged claim meanwhile.
- **O6 — Sessionization cost/design (tech lead, ADR #11).** The funnels L-estimate depends on the
  chosen sessionization design (DO per-visitor vs D1 sessions table) and its per-event cost. This is
  the single biggest unknown gating Theme C; commission it early (Theme B window).
- **O7 — Historical backfill residue (tech lead).** Phase 2 moots the forward day-range gap (DO owns
  forward counts), but there is **no backfill for pre-DO days** on existing deploys. Confirm whether
  any deploy shows visible historical gaps; if so, decide whether it's a one-time backfill or an
  honest "history starts here" note. Minor; not a milestone blocker.

---

## Sources

- `docs/research/2026-07-03-roadmap-inputs.md` (PM product/competitive sweep, incl. mid-2026
  competitive refresh with dated web citations)
- `docs/research/2026-07-03-tech-state-and-feasibility.md` (tech-lead feasibility, effort letters,
  Cloudflare limits verified 2026-07-03, the two architectural walls, cost model)
- `docs/specs/2026-06-21-product-spec.md`, `docs/specs/2026-06-21-product-plan.md` (prior decided
  scope, thesis, personas)
- `docs/research/2026-06-21-competitive-landscape.md` (original competitive evidence base)
</content>

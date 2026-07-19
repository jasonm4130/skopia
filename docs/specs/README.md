# Specs

Approved design specs — the **source of truth for what we build**. A spec here means it has
been synthesized from research, reconciled across the product + technical lanes, and (ideally)
human-approved.

Naming: `YYYY-MM-DD-<topic>.md`

Specs on file:

- [`2026-06-21-product-spec.md`](2026-06-21-product-spec.md) — differentiation thesis,
  personas, prioritized roadmap, MVP scope, success metrics. (product-manager)
- [`2026-06-21-technical-spec.md`](2026-06-21-technical-spec.md) — end-to-end architecture
  (collection → ingestion → storage → query → dashboard → deploy), cost/scale model,
  binding plan. (cloudflare-tech-lead)
- [`2026-06-21-product-plan.md`](2026-06-21-product-plan.md) — the synthesis that ties
  product + technical together into a build sequence.
- [`2026-06-29-do-incremental-counters-design.md`](2026-06-29-do-incremental-counters-design.md)
  — the SiteLive Durable Object incremental-counter design.
- [`2026-07-03-feature-roadmap.md`](2026-07-03-feature-roadmap.md) — the prioritized
  post-MVP feature roadmap.
- [`2026-07-05-launch-readiness-design.md`](2026-07-05-launch-readiness-design.md) — the
  launch-readiness workstreams (demo, README, marketing honesty, launch assets).

Specs reference the ADRs in `../decisions/` for the *why* behind technical choices.

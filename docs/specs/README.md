# Specs

Approved design specs — the **source of truth for what we build**. A spec here means it has
been synthesized from research, reconciled across the product + technical lanes, and (ideally)
human-approved.

Naming: `YYYY-MM-DD-<topic>.md`

Expected specs:

- **Product spec** — differentiation thesis, personas, prioritized roadmap (RICE/MoSCoW),
  MVP scope (in/out), success metrics. (owner: product-manager)
- **Technical spec** — end-to-end architecture (collection → ingestion → storage → query →
  dashboard → deploy), cost/scale model, binding plan. (owner: cloudflare-tech-lead)
- **End-to-end product plan** — the synthesis that ties product + technical together into a
  build sequence.

Specs reference the ADRs in `../decisions/` for the *why* behind technical choices.

# Skopia — Design System

The frontend's visual + behavioral source of truth, imported from the Claude Design project
**"OSS Analytics on Cloudflare"** (`5ae45fa2-6048-42bb-891b-08663484a731`) on 2026-06-21.

These are the canvas we build the real frontend *to match* — not the production frontend itself
(see [Status & how this maps to the build](#status--how-this-maps-to-the-build)).

## Files

| File | What it is | Interactive? |
|------|-----------|--------------|
| `Skopia Marketing.dc.html` | Public landing page — nav, hero (terminal mock), trust strip, how-it-works, product shot, features bento, comparison table, pricing + **live cost calculator**, FAQ accordion, CTA, footer. The canonical marketing direction. | ✅ calculator slider + FAQ accordion |
| `Skopia Dashboard.dc.html` | The product dashboard — sidebar nav, Overview (stat cards, time-series chart, top pages/sources), Geography (jsVectorMap world map + top countries), Pages/Sources tables. The canonical app direction. | ✅ range picker, metric toggle, chart hover, view switching, geo map |
| `Skopia Dark.dc.html` | Static "board" showing the landing + dashboard side by side on a neutral backdrop. A presentation artifact, not a page to build. | — static |
| `Skopia Exploration.dc.html` | Early design rationale + light-theme variants that preceded the dark direction. Kept for design history. | — static |
| `support.js` | The Claude Design ("DC") runtime that renders the `.dc.html` files. Generated, vendored — do not edit. | — |

> Not imported: `screenshots/geo.png` (a static screenshot in the source project, not referenced by
> any design file — the geo view renders live via jsVectorMap). Pull it from the Claude Design
> project if a reference image is ever needed.

## Design tokens

Lifted from the dark direction (the chosen one). Use these as the canonical palette/type scale when
building the real frontend.

**Color**
- Backgrounds (darkest→lightest): `#0a0c11` page · `#0c0e14` alt section · `#0d1016` sidebar/inset · `#12151d` cards · `#161a23`/`#1a1f2a` chips
- Borders: `#161a22` hairline · `#1b1f29` sidebar · `#20252f` card · `#232838`/`#262b38`/`#2a3040` controls · `#2a3550` accent border
- Accent blue: `#4d86ff` primary · `#8fb0ff`/`#9fb4ff` light-blue text · `#6a9bff` hover
- Semantic: `#2bd888` green (positive/healthy) · `#e08571` red (negative) · `#7a5cff` purple (sources) · `#ffce4d` star
- Text (strong→faint): `#ffffff` · `#e8eaef` · `#cfd4e0` · `#9aa1b2` · `#8b92a4` · `#6a7184` · `#5a6072`
- Chart fill: linear gradient `#4d86ff` @ .30 → 0

**Type**
- `Space Grotesk` — display / headings (700/600)
- `Hanken Grotesk` — body / UI (400–600)
- `JetBrains Mono` — labels, code, terminal, axis ticks, metric tags

**Shape:** card radius 11–16px · button/chip radius 7–10px · pill radius 20px · logo mark = 3 stacked
blue bars at descending width/opacity (`#4d86ff` 100/70/45%).

## Status & how this maps to the build

**These `.dc.html` files are a visual/behavioral spec, NOT drop-in production code.** They are Claude
Design source: each is `<x-dc>` markup + a `<script type="text/x-dc">` `DCLogic` component, rendered by
`support.js`, which expects React/ReactDOM globals supplied by the Claude Design host. They will not
render by simply opening the `.html` in a browser, and the production stack is different anyway —
the technical spec calls for a **Hono SSR dashboard Worker** (`docs/specs/2026-06-21-technical-spec.md`).

Build mapping:

| Design file | Builds into | Build phase |
|-------------|-------------|-------------|
| `Skopia Dashboard.dc.html` | Hono SSR dashboard Worker — its `DCLogic` (range picker, metric toggle, chart hover, geo map) is the behavioral spec for Phases 1–4 | Phases 1–4 |
| `Skopia Marketing.dc.html` | Public marketing/landing page (static or Pages); cost calculator + FAQ logic are spec'd in its `DCLogic` | Phase 5 / launch |
| `Skopia Dark.dc.html`, `Skopia Exploration.dc.html` | Reference only | — |

**To preview the originals:** open the Claude Design project. To render locally you would need to load
React + ReactDOM as globals before `support.js` (the files don't include them).

**To re-sync after editing in Claude Design:** re-import via the `claude_design` MCP `get_file` for each
path; keep the original filenames (with spaces) so the cross-links between Marketing → Dashboard resolve.

## License: reconciled to AGPL-3.0

The design originally said **"MIT licensed"** in seven places — Marketing (hero badge, Open-source
feature card, Pricing header, FAQ answer, footer), Dark (hero trust item), and Exploration (hero trust
item). On 2026-06-21 all seven were corrected to **AGPL-3.0**, matching the locked decision
(`docs/specs/2026-06-21-product-spec.md` §6, repo `README.md`) — both in these local files and pushed
back to the Claude Design source via the `claude_design` MCP, so the design stays the source of truth.
(Dashboard never referenced a license.)

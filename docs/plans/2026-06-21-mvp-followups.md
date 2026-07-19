# Stratus — MVP Follow-ups (post-build)

> **STATUS: RESOLVED (historical).** The HIGH / correctness / security / honesty findings
> captured here were actioned in the follow-up commits described below.

Captured 2026-06-21 after building the MVP on `build/mvp` and running an adversarial
review pass. The HIGH and clear correctness/security/honesty findings were fixed in
`f22920c` ("Remediate reviewer findings"). The items below were **deliberately deferred** —
they're real, but each needs a contract/architecture change, is launch-hardening, or is
lower priority. Tracked here so they aren't lost (the raw review output is ephemeral).

## Privacy / security (pre-launch)

- **Self-host fonts.** Both the landing page and the dashboard load Google Fonts from
  `fonts.googleapis.com` / `fonts.gstatic.com`, which sends every visitor's IP to Google —
  directly at odds with the privacy-first thesis. Vendor the woff2 files and serve them from
  the Worker; drop the external links. (affects `src/marketing`, `src/dashboard`)
- **Content-Security-Policy + security headers** on all responses (`nosniff`,
  `frame-ancestors`/`X-Frame-Options`, `Referrer-Policy`). Inline scripts need a nonce or hash.
- **Public-dashboard live.** `/live` is now auth-gated, so `/public/:token` views have no
  realtime. Add a token-scoped live path so public dashboards can show the live count.
- **jsVectorMap from CDN** in the dashboard geography view — vendor it or pin with SRI.

## Performance

- **KV response cache** (technical spec §5.3): cache rendered dashboard pages ~60–120s in the
  `CACHE` binding. Currently every dashboard load hits D1 directly.
- **Rollup backfill.** The cron rolls up today + the 2 prior days only (to dodge the WAE SQL
  rate limit). Add a full-retention backfill path.

## Metrics / data model

- **Per-page bounce column** (the design shows it) — needs `BreakdownRow.bounceRate`, a change
  to the `page`-dimension rollup, and the dashboard column.
- **Avg. session time + period-over-period delta** stat cards (the design shows both) — need
  new rollup data and a prior-period comparison query.
- **Bounce rate is a single-page-visit proxy**, not a session-level metric. Rename/label it,
  or compute it properly once session-level data exists.

## Lower-priority

- Identity daily-salt KV write race (tiny window at midnight; self-corrects within the TTL).
- Tracking-script pageview firing model — currently fires on load + `keepalive`; the spec text
  describes `visibilitychange`. Confirm the intended model.
- Custom-event props are dropped (not truncated) when over the size cap.
- Bot heuristic: the bare `bot` substring over-matches; tighten to a word boundary.
- Cosmetic: stat-card labels vs the design ("Views/Visitor" etc.).

## Process

- The **Claude Design source** (`Stratus Marketing.dc.html`) still carries the old pricing
  numbers (~$5 at 1M views) and the `4.2k` / `3,400+` placeholders that the marketing code now
  corrects. Re-sync the design source via the `claude_design` MCP if it should stay canonical.

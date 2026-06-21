# 0004 — Real-time live-visitor approach

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

The MVP includes a real-time live-visitor view (product spec #10, ⚠️E). The PM needs to know if
it exceeds ~2 weeks — if so it drops to fast-follow. We need a primitive that maintains a
per-site, near-real-time count of active visitors and pushes updates to the dashboard, cheaply,
without polluting the historical store (which is WAE+D1). Verified: only Durable Objects offer
strongly-consistent per-key in-memory state + WebSockets; the **WebSocket Hibernation API** lets a
DO sleep between messages to cut duration billing; `web_socket_auto_reply_to_close` is default on
compat dates ≥ 2026-04-07 (live-verified).

## Decision

**One Durable Object class `SiteLive`, one instance per site (`idFromName(site_id)`), in-memory
only, using the WebSocket Hibernation API.**

- On each beacon, the collector calls `SITE_LIVE.fetch('/hit', {vid, path})` via `waitUntil`.
- The DO keeps an in-memory `vid → lastSeen` map; entries older than **5 minutes** are evicted via
  a **DO Alarm** (~every 30 s) so the count decays even with no new hits. Live count = map size.
- The dashboard opens a **WebSocket** (`/live`, proxied through the dashboard Worker); the DO
  pushes count + top active pages on change. `getWebSockets().length` = dashboard-viewer count.
- **No persistence / no SQLite** in the live path — live state is ephemeral; history lives in
  WAE+D1 → **no DO storage cost.**
- Compat date set past `2026-04-07` so the runtime auto-completes WS close handshakes (no manual
  close-frame handling).

**Effort verdict: ~1.5 weeks → under the 2-week bar → real-time STAYS in MVP.** It is the smallest
⚠️E item because it needs no persistence and the Hibernation API is well-trodden.

## Alternatives considered

**A. Poll WAE SQL every few seconds for "last 5 min" counts.** No new primitive, but: WAE SQL
rate limits (429s), sampling at volume, and seconds-stale — not "real-time," and it hammers the
rate-limited API. Rejected.

**B. KV counter with short TTL.** Cheap, but KV is eventually consistent (1–2 min) and has no
push — can't drive a live view, and no clean per-visitor dedup within the window. Rejected.

**C. DO with SQLite persistence of live sessions.** More durable, but adds storage cost and write
load for data that is inherently throwaway (the 5-minute window). Over-engineered. Rejected in
favor of in-memory.

**D. Drop real-time to fast-follow.** The PM's fallback if effort > 2 wk. Not needed — effort is
1.5 wk. (If it had been heavier, this is the clean cut.)

## Consequences

**Easy:** true push-based live view, cheap (hibernation = minimal duration billing, no storage),
per-site isolation, history store untouched. At 100M/mo the live DO is ~$0.60/mo.

**Hard / watch:** a very hot single site approaches the ~1,000 req/s soft per-object cap — fine for
self-host scale, a scaling note for a hypothetical mega-site (could shard the DO by visitor-hash if
ever needed). In-memory state is lost if the DO is evicted/restarted — acceptable (it re-fills
within the 5-min window from live traffic; nothing historical is lost). Integration polish (WS
reconnect on the dashboard, count-decay smoothing) is the real work, not core feasibility — hence
M confidence on the 1.5-wk estimate.

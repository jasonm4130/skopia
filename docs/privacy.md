# Privacy & data policy

This is the canonical description of what Skopia collects, computes, stores, and
cannot know — the exact behavior of the code, not a summary of it. Every mechanism
claim below links the source file that implements it, so a skeptical reader can
verify it in one read rather than take our word for it. It describes the
software's behavior; it is **not legal advice**.

Skopia is self-deployed on your own Cloudflare account — everything below runs
inside that account. Nothing is sent to the Skopia project or any third party;
you are the sole holder of the data.

## 1. What Skopia stores

**What the browser sends.** The tracking script
([`src/script/skopia.ts`](../src/script/skopia.ts)) POSTs a small JSON beacon on
each pageview and each custom event call. It sets **no cookies** and reads or
writes **no `localStorage`, `sessionStorage`, or `indexedDB`** — there is nothing
in the script that touches browser storage at all. The wire format is
[`Beacon`](../src/shared/types.ts):

| Field sent by the browser | Example | Notes |
|---|---|---|
| Path + query string | `/pricing?utm_source=hn` | `location.pathname + location.search`. |
| Referrer (first send only) | `https://news.ycombinator.com/` | Sent once per page load; the collector reduces it to a hostname (below). SPA route changes and custom events reuse the same referrer without re-sending it, so a single arrival is never double-credited. |
| Screen width | `1440` | `screen.width`, in pixels. |
| Event name + props | `signup`, `{ plan: "pro" }` | Only for custom events fired via `skopia.track(...)`; absent on pageviews. |

That is the complete payload — see `send()` in
[`src/script/skopia.ts`](../src/script/skopia.ts). (The wire format also declares
a `ti`/document-title field for future use; the shipping script never sets it,
so no page title is ever sent or stored.)

**What the collector derives and stores, per event.** The collector
([`src/collector/index.ts`](../src/collector/index.ts)) enriches the request
server-side and writes one row per event to Workers Analytics Engine. The exact
field list is the `WaeEvent` interface in
[`src/shared/types.ts`](../src/shared/types.ts):

| Stored field | Derived from | Notes |
|---|---|---|
| `siteId` | the beacon's site id | Partitions events; never a per-visitor identifier. |
| `vid` | HMAC of IP + UA + salt + site ([§2](#2-the-visitor-id-precisely)) | 16-hex cookieless daily visitor hash. |
| `pathname`, `entryPath` | the beacon's path | `entryPath` currently duplicates `pathname` (reserved for future funnel/landing-page reporting). |
| `referrerHost` | the beacon's referrer, host-only | e.g. `news.ycombinator.com` — never the full referrer URL, never query params. |
| `utmSource`, `utmMedium`, `utmCampaign` | the path's query string | Standard campaign tags, if present. |
| `country` | `request.cf.country` | Two-letter country code only. **No city, no region, no coordinates.** |
| `deviceClass`, `browser`, `os` | the `User-Agent` header | Coarse families only (`mobile`/`tablet`/`desktop`, `Chrome`, `macOS`) — see [`parseUserAgent`](../src/shared/cf.ts). |
| `eventName`, `propsJson` | the beacon's custom-event name/props | Empty for pageviews. Whatever you put in a custom-event prop is stored verbatim — see [§5](#5-what-skopia-does-not-collect). |
| `screenWidth` | the beacon's `screen.width` | Also used server-side to bucket `deviceClass` when the `User-Agent` alone reads as desktop. |
| `count`, `isPageview` | fixed / beacon type | Aggregation bookkeeping, not visitor data. |

The broader `request.cf` object (which also carries data-center, ASN, and
network-org fields used only for bot filtering) is read once per request and
never persisted beyond the `country` field — see
[`enrichFromCf`](../src/shared/cf.ts). Nothing outside the table above is
written anywhere.

**Explicitly absent from storage:** no raw IP address, no cookies, no
`localStorage`/`sessionStorage`/`indexedDB`, no cross-site identifier of any
kind, no precise geolocation, no full referrer URL, no page title.

## 2. The visitor id, precisely

Skopia has no persistent visitor identifier. To count unique visitors within a
UTC day, [`deriveVid`](../src/shared/identity.ts) computes:

```
visitor_id = first 8 bytes of
  HMAC-SHA-256( key: IDENTITY_HMAC_SECRET,
                message: daily_salt | ip | user_agent | site_id )
  → 16 hex characters
```

Read the function: [`src/shared/identity.ts`](../src/shared/identity.ts).

- `IDENTITY_HMAC_SECRET` is a secret you generate at deploy time (see the
  [install guide's secret-generation walkthrough](install.md#generating-your-secrets));
  it never leaves your account and is not part of this repo.
- The raw client IP and `User-Agent` are read from the request, folded into the
  hash **in memory**, and then discarded — see the identity step in
  [`handleCollect`](../src/collector/index.ts). Neither is ever written to WAE,
  D1, or any log.
- `daily_salt` is 32 cryptographically random bytes (`crypto.getRandomValues`),
  generated on first use for a given UTC day and stored in Workers KV — see
  [`getDailySalt`](../src/shared/identity.ts). Its KV TTL is anchored to the day
  boundary, not to when it was created: the salt expires roughly **1 hour after
  its own UTC day ends**. Once a day's salt is gone, no one — including the
  site owner — has the input needed to recompute or verify that day's
  `visitor_id` values, because the salt is never written anywhere else and is
  not recoverable from the hash output.
- `site_id` is part of the hashed message, so the same person on two different
  sites in the same deployment produces two unrelated `visitor_id` values.
- Truncating the HMAC output to 64 bits (16 hex chars) is deliberate: enough
  entropy to count a day's uniques without collision at realistic traffic, too
  short to serve as a durable fingerprint.

The stored `vid` itself is a one-way hash, never the IP or UA it was derived
from — see [§1](#1-what-skopia-stores) for how long it lives.

## 3. What this means the site owner can and cannot know

This is a design choice, not a gap to be filled later.

**Can know:** unique visitors *within a given UTC day, within a given site* — an
honest same-day, same-site count.

**Cannot know, by design:**

- True monthly (or any multi-day) unique-visitor counts. A month's uniques
  would require correlating hashes across days, which the salt rotation in
  [§2](#2-the-visitor-id-precisely) rules out; the dashboard can only ever sum
  *daily* uniques, which is a different (larger) number than "distinct people
  this month."
- Cross-day visitor journeys — e.g. "visited Monday, converted Thursday." No
  identifier survives a UTC day boundary to link the two visits.
- A returning-visitor rate beyond a single day. "New vs. returning" is only
  ever meaningful within one day's window.

**Known accuracy limits**, independent of the above:

- **Shared IP + identical `User-Agent`** (an office NAT, CGNAT on mobile
  carriers, a school network) makes multiple distinct people hash to the same
  `visitor_id` for the day — this **under-counts** unique visitors.
- **A visitor whose IP changes mid-day** (VPN hopping, carrier IP rotation)
  produces a new `visitor_id` for each IP — this **over-counts** unique
  visitors.

Both limits are inherent to any cookieless, IP-derived identity scheme, not a
Skopia-specific defect.

## 4. Where data lives

Everything below lives inside the Cloudflare account you deployed Skopia into.
Skopia the project has no server, no database, and no visibility into any
deployment's data.

- **Raw events** — every row described in [§1](#1-what-skopia-stores) is
  written to **Workers Analytics Engine**
  (`env.WAE.writeDataPoint` in [`handleCollect`](../src/collector/index.ts)).
  WAE applies a **hard, platform-level 90-day retention** on raw data points —
  this is a Cloudflare plan limit, not a Skopia setting, so raw events older
  than roughly 90 days are gone regardless of configuration.
- **Aggregates** — exact daily rollups (pageviews and visitor counts per site,
  per day, per dimension) are written incrementally, per event, by a per-site
  Durable Object into **your D1 database** — see the `rollup_daily` upsert in
  [`src/dashboard/site-live.ts`](../src/dashboard/site-live.ts). Schema:
  [`migrations/0001_init.sql`](../migrations/0001_init.sql). Rollups contain no
  `vid`, no IP, and no `User-Agent` — only aggregate counts — and are not
  subject to WAE's 90-day cap, so they remain as your durable long-range
  history once the raw window rolls off.

No data point, event, or aggregate is ever transmitted outside your Cloudflare
account.

## 5. What Skopia does NOT collect

- No cookies or any client-side storage.
- No browser fingerprinting.
- No precise location — country only.
- No full IP address at rest, at any retention tier.
- No cross-site or cross-day persistent identifier.
- No page title.
- No personal data, **unless you put it into a custom-event prop** (`{ d: {...}
  }`) yourself — Skopia stores whatever you pass there verbatim, so avoid
  putting emails, names, or other personal data into custom-event props. See
  [install.md](./install.md#6-custom-events).

Traffic identified as a bot by the collector's heuristics
([`isBot`](../src/shared/cf.ts)) is dropped before any of the above is computed
or stored.

## 6. Source links

The claims above are backed by these files, at the paths above:

- [`src/shared/identity.ts`](../src/shared/identity.ts) — visitor-id derivation
  and daily salt.
- [`src/collector/index.ts`](../src/collector/index.ts) — the ingestion path:
  what is read from the request, what is discarded, what is written.
- [`src/shared/types.ts`](../src/shared/types.ts) — the exact stored-field list
  (`WaeEvent`, `Beacon`).
- [`src/script/skopia.ts`](../src/script/skopia.ts) — the tracking script; the
  entire client-side payload.
- [`src/dashboard/site-live.ts`](../src/dashboard/site-live.ts) — the
  `rollup_daily` writer.
- [`migrations/`](../migrations/) — the D1 schema, including the
  `rollup_daily` aggregate table.

## A note on consent and regulations

Skopia uses no cookies and stores no raw IP, no persistent cross-day
identifier, and no personal data by default. Whether a given deployment needs a
consent banner depends on your jurisdiction, your configuration, and how you
use custom-event props — that determination is yours to make, and this
document is not legal advice. Consult a professional if you have compliance
obligations to meet.

---

Found something on this page that doesn't match the code it links to? Open an
issue — this document's accuracy is the whole point of it.

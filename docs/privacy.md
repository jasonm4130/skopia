# Privacy & data collection

Skopia is built to measure traffic without tracking people. This page is the exact
inventory of what it collects, what it derives, what it stores, and what it
deliberately does **not** do. It describes the software's behavior; it is **not
legal advice**.

When you self-host Skopia, all of this runs in **your** Cloudflare account. No data
is sent to the Skopia maintainers or any third party — you are the data controller.

## What the browser sends

The tracking script (`/skopia.js`, < 2 KB gzipped) sends only:

| Field | Example | Notes |
|-------|---------|-------|
| Path + query | `/pricing?utm_source=hn` | The page being viewed. |
| Referrer | `https://news.ycombinator.com/` | Only the host is kept (see below). |
| Document title | `Pricing — Example` | |
| Screen width | `1440` | A device-class hint only. |
| Event name + props | `signup`, `{ plan: "pro" }` | Custom events only, when you fire them. |

That is the complete payload. The script uses **no cookies, no `localStorage`, no
`sessionStorage`, and no `indexedDB`** — this is audited in CI on every build.

## What the server derives (zero client bytes)

The rest of what the dashboard shows is derived at the edge from request metadata
that Cloudflare already attaches to the connection, then immediately reduced to
coarse buckets:

| Derived | Source | Stored as |
|---------|--------|-----------|
| Country | `request.cf.country` | Two-letter country code only — **no city, no precise location**. |
| Device class / browser / OS | `User-Agent` header | Coarse families (`mobile`, `Chrome`, `macOS`). |
| Referrer host | The referrer URL | Host only (e.g. `news.ycombinator.com`), not the full URL. |
| UTM source / medium / campaign | The page's query string | Standard campaign tags. |

The raw IP address and the raw `User-Agent` are used **transiently** to compute the
visitor hash and to filter bots, then discarded. Neither is ever written to
storage.

## How visitors are counted (cookieless)

Skopia has no persistent visitor identifier. To count unique visitors within a day,
it computes a one-way hash:

```
visitor_id = HMAC-SHA256( daily_salt | ip | user_agent | site_id )   → first 64 bits
```

- The **raw IP is never persisted** — it is an input to the hash and is then gone.
- The **daily salt** is a random 32-byte value that **rotates at UTC midnight**;
  the previous day's salt is deleted. Once the salt rotates, yesterday's hashes can
  never be reproduced, so **cross-day correlation of a visitor is impossible**.
- The `site_id` is part of the hash and the HMAC key is unique to your deployment,
  so the same person on two different sites — even two sites you host — produces
  **different, uncomparable** IDs.

The practical consequence: "unique visitors" is an honest *within-day, within-site*
estimate. There is no profile, no cross-site identity, and no way to follow a person
over time.

## What Skopia does NOT collect

- No cookies or any client-side storage.
- No browser fingerprinting.
- No precise location — country only.
- No full IP address at rest.
- No cross-site or cross-day persistent identifiers.
- No personal data — **unless you put it into a custom event prop**, which you
  should not do (see [install.md](./install.md#6-custom-events)).

Traffic identified as a bot is dropped and never stored.

## Where data lives and how long

- **Raw events** are written to **Workers Analytics Engine** in your Cloudflare
  account. WAE applies its own platform-level retention.
- **Aggregates** (exact daily rollups) are computed by a cron job and stored in
  **your D1 database**.
- Application-level retention is governed by the `RETENTION_DAYS` variable in
  `wrangler.jsonc` (**default: 90 days**). Adjust it to your needs.

Everything stays inside your Cloudflare account for its entire lifecycle. No data
leaves the platform.

## A note on consent and regulations

Because Skopia uses no cookies and stores no personal data or persistent
identifiers, it is designed to fit the kind of analytics that typically does not
require a consent banner under regimes like GDPR/ePrivacy. **However, compliance
depends on your jurisdiction, your configuration, and how you use custom events —
you are responsible for it.** This is not legal advice; consult a professional if
you have obligations to meet.

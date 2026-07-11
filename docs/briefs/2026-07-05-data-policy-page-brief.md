# Claude Design brief — /data-policy page (new, skopia.dev)

**Date:** 2026-07-05 · **Repo:** `../skopia-www` (new page: `src/pages/data-policy.astro`)
**Parent spec:** `docs/specs/2026-07-05-launch-readiness-design.md` (Tracks B/C)
**Research basis:** Plausible's data-policy page — the URL that turned a hostile
"Isn't GDPR Compliant" HN thread into neutral experts defending them
(`docs/research/2026-07-05-best-in-class-analytics-marketing.md` §3.2c).

## Job of the page

The **single canonical URL** pasted in every privacy argument, forever. It must let a
technical skeptic verify the mechanism from source in one read. It is documentation with
a design, not marketing: calm, precise, source-linked.

## Register rules (hard)

- **Never** the words "GDPR compliant", "anonymous", or "impossible to track". Describe
  the mechanism; let readers conclude. (Umami had to delete its GDPR claim mid-thread;
  Plausible's mechanism doc got defended *for* them.)
- Every claim links the actual source file on GitHub. The code is the argument.
- State what the design **cannot** tell the site owner as prominently as what it can.

## Page structure

1. **What Skopia stores** — the exact event fields (site, path, referrer hostname,
   country, device class, browser, OS, UTM tags, visitor id for the day). Explicitly:
   no raw IP at rest, no cookies, no localStorage, no cross-site identifiers.
2. **The visitor id, precisely** — the mechanism verbatim from
   `src/shared/identity.ts` (link the file):

   ```
   visitor_id = first 8 bytes of
     HMAC-SHA-256( IDENTITY_HMAC_SECRET, daily_salt | ip | user_agent | site_id )
   ```

   - The raw IP and User-Agent are consumed in-memory at the edge and never persisted.
   - `daily_salt`: 32 random bytes per UTC day, stored in Workers KV with a TTL anchored
     to the day boundary (~1 h after the UTC day ends the salt is gone). No salt, no way
     to recompute or correlate ids across days — by anyone, including the site owner.
   - Truncation to 64 bits is deliberate: enough to count a day's uniques, useless as a
     durable identifier.
   - Scoped per site: the same visitor on two sites yields unrelated ids.
3. **What this means the owner can't know** — monthly unique visitors, cross-day
   conversion journeys, returning-visitor rates beyond a day. Owned as the design's
   point, not a bug ("the 20% of GA that 80% need" positioning). Known accuracy limits
   stated: shared IP + identical UA (offices, CGNAT) under-counts; VPN hopping
   over-counts.
4. **Where data lives** — the reader's own Cloudflare account (Workers Analytics Engine
   raw events, 90-day platform retention; D1 daily rollups thereafter). Skopia the
   project receives nothing. Retention numbers stated plainly.
5. **The tracking script** — 554 B gzipped, no cookies, respects the visitor entirely
   (nothing to opt out of because nothing identifying is kept). Link the script source.
6. **Source links block** — identity derivation, collector, salt storage, schema
   migration files. Direct GitHub URLs at a pinned path (`src/shared/identity.ts`,
   `src/collector/index.ts`, `migrations/`).
7. **Footer note** — invite scrutiny: "Read the code. Open an issue if we've described
   anything imprecisely." (This page's credibility is the product's.)

## Design constraints

- Same token palette as the homepage (ADR-0009 copy flow); prose-first layout, generous
  line length limits, monospace only for the formula and field lists.
- The formula block is the centerpiece — design it to be screenshot-able (it will be).
- No CTAs beyond a quiet footer link back to GitHub/deploy — this page persuades by not
  selling.

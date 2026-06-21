# 0003 — Query, rollup & sampling-honesty strategy

- **Date:** 2026-06-21
- **Status:** accepted
- **Owner:** cloudflare-tech-lead

## Context

The dashboard must be snappy and show **honest, exact-where-possible** numbers — the product is
sold on accuracy (product spec §7 Q1). But WAE **adaptive-samples** at high volume, queries must
correct via `_sample_interval`, CF itself warns `_sample_interval` alone doesn't confirm accuracy,
WAE SQL has **no JOIN/UNION** and an undocumented rate limit (429s), and ~0.5–2 s cold latency.
We cannot hit WAE SQL on every dashboard load. We need a query/rollup/caching strategy and a
sampling-honesty mechanism.

## Decision

**Pre-aggregate with a Cron Worker into exact D1 rollups; cache in KV; use WAE SQL only for
ad-hoc/today windows; badge sampled rows honestly.**

- **Cron Worker** runs every 5 min (finished days) and ~1 min (current partial day): queries WAE
  with sampling-correct SQL (`SUM(_sample_interval)` for counts, `SUM(_sample_interval*x)` for
  weighted sums), `GROUP BY` each dimension, and **upserts exact aggregates into D1
  `rollup_daily`**. Salt rotation runs in the daily pass.
- **Dashboard reads D1** (often via **KV** cache, 60–120 s TTL) for any finalized window — sub-10 ms
  (KV) / <100 ms (D1). It reads **WAE SQL** only for today's partial window and rare custom ad-hoc
  queries, debounced 300–500 ms.
- **Sampling-honesty (PM's preferred option (b)):** each Cron pass also runs a raw, uncorrected
  `count()` and compares it to the full-resolution ceiling for the window. If below → sampling
  occurred → set `sampled=true` on that rollup row. The dashboard shows a **"~ estimated" badge
  only on sampled rows.** This is **per Cron pass, not per dashboard load** → effectively free.
- **Caching uses KV, not the Cache API** (per-PoP, and disabled behind Access). KV also stores the
  daily salt.

## Alternatives considered

**A. Query WAE SQL live on every load.** Simplest, but rate-limited (429s), slow cold, and sampled
at volume → can't promise exact numbers. Rejected as the primary path.

**B. Rollups but skip the validation check; trust `_sample_interval` correction.** Cheaper by one
aggregate, but CF warns `_sample_interval` alone doesn't tell you if results are accurate — we'd be
unable to *honestly* badge. Rejected; the extra `count()` is the cheap honesty mechanism the
product requires.

**C. Per-metric live "~ estimated" badge driven by a row `count()` on every dashboard query (PM's
option (a)).** Honest, but runs the check on the read path (latency + WAE rate-limit pressure).
Rejected in favor of (b) — same honesty, moved to the Cron where it's free.

**D. Cache API instead of KV.** Per-PoP only (no global consistency) and disabled behind Access.
Rejected.

## Consequences

**Easy:** exact numbers for the common case (personas run far below sampling onset → rollups are
exact, full stop), fast dashboard, bounded staleness (one Cron interval + KV TTL), honest badging
only where warranted, no Cache-API/Access conflict.

**Hard / watch:** the Cron is a dependency to keep healthy (a stalled Cron = stale dashboard). WAE
SQL's **no-JOIN** constraint shapes the rollup as per-dimension `GROUP BY` queries, not joins (fine
— and note: the JOIN/UNION support visible in CF docs is **R2 SQL**, a different engine, not WAE).
The undocumented SQL rate limit is mitigated by debounce + serving from D1/KV; if CF tightens it we
lean harder on rollups. The ~100 dp/s/index sampling onset is order-of-magnitude (⚠️) — the badge,
not a hard guarantee, is the honest contract.

-- Drop the Phase-1 parallel-run shadow table (ADR-0011 shadow-drop follow-up).
-- At the Phase-2 cutover (ADR-0011, 2026-07-04) the SiteLive DO became the sole
-- writer of rollup_daily; rollup_daily_shadow has had no reader or writer since.
-- Added as a NEW migration (not a rewrite of 0002) so the live deployment that
-- already applied 0002 replays 0002 -> 0003 in order. Idempotent per the
-- ensureSchema cold-replay contract (scripts/build-schema.mjs).
DROP TABLE IF EXISTS rollup_daily_shadow;

-- Phase-1 parallel-run target for the DO incremental rollup
-- (docs/specs/2026-06-29-do-incremental-counters-design.md §9). Identical shape
-- to rollup_daily. Superseded at the Phase-2 cutover (ADR-0011): the DO became
-- the sole writer of rollup_daily and this table was dropped by
-- migrations/0003_drop_rollup_shadow.sql. Retained here as append-only history.
CREATE TABLE IF NOT EXISTS rollup_daily_shadow (
  site_id   TEXT NOT NULL,
  day       TEXT NOT NULL,
  dimension TEXT NOT NULL,
  dim_value TEXT NOT NULL DEFAULT '',
  pageviews INTEGER NOT NULL DEFAULT 0,
  visitors  INTEGER NOT NULL DEFAULT 0,
  sampled   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, dimension, dim_value)
);

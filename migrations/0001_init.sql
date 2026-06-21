-- Skopia D1 schema — initial migration.
-- Source of truth: docs/specs/2026-06-21-technical-spec.md §4.2.
--
-- The hot path (collector) NEVER writes here. Metadata is written by the
-- dashboard (site CRUD, owner setup); rollups are written by the cron Worker.
-- Auth is stateless signed cookies (spec §7.2) — there is no server-side
-- session table; `users` holds the salted password hash and that is all the
-- persistent auth state required.

-- Sites tracked by this deployment. Multi-site in one deploy (spec §8 item 8):
-- each site has its own WAE index value (`id`), CORS origin allowlist, and a
-- read-only public-dashboard token (spec §7.1).
CREATE TABLE IF NOT EXISTS sites (
  id               TEXT PRIMARY KEY,                       -- site_id; the WAE index value
  name             TEXT NOT NULL,
  domain           TEXT NOT NULL DEFAULT '',
  origin_allowlist TEXT NOT NULL DEFAULT '',               -- comma-separated origins for CORS (spec §3.1)
  public_token     TEXT,                                   -- per-site read-only share token (spec §7.1); NULL = private
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_public_token
  ON sites (public_token) WHERE public_token IS NOT NULL;

-- Owner account(s). Single-owner in MVP (1 row), but modeled as a table so
-- multi-user is a non-breaking addition later. PBKDF2 hash via Web Crypto
-- (spec §7.2). `role` reserved for future RBAC.
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Custom-event / conversion goal definitions (spec §4.2). A goal matches stored
-- `event_name` rows; funnels (fast-follow) are ordered sequences of these.
CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  match_type  TEXT NOT NULL,                               -- 'event' | 'path' | 'path_prefix'
  match_value TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_goals_site ON goals (site_id);

-- Exact daily aggregates, long/EAV-style (spec §4.2). Written by the cron via
-- idempotent upsert; read by the dashboard for every finalized window.
--   dimension ∈ {total, page, referrer, utm_source, utm_medium, utm_campaign,
--                country, device, browser, os, event}
--   dim_value  = '' for the `total` dimension; otherwise the bucket value.
--   sampled    = 1 when WAE adaptive sampling was detected for this (site, day)
--                via the count() check (spec §5.1); drives the "~ estimated" badge.
CREATE TABLE IF NOT EXISTS rollup_daily (
  site_id   TEXT NOT NULL,
  day       TEXT NOT NULL,                                 -- UTC 'YYYY-MM-DD'
  dimension TEXT NOT NULL,
  dim_value TEXT NOT NULL DEFAULT '',
  pageviews INTEGER NOT NULL DEFAULT 0,
  visitors  INTEGER NOT NULL DEFAULT 0,
  sampled   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, dimension, dim_value)
);

CREATE INDEX IF NOT EXISTS idx_rollup_lookup
  ON rollup_daily (site_id, dimension, day);

-- Seed one site so the walking skeleton has a target out of the box.
INSERT OR IGNORE INTO sites (id, name, domain) VALUES ('default', 'My Site', '');

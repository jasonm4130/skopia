/**
 * Tests for src/shared/schema.ts
 *
 * Coverage:
 * - ensureSchema creates all expected tables on a FRESH D1 (no migrations applied)
 * - Tables present: sites, users, goals, rollup_daily
 * - ensureSchema is idempotent (calling twice does not error)
 *
 * IMPORTANT: This test does NOT import apply-migrations (test/apply-migrations.ts).
 * The D1 starts empty — that is the whole point. ensureSchema must bootstrap
 * the schema from scratch via the embedded SCHEMA_SQL.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/shared/schema";

describe("ensureSchema", () => {
  it("creates all expected tables on a fresh (empty) D1", async () => {
    // Drop any tables that may exist from a previous test run in the same isolate
    // (defensive — in practice each test file gets isolated storage).
    const existingBefore = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all<{ name: string }>();
    for (const row of existingBefore.results) {
      await env.DB.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
    }

    await ensureSchema(env.DB);

    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();

    const tableNames = result.results.map((r) => r.name);
    expect(tableNames).toContain("sites");
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("goals");
    expect(tableNames).toContain("rollup_daily");
  });

  it("is idempotent: calling ensureSchema twice does not throw", async () => {
    // ensureSchema is cached per isolate, so the second call is a no-op.
    // This test verifies it doesn't throw on a second await.
    await expect(ensureSchema(env.DB)).resolves.toBeUndefined();
    await expect(ensureSchema(env.DB)).resolves.toBeUndefined();
  });

  it("the sites table has the expected columns", async () => {
    await ensureSchema(env.DB);
    const info = await env.DB.prepare("PRAGMA table_info(sites)").all<{
      name: string;
    }>();
    const cols = info.results.map((r) => r.name);
    expect(cols).toContain("id");
    expect(cols).toContain("name");
    expect(cols).toContain("domain");
    expect(cols).toContain("origin_allowlist");
    expect(cols).toContain("public_token");
    expect(cols).toContain("created_at");
  });

  it("the users table has the expected columns", async () => {
    await ensureSchema(env.DB);
    const info = await env.DB.prepare("PRAGMA table_info(users)").all<{
      name: string;
    }>();
    const cols = info.results.map((r) => r.name);
    expect(cols).toContain("id");
    expect(cols).toContain("email");
    expect(cols).toContain("pw_hash");
    expect(cols).toContain("role");
    expect(cols).toContain("created_at");
  });

  it("the rollup_daily table has the expected columns", async () => {
    await ensureSchema(env.DB);
    const info = await env.DB.prepare("PRAGMA table_info(rollup_daily)").all<{
      name: string;
    }>();
    const cols = info.results.map((r) => r.name);
    expect(cols).toContain("site_id");
    expect(cols).toContain("day");
    expect(cols).toContain("dimension");
    expect(cols).toContain("dim_value");
    expect(cols).toContain("pageviews");
    expect(cols).toContain("visitors");
    expect(cols).toContain("sampled");
  });
});

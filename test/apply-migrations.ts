// Applies the real D1 migrations (migrations/0001_init.sql) to the test `env.DB`.
//
// D1's `env.DB.exec()` runs one statement per newline, so it chokes on the
// multi-line CREATE TABLE statements in the migration file. The supported path
// is `applyD1Migrations`, fed by `readD1Migrations` (run in Node at config time
// in vitest.config.ts and passed through as the serialized TEST_MIGRATIONS
// binding). Call this in each suite's `beforeAll` before seeding.
import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";

let applied: Promise<void> | undefined;

export function applyMigrations(): Promise<void> {
  if (!applied) {
    const migrations = JSON.parse(env.TEST_MIGRATIONS) as D1Migration[];
    applied = applyD1Migrations(env.DB, migrations);
  }
  return applied;
}

/**
 * Skopia — cold-account D1 bootstrap (foundation-owned).
 *
 * Auto-provisioning (the Deploy button) creates an EMPTY D1; it never runs
 * `migrations/`. {@link ensureSchema} applies the embedded schema idempotently
 * (every statement is `CREATE … IF NOT EXISTS` / `INSERT OR IGNORE`), so the
 * first dashboard/setup read against a fresh database does not 500. Cached per
 * isolate via a module-level promise so concurrent requests share one bootstrap
 * and it runs at most once per isolate; safe to `await` on every request.
 */

import { SCHEMA_SQL } from "./schema-embed";

/**
 * Per-isolate latch keyed on the D1 binding identity. In production there is a
 * single DB per isolate so this behaves as a one-shot promise; keying on the DB
 * object also keeps tests (and any future multi-DB caller) correct — a different
 * DB instance gets its own bootstrap rather than reusing the first DB's result.
 */
const ready = new WeakMap<D1Database, Promise<void>>();

/**
 * Split the multi-statement schema into individual statements. `db.exec` is
 * line-oriented and rejects the commented, multi-line DDL in the migration, so
 * we strip SQL line comments and split on `;`, then `db.batch()` the prepared
 * statements in one round-trip.
 */
function statements(): string[] {
  return SCHEMA_SQL.split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Idempotently creates all tables/indexes (and the seed row). Cached per
 * isolate; safe to call on every request before the first D1 read.
 */
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db);
  if (pending === undefined) {
    pending = (async () => {
      const stmts = statements().map((sql) => db.prepare(sql));
      await db.batch(stmts);
    })().catch((err) => {
      // Don't cache a failed bootstrap — let the next request retry.
      ready.delete(db);
      throw err;
    });
    ready.set(db, pending);
  }
  return pending;
}

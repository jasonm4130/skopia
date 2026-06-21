/**
 * Stratus — rollup cron (WAE -> D1 exact aggregates).
 *
 * Runs on the cron trigger (spec §5.1): query WAE with sampling-correct SQL,
 * GROUP BY each dimension, upsert exact aggregates into `rollup_daily`, set the
 * `sampled` flag via the count() check, and rotate the daily salt on the first
 * pass after UTC midnight. Foundation provides the typed entry; the BACKBONE
 * agent implements the body.
 */

import type { Env } from "../shared/types";

/**
 * Run one rollup pass over the retention window. The optional `fetcher` is
 * injected in tests to stub the external WAE SQL HTTP API (it is not a binding).
 */
export async function runRollups(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  void env, void fetcher;
  throw new Error("not implemented");
}

/** The Worker `scheduled()` handler — invokes {@link runRollups} via waitUntil. */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  void controller, void env, void ctx;
  throw new Error("not implemented");
}

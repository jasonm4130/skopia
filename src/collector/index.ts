/**
 * Stratus — collector (the ingestion hot path).
 *
 * Routed at `OPTIONS /e` (CORS preflight) and `POST /e` (beacon). Pipeline per
 * the spec §3: CORS allowlist -> validate -> bot drop -> enrich -> cookieless
 * identity -> `WAE.writeDataPoint` -> bump SiteLive DO via waitUntil -> 204.
 *
 * Foundation provides the typed entry; the COLLECTOR agent implements the body.
 */

import type { Env } from "../shared/types";

/** Answer the CORS preflight for `OPTIONS /e`. */
export function handlePreflight(request: Request, env: Env): Response {
  void request, void env;
  throw new Error("not implemented");
}

/** Handle a `POST /e` beacon: validate, enrich, identity, WAE write, live bump. */
export async function handleCollect(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  void request, void env, void ctx;
  throw new Error("not implemented");
}

/** Skopia — the dashboard's Hono env type. */

import type { AppEnv } from "../shared/security-headers";

// Dashboard env = the root AppEnv (Bindings + per-request nonce) plus the
// userId set by requireAuth. Keeps `c.get("nonce")` typed from the shared
// middleware while preserving the auth variable.
export type DashEnv = {
  Bindings: AppEnv["Bindings"];
  Variables: AppEnv["Variables"] & { userId: number };
};

// Pulls in the `cloudflare:test` module types (env, createExecutionContext,
// waitOnExecutionContext, etc.) for the Workers Vitest pool. Feature agents'
// test files rely on this ambient reference.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as StratusEnv } from "../src/shared/types";

// `cloudflare:test` types the exported `env` as `Cloudflare.Env` (the global
// wrangler normally generates into worker-configuration.d.ts). That generated
// file is gitignored and is NOT produced by `npm run ci`, so we declare
// `Cloudflare.Env` here from our committed contract instead. This keeps the
// typed test `env` in lockstep with src/shared/types.ts `Env` — the single
// source of truth — including the secrets injected via the Miniflare bindings
// override in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env extends StratusEnv {
      /** Serialized D1 migrations injected by vitest.config.ts (test-only). */
      TEST_MIGRATIONS: string;
    }
  }
}

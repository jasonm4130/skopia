// Pulls in the `cloudflare:test` module types (env, createExecutionContext,
// waitOnExecutionContext, etc.) for the Workers Vitest pool. Feature agents'
// test files rely on this ambient reference.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Type the `env` exposed by `cloudflare:test` to our Worker's Env so tests get
// fully-typed bindings.
declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface ProvidedEnv extends import("../src/shared/types").Env {}
}

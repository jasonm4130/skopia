import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// @cloudflare/vitest-pool-workers v0.16+ (Vitest 4) is configured as a Vite
// plugin via `cloudflareTest(...)`, replacing the old
// `test.poolOptions.workers` + `defineWorkersConfig` API.
export default defineConfig({
  // Feature agents add/remove test files freely; an empty suite must not fail CI.
  test: { passWithNoTests: true },
  plugins: [
    cloudflareTest({
      // Reuse the production binding topology from wrangler.jsonc so tests run
      // against the real WAE / D1 / KV / DO bindings simulated by Miniflare.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only secret + var overrides. Real secrets are set via
        // `wrangler secret put` and are never committed.
        bindings: {
          IDENTITY_HMAC_SECRET: "test-identity-secret",
          AUTH_COOKIE_SECRET: "test-cookie-secret",
          CF_ACCOUNT_ID: "test-account",
          WAE_API_TOKEN: "test-token",
          RETENTION_DAYS: "90",
        },
      },
    }),
  ],
});

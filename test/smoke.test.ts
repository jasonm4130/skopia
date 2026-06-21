import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// Foundation smoke test: proves the Workers Vitest pool, the wrangler.jsonc
// bindings (WAE / DB / KV / SITE_LIVE), and the SiteLive DO migration all load,
// and that the Worker entry serves its one non-stub route. Feature agents build
// their TDD suites on top of this wiring.
describe("foundation smoke", () => {
  it("serves /health", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://stratus.test/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

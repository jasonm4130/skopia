import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CountEvent } from "../src/dashboard/event-dimensions";
import { utcDay } from "../src/shared/identity";
import { applyMigrations } from "./apply-migrations";

function utcDayUTC(): string {
  return utcDay(new Date());
}

beforeAll(async () => {
  await applyMigrations();
  await env.DB.prepare("INSERT OR IGNORE INTO sites (id, name, domain) VALUES (?, ?, ?)")
    .bind("do-site", "DO Site", "do.example.com")
    .run();
});

function evt(overrides: Partial<CountEvent> = {}): CountEvent {
  return {
    siteId: "do-site",
    vid: "vid-aaaa",
    isPageview: 1,
    path: "/x",
    referrer: "",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    country: "GB",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    eventName: "",
    ...overrides,
  };
}

// Distinct DO id per test keeps SQLite + RAM isolated.
function stubFor(name: string) {
  return env.SITE_LIVE.get(env.SITE_LIVE.idFromName(name));
}

describe("SiteLive.recordEvent", () => {
  it("accumulates pending pageview deltas and writes the seen set", async () => {
    const stub = stubFor("rec-1");
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        pending: Map<string, { dimension: string; dimValue: string; delta: number }>;
        ctx: { storage: { sql: { exec(q: string, ...b: unknown[]): { one(): { c: number } } } } };
      };
      await i.recordEvent(evt({ vid: "v1", path: "/a" }));
      await i.recordEvent(evt({ vid: "v1", path: "/a" })); // same visitor, same page
      await i.recordEvent(evt({ vid: "v2", path: "/a" })); // new visitor, same page

      // total: 3 pageviews; page:/a: 3 pageviews
      const total = [...i.pending.values()].find((p) => p.dimension === "total");
      const page = [...i.pending.values()].find(
        (p) => p.dimension === "page" && p.dimValue === "/a",
      );
      expect(total?.delta).toBe(3);
      expect(page?.delta).toBe(3);

      // seen distinct visitors for page:/a = 2 (v1, v2)
      const c = i.ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM seen WHERE dimension = ? AND dim_value = ?", "page", "/a")
        .one().c;
      expect(c).toBe(2);
    });
  });

  it("custom events add to seen but contribute 0 pageviews to pageview dims", async () => {
    const stub = stubFor("rec-2");
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        pending: Map<string, { dimension: string; dimValue: string; delta: number }>;
      };
      await i.recordEvent(evt({ vid: "v1", isPageview: 0, eventName: "signup" }));
      const total = [...i.pending.values()].find((p) => p.dimension === "total");
      const ev = [...i.pending.values()].find((p) => p.dimension === "event");
      expect(total?.delta).toBe(0); // not a pageview
      expect(ev?.delta).toBe(1); // event counted
    });
  });
});

describe("SiteLive.flush", () => {
  it("upserts pageviews additively and visitors absolutely from seen", async () => {
    const stub = stubFor("flush-1");
    const day = utcDayUTC();
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        flush(): Promise<void>;
      };
      await i.recordEvent(evt({ vid: "v1", path: "/p" }));
      await i.recordEvent(evt({ vid: "v2", path: "/p" }));
      await i.flush(); // pageviews 2, visitors 2 for page:/p
      await i.recordEvent(evt({ vid: "v1", path: "/p" })); // returning visitor, +1 pv
      await i.flush(); // pageviews 3 total, visitors still 2
    });

    const row = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily_shadow WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/p'",
    )
      .bind("do-site", day)
      .first<{ pageviews: number; visitors: number }>();
    expect(row?.pageviews).toBe(3); // additive across two flushes
    expect(row?.visitors).toBe(2); // absolute from seen, no double-count
  });

  it("clears pending after a successful flush (second flush is a no-op)", async () => {
    const stub = stubFor("flush-2");
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        flush(): Promise<void>;
        pending: Map<string, unknown>;
      };
      await i.recordEvent(evt({ vid: "v1" }));
      await i.flush();
      expect(i.pending.size).toBe(0);
    });
  });
});

describe("SiteLive day rollover", () => {
  it("flushes the old day, resets seen, and clears pending on rollover", async () => {
    const stub = stubFor("roll-1");
    const day1 = "2026-06-28";
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        maybeRollover(newDay: string): Promise<void>;
        pending: Map<string, unknown>;
        currentDay: string | null;
        siteId: string | null;
        ctx: { storage: { sql: { exec(q: string, ...b: unknown[]): { one(): { c: number } } } } };
      };
      // Seed "yesterday" by recording then forcing currentDay back to day1.
      await i.recordEvent(evt({ vid: "v1", path: "/old" }));
      i.currentDay = day1;
      i.siteId = "do-site";

      await i.maybeRollover("2026-06-29"); // cross midnight

      // old day flushed to shadow
      // pending cleared, seen emptied
      expect(i.pending.size).toBe(0);
      const seenCount = i.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM seen").one().c;
      expect(seenCount).toBe(0);
    });

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily_shadow WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind("do-site", day1)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1); // the day1 pageview was flushed under day1
  });
});

describe("SiteLive /event + alarm", () => {
  it("POST /event updates the live map and records counters in one call", async () => {
    const stub = stubFor("ev-1");
    const body = JSON.stringify(evt({ vid: "v1", path: "/home" }));
    const res = await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(204);

    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        visitors: Map<string, unknown>;
        pending: Map<string, unknown>;
      };
      expect(i.visitors.size).toBe(1); // live map updated
      expect(i.pending.size).toBeGreaterThan(0); // counters recorded
    });
  });

  it("alarm flushes pending counters to the shadow table", async () => {
    const stub = stubFor("ev-2");
    const day = utcDayUTC();
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Distinct site_id: rollup_daily_shadow is a shared D1 table and the
      // flush UPSERT is additive, so reusing "do-site" would accumulate other
      // tests' pageviews into this row. A per-test site_id isolates the assert.
      body: JSON.stringify(evt({ vid: "v1", path: "/a", siteId: "ev2-site" })),
    });
    await runDurableObjectAlarm(stub); // fire the scheduled flush+evict tick

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily_shadow WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind("ev2-site", day)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1);
  });
});

// Regression for the Phase-1 parity failure (ADR-0010): `pending`, `siteId` and
// `currentDay` were RAM-only, so a Hibernation-API sleep (~10s) between the event
// and the 15s flush alarm discarded un-flushed pageview deltas — the alarm then
// cold-started an empty instance and flushed nothing. The fix persists the flush
// state durably every event and rehydrates it on construction.
describe("SiteLive durability across hibernation", () => {
  it("persists flush state to durable storage on every event", async () => {
    const stub = stubFor("dur-1");
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        ctx: { storage: { get(k: string): Promise<unknown> } };
      };
      await i.recordEvent(evt({ vid: "v1", path: "/a", siteId: "dur1-site" }));
      const state = (await i.ctx.storage.get("flushstate")) as
        | {
            siteId: string;
            currentDay: string;
            pending: Map<string, { dimension: string; delta: number }>;
          }
        | undefined;
      expect(state).toBeDefined();
      expect(state?.siteId).toBe("dur1-site");
      const total = [...(state?.pending.values() ?? [])].find((p) => p.dimension === "total");
      expect(total?.delta).toBe(1);
    });
  });

  it("rehydrates from durable storage after RAM loss and flushes the full count", async () => {
    const stub = stubFor("dur-2");
    const day = utcDayUTC();
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        rehydrate(): Promise<void>;
        flush(): Promise<void>;
        pending: Map<string, unknown>;
        siteId: string | null;
        currentDay: string | null;
      };
      await i.recordEvent(evt({ vid: "v1", path: "/p", siteId: "dur2-site" }));
      await i.recordEvent(evt({ vid: "v2", path: "/p", siteId: "dur2-site" }));
      // Simulate a Hibernation-API sleep: the runtime discards all in-memory state.
      i.pending = new Map();
      i.siteId = null;
      i.currentDay = null;
      // Cold start: the constructor's rehydration path restores from durable storage.
      await i.rehydrate();
      expect(i.pending.size).toBeGreaterThan(0);
      expect(i.siteId).toBe("dur2-site");
      await i.flush();
    });

    const row = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily_shadow WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/p'",
    )
      .bind("dur2-site", day)
      .first<{ pageviews: number; visitors: number }>();
    expect(row?.pageviews).toBe(2); // no lost pageviews
    expect(row?.visitors).toBe(2);
  });

  it("clears durable flush state after flush so a re-rehydrated cold start does not double-count", async () => {
    const stub = stubFor("dur-3");
    const day = utcDayUTC();
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        rehydrate(): Promise<void>;
        flush(): Promise<void>;
        pending: Map<string, unknown>;
        siteId: string | null;
        currentDay: string | null;
        ctx: { storage: { get(k: string): Promise<unknown> } };
      };
      await i.recordEvent(evt({ vid: "v1", path: "/p", siteId: "dur3-site" }));
      await i.flush(); // writes pv=1, must also clear the durable flush state
      expect(await i.ctx.storage.get("flushstate")).toBeUndefined();
      // A later cold start must find nothing to re-flush.
      i.pending = new Map();
      i.siteId = null;
      i.currentDay = null;
      await i.rehydrate();
      await i.flush(); // no-op — the durable state was cleared
    });

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily_shadow WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind("dur3-site", day)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1); // NOT 2 — the flushed delta was not re-applied
  });
});

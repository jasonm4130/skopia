import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CountEvent } from "../src/dashboard/event-dimensions";
import type { SiteLive } from "../src/dashboard/site-live";
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
    day: utcDayUTC(),
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
  return env.SITE_LIVE.get(env.SITE_LIVE.idFromName(name)) as DurableObjectStub<SiteLive>;
}

/**
 * Give a DO a salt row for each day, as the collector's getSalt would first:
 * recordEvent accepts only days holding a salt here (ADR-0013 §1a).
 */
function seedSalt(instance: unknown, ...days: string[]): void {
  const { sql } = (instance as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage;
  for (const d of days.length > 0 ? days : [utcDayUTC()]) {
    sql.exec("INSERT OR IGNORE INTO salt (day, salt) VALUES (?, ?)", d, "test-salt");
  }
}

describe("SiteLive.recordEvent", () => {
  it("accumulates pending pageview deltas and writes the seen set", async () => {
    const stub = stubFor("rec-1");
    await runInDurableObject(stub, async (instance) => {
      seedSalt(instance);
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
      seedSalt(instance);
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
      seedSalt(instance);
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
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/p'",
    )
      .bind("do-site", day)
      .first<{ pageviews: number; visitors: number }>();
    expect(row?.pageviews).toBe(3); // additive across two flushes
    expect(row?.visitors).toBe(2); // absolute from seen, no double-count
  });

  it("clears pending after a successful flush (second flush is a no-op)", async () => {
    const stub = stubFor("flush-2");
    await runInDurableObject(stub, async (instance) => {
      seedSalt(instance);
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

// Day-scoped pending (Task 1): rows carry their own `day`, so a UTC midnight
// crossing needs no special-case flush. Old-day and new-day deltas simply flush
// together on the next alarm, which removes the rollover race (double-count /
// wipe) and the rollover-discard-on-failed-flush bug by construction.
describe("SiteLive day rollover", () => {
  it("accumulates across midnight and flushes both days in a single alarm", async () => {
    const stub = stubFor("roll-cross");
    const site = "roll-cross-site";
    const d0 = "2026-06-28";
    const d1 = "2026-06-29";
    vi.useFakeTimers();
    try {
      await runInDurableObject(stub, async (instance) => {
        seedSalt(instance, d0, d1);
        const i = instance as unknown as {
          recordEvent(e: CountEvent): Promise<void>;
          alarm(): Promise<void>;
          pending: Map<string, unknown>;
          ctx: { storage: { sql: { exec(q: string, ...b: unknown[]): { one(): { c: number } } } } };
        };
        vi.setSystemTime(new Date(`${d0}T12:00:00Z`));
        await i.recordEvent(evt({ vid: "v1", path: "/a", siteId: site }));
        await i.recordEvent(evt({ vid: "v2", path: "/a", siteId: site }));
        vi.setSystemTime(new Date(`${d1}T00:30:00Z`));
        await i.recordEvent(evt({ vid: "v3", path: "/a", siteId: site }));

        await i.alarm(); // one alarm drains BOTH days

        expect(i.pending.size).toBe(0);
        // D0 seen rows pruned once the D1-day prune runs; D1 seen kept.
        const d0Seen = i.ctx.storage.sql
          .exec("SELECT COUNT(*) AS c FROM seen WHERE day = ?", d0)
          .one().c;
        const d1Seen = i.ctx.storage.sql
          .exec(
            "SELECT COUNT(*) AS c FROM seen WHERE day = ? AND dimension = ? AND dim_value = ?",
            d1,
            "page",
            "/a",
          )
          .one().c;
        expect(d0Seen).toBe(0);
        expect(d1Seen).toBe(1);
      });
    } finally {
      vi.useRealTimers();
    }

    const r0 = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/a'",
    )
      .bind(site, d0)
      .first<{ pageviews: number; visitors: number }>();
    const r1 = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/a'",
    )
      .bind(site, d1)
      .first<{ pageviews: number; visitors: number }>();
    expect(r0?.pageviews).toBe(2); // D0 pageviews, flushed a day late — no loss
    expect(r0?.visitors).toBe(2);
    expect(r1?.pageviews).toBe(1); // D1 pageviews, same flush
    expect(r1?.visitors).toBe(1);
  });

  it("retains data when a midnight flush fails, then flushes cleanly on retry", async () => {
    const stub = stubFor("roll-fail");
    const site = "roll-fail-site";
    const d0 = "2026-06-28";
    const d1 = "2026-06-29";
    vi.useFakeTimers();
    try {
      await runInDurableObject(stub, async (instance) => {
        seedSalt(instance, d0, d1);
        const i = instance as unknown as {
          recordEvent(e: CountEvent): Promise<void>;
          alarm(): Promise<void>;
          pending: Map<string, unknown>;
        };
        vi.setSystemTime(new Date(`${d0}T12:00:00Z`));
        await i.recordEvent(evt({ vid: "v1", path: "/a", siteId: site }));

        // Fail the FIRST flush batch (the post-midnight one); the retry succeeds.
        const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(() => {
          throw new Error("boom");
        });
        try {
          vi.setSystemTime(new Date(`${d1}T00:30:00Z`));
          await i.recordEvent(evt({ vid: "v2", path: "/a", siteId: site }));

          await i.alarm(); // flush throws → nothing lost, nothing pruned
          expect(i.pending.size).toBeGreaterThan(0); // both days still owed
          await i.alarm(); // retry succeeds
          expect(i.pending.size).toBe(0);
        } finally {
          spy.mockRestore();
        }
      });
    } finally {
      vi.useRealTimers();
    }

    const r0 = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/a'",
    )
      .bind(site, d0)
      .first<{ pageviews: number; visitors: number }>();
    const r1 = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/a'",
    )
      .bind(site, d1)
      .first<{ pageviews: number; visitors: number }>();
    expect(r0?.pageviews).toBe(1); // no loss on the failed-then-retried day
    expect(r0?.visitors).toBe(1);
    expect(r1?.pageviews).toBe(1); // no double-count
    expect(r1?.visitors).toBe(1);
  });

  it("migrates a legacy v1 flush blob (2-part keys + currentDay) on cold start", async () => {
    const stub = stubFor("roll-legacy");
    const site = "roll-legacy-site";
    const legacyDay = "2026-06-20";
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        rehydrate(): Promise<void>;
        flush(): Promise<void>;
        pending: Map<string, { day: string; dimension: string; delta: number }>;
        siteId: string | null;
        ctx: { storage: { put(k: string, v: unknown): Promise<void> } };
      };
      // Seed a v1-shaped durable blob: no `v`, one currentDay, 2-part keys.
      // Legacy pendingKey joined (dimension, dim_value) with U+0001; build it
      // at runtime so no control byte lands in this source file.
      const SEP = String.fromCharCode(1);
      const legacyPending = new Map<
        string,
        { dimension: string; dimValue: string; delta: number }
      >();
      legacyPending.set(`total${SEP}`, { dimension: "total", dimValue: "", delta: 5 });
      legacyPending.set(`page${SEP}/legacy`, { dimension: "page", dimValue: "/legacy", delta: 5 });
      await i.ctx.storage.put("flushstate", {
        siteId: site,
        currentDay: legacyDay,
        pending: legacyPending,
      });

      // Cold start: RAM reset then rehydrate (the constructor's path).
      i.pending = new Map();
      i.siteId = null;
      await i.rehydrate();

      expect(i.siteId).toBe(site);
      const total = [...i.pending.values()].find((p) => p.dimension === "total");
      expect(total?.day).toBe(legacyDay); // remapped to a day-scoped row
      await i.flush();
    });

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind(site, legacyDay)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(5); // deltas landed under the legacy currentDay
  });
});

describe("SiteLive /event + alarm", () => {
  it("POST /event updates the live map and records counters in one call", async () => {
    const stub = stubFor("ev-1");
    await stub.getSalt(utcDayUTC());
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
    await stub.getSalt(utcDayUTC());
    const day = utcDayUTC();
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Distinct site_id: rollup_daily is a shared D1 table and the
      // flush UPSERT is additive, so reusing "do-site" would accumulate other
      // tests' pageviews into this row. A per-test site_id isolates the assert.
      body: JSON.stringify(evt({ vid: "v1", path: "/a", siteId: "ev2-site" })),
    });
    await runDurableObjectAlarm(stub); // fire the scheduled flush+evict tick

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind("ev2-site", day)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1);
  });
});

// Regression for the Phase-1 parity failure (ADR-0010): `pending` and `siteId`
// were RAM-only, so a Hibernation-API sleep (~10s) between the event and the 15s
// flush alarm discarded un-flushed pageview deltas — the alarm then cold-started
// an empty instance and flushed nothing. The fix persists the flush state durably
// every event and rehydrates it on construction.
describe("SiteLive durability across hibernation", () => {
  it("persists flush state to durable storage on every event", async () => {
    const stub = stubFor("dur-1");
    await runInDurableObject(stub, async (instance) => {
      seedSalt(instance);
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        ctx: { storage: { get(k: string): Promise<unknown> } };
      };
      await i.recordEvent(evt({ vid: "v1", path: "/a", siteId: "dur1-site" }));
      const state = (await i.ctx.storage.get("flushstate")) as
        | {
            v: number;
            siteId: string;
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
      seedSalt(instance);
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        rehydrate(): Promise<void>;
        flush(): Promise<void>;
        pending: Map<string, unknown>;
        siteId: string | null;
      };
      await i.recordEvent(evt({ vid: "v1", path: "/p", siteId: "dur2-site" }));
      await i.recordEvent(evt({ vid: "v2", path: "/p", siteId: "dur2-site" }));
      // Simulate a Hibernation-API sleep: the runtime discards all in-memory state.
      i.pending = new Map();
      i.siteId = null;
      // Cold start: the constructor's rehydration path restores from durable storage.
      await i.rehydrate();
      expect(i.pending.size).toBeGreaterThan(0);
      expect(i.siteId).toBe("dur2-site");
      await i.flush();
    });

    const row = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/p'",
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
      seedSalt(instance);
      const i = instance as unknown as {
        recordEvent(e: CountEvent): Promise<void>;
        rehydrate(): Promise<void>;
        flush(): Promise<void>;
        pending: Map<string, unknown>;
        siteId: string | null;
        ctx: { storage: { get(k: string): Promise<unknown> } };
      };
      await i.recordEvent(evt({ vid: "v1", path: "/p", siteId: "dur3-site" }));
      await i.flush(); // writes pv=1, must also clear the durable flush state
      expect(await i.ctx.storage.get("flushstate")).toBeUndefined();
      // A later cold start must find nothing to re-flush.
      i.pending = new Map();
      i.siteId = null;
      await i.rehydrate();
      await i.flush(); // no-op — the durable state was cleared
    });

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind("dur3-site", day)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1); // NOT 2 — the flushed delta was not re-applied
  });
});

// Task 2: flush is subtractive (subtract-what-was-committed) and persists after
// EACH committed chunk. This fixes two additive-UPSERT hazards: (a) an event that
// interleaves during the D1 subrequest (the input gate stays OPEN across the
// await) must not be wiped by a clear-on-success; (b) a multi-chunk flush whose
// second chunk fails must not re-apply the already-committed first chunk on retry.
describe("SiteLive subtractive chunk-committed flush", () => {
  it("keeps an event that arrives while a flush batch is in flight (counted once)", async () => {
    const stub = stubFor("mf-1");
    const site = "mf-site";
    const day = utcDayUTC();

    // Defer the FIRST batch so an event can interleave during the await, exactly
    // as it can in production (D1 calls are subrequests; the DO input gate stays
    // open). Later calls run the real batch immediately.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const realBatch = env.DB.batch.bind(env.DB);
    let calls = 0;
    const spy = vi.spyOn(env.DB, "batch").mockImplementation(async (stmts) => {
      calls++;
      if (calls === 1) await gate;
      return realBatch(stmts);
    });

    try {
      await runInDurableObject(stub, async (instance) => {
        seedSalt(instance);
        const i = instance as unknown as {
          recordEvent(e: CountEvent): Promise<void>;
          flush(): Promise<void>;
          alarm(): Promise<void>;
        };
        await i.recordEvent(evt({ vid: "v1", path: "/a", siteId: site }));

        const flushing = i.flush(); // batch 1 blocks on the gate
        await i.recordEvent(evt({ vid: "v2", path: "/a", siteId: site })); // mid-flight
        releaseGate(); // let batch 1 commit
        await flushing; // subtracts only the bound delta; the mid-flight one survives

        await i.alarm(); // flushes the surviving mid-flight delta
      });
    } finally {
      spy.mockRestore();
    }

    const row = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind(site, day)
      .first<{ pageviews: number; visitors: number }>();
    expect(row?.pageviews).toBe(2); // both events counted exactly once (no loss)
    expect(row?.visitors).toBe(2); // v1 + v2, absolute from seen
  });

  it("retries only the uncommitted chunk after a partial batch failure (no double-count)", async () => {
    const stub = stubFor("cp-1");
    const site = "cp-site";
    const day = utcDayUTC();
    const N = 150; // 150 unique paths => >100 pending rows => two flush chunks

    const realBatch = env.DB.batch.bind(env.DB);
    let calls = 0;
    const spy = vi.spyOn(env.DB, "batch").mockImplementation((stmts) => {
      calls++;
      if (calls === 2) throw new Error("chunk 2 boom"); // fail the 2nd chunk, once
      return realBatch(stmts);
    });

    try {
      await runInDurableObject(stub, async (instance) => {
        seedSalt(instance);
        const i = instance as unknown as {
          recordEvent(e: CountEvent): Promise<void>;
          alarm(): Promise<void>;
          pending: Map<string, unknown>;
        };
        for (let n = 0; n < N; n++) {
          await i.recordEvent(evt({ vid: "v1", path: `/p${n}`, siteId: site }));
        }
        await i.alarm(); // chunk 1 commits + is subtracted; chunk 2 throws, stays owed
        expect(i.pending.size).toBeGreaterThan(0); // chunk 2 still pending
        await i.alarm(); // retries ONLY the surviving chunk-2 rows
        expect(i.pending.size).toBe(0);
      });
    } finally {
      spy.mockRestore();
    }

    // `total` is a chunk-1 row: committed once, never re-applied by the retry.
    const total = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind(site, day)
      .first<{ pageviews: number }>();
    expect(total?.pageviews).toBe(N);

    // A chunk-1 page (/p0) and a chunk-2 page (/p149) each land exactly once.
    const first = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/p0'",
    )
      .bind(site, day)
      .first<{ pageviews: number }>();
    const last = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily WHERE site_id=? AND day=? AND dimension='page' AND dim_value='/p149'",
    )
      .bind(site, day)
      .first<{ pageviews: number }>();
    expect(first?.pageviews).toBe(1);
    expect(last?.pageviews).toBe(1);
  });
});

// Task 3: live-visitor eviction is decoupled from the flush alarm (measured
// 2026-07-04: the alarm re-armed while `visitors.size > 0`, trailing up to ~20
// billed setAlarm row-writes per session regardless of event count). The alarm
// now reschedules on `pending.size > 0` alone; staleness is evicted lazily on
// read (`currentSnapshot()`), so the live count is still correct at every read.
describe("SiteLive alarm reschedule + lazy eviction (Task 3)", () => {
  it("does not re-arm the flush tick once nothing is pending, even with a live visitor connected", async () => {
    const stub = stubFor("alarm-tail-1");
    await stub.getSalt(utcDayUTC());
    const site = "alarm-tail-1-site";
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt({ vid: "v1", path: "/a", siteId: site })),
    });
    await runDurableObjectAlarm(stub); // flushes; pending empties; visitor still "live" in RAM

    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as {
        pending: Map<string, unknown>;
        visitors: Map<string, unknown>;
        ctx: { storage: { getAlarm(): Promise<number | null> } };
      };
      expect(i.pending.size).toBe(0);
      expect(i.visitors.size).toBe(1); // still live — nothing evicted it
      // No flush-tick tail: only the salt deadline stays armed (ADR-0013 §3).
      expect(await i.ctx.storage.getAlarm()).toBe(saltDeadline(utcDayUTC()));
    });
  });

  it("evicts a stale visitor lazily on snapshot, without any alarm having run", async () => {
    const stub = stubFor("lazy-evict-1");
    await stub.getSalt(utcDayUTC());
    const site = "lazy-evict-1-site";
    vi.useFakeTimers();
    try {
      await stub.fetch("https://do-internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evt({ vid: "v1", path: "/a", siteId: site })),
      });

      vi.advanceTimersByTime(6 * 60 * 1000); // past the 5-minute live TTL

      await runInDurableObject(stub, async (instance) => {
        const i = instance as unknown as {
          visitors: Map<string, unknown>;
          snapshot(): Promise<{ visitors: number }>;
        };
        expect(i.visitors.size).toBe(1); // still in RAM — no alarm has run to evict it
        const snap = await i.snapshot();
        expect(snap.visitors).toBe(0); // evicted lazily on read
        expect(i.visitors.size).toBe(0); // read-time eviction mutates the map
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Controller adjudication of the Task-3 plan-conflict (unbounded-growth-risk):
// a busy site with continuous events but no dashboard ever connected keeps the
// DO warm (no hibernation reset) and never calls currentSnapshot(), so lazy
// read-time eviction alone lets `visitors` grow unbounded. The alarm already
// fires on every flush for exactly that traffic pattern — it must sweep too.
describe("SiteLive alarm evicts stale visitors on the busy-site path", () => {
  it("prunes past-TTL visitors during a flush alarm with no dashboard connected", async () => {
    const stub = stubFor("alarm-sweep-1");
    await stub.getSalt(utcDayUTC());
    const site = "alarm-sweep-1-site";
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt({ vid: "v1", path: "/a", siteId: site })),
    });
    // Age v1 past VISITOR_TTL_MS (5 min) without faking global timers.
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as { visitors: Map<string, { lastSeen: number }> };
      const entry = i.visitors.get("v1");
      if (entry) entry.lastSeen = Date.now() - 6 * 60 * 1000;
    });
    // Fresh event keeps pending non-empty so the alarm has a reason to run.
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt({ vid: "v2", path: "/b", siteId: site })),
    });
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as { visitors: Map<string, unknown> };
      expect(i.visitors.has("v1")).toBe(false);
      expect(i.visitors.has("v2")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-0013: the SiteLive DO owns each site's daily identity salt.
// Tests drive the DO's clock through the injectable `clock` so day boundaries
// don't depend on whether fake timers reach DO code. Days are chosen in the
// real future so an armed salt-deadline alarm never fires on its own mid-test.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 10 * 60 * 1000;

/** A UTC day `n` days after the real today (keeps armed alarms in the future). */
function futureDay(n: number): string {
  return utcDay(new Date(Date.now() + n * DAY_MS));
}

function at(day: string, time: string): number {
  return Date.parse(`${day}T${time}Z`);
}

function saltDeadline(day: string): number {
  return at(day, "00:00:00") + DAY_MS + GRACE_MS;
}

type SaltSql = { exec(q: string, ...b: unknown[]): { one(): Record<string, unknown> } };
interface SaltInstance {
  getSalt(day: string): Promise<string>;
  clock: () => number;
  alarm(): Promise<void>;
  rearmOnWake(): Promise<void>;
  sweepSalts(now: number): void;
  recordEvent(e: CountEvent): Promise<void>;
  pending: Map<string, unknown>;
  ctx: {
    storage: {
      sql: SaltSql;
      getAlarm(): Promise<number | null>;
      deleteAlarm(): Promise<void>;
    };
  };
}

function saltRows(i: SaltInstance, day: string): number {
  return Number(
    i.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM salt WHERE day = ?", day).one().c,
  );
}

describe("SiteLive.getSalt (ADR-0013 §1)", () => {
  it("concurrent first fetches return one salt and store exactly one row", async () => {
    const stub = stubFor("salt-concurrent");
    const day = utcDayUTC();
    const salts = await Promise.all(Array.from({ length: 20 }, () => stub.getSalt(day)));
    expect(new Set(salts).size).toBe(1);
    expect(salts[0]).toMatch(/^[0-9a-f]{64}$/);
    await runInDurableObject(stub, (instance) => {
      expect(saltRows(instance as unknown as SaltInstance, day)).toBe(1);
    });
  });

  it("is per-site, and every isolate's stub for one site gets the same salt", async () => {
    const day = utcDayUTC();
    const a1 = await stubFor("salt-site-a").getSalt(day);
    const a2 = await stubFor("salt-site-a").getSalt(day); // a second isolate's fresh stub
    const b = await stubFor("salt-site-b").getSalt(day);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
  });

  it("mints a new salt after midnight while still serving the old day inside GRACE", async () => {
    const stub = stubFor("salt-rollover");
    const d = futureDay(2);
    const d1 = futureDay(3);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      i.clock = () => at(d, "23:59:00");
      const s0 = await i.getSalt(d);
      i.clock = () => at(d1, "00:00:01");
      const s1 = await i.getSalt(d1);
      expect(s1).not.toBe(s0);
      expect(await i.getSalt(d)).toBe(s0); // late beacon for D, inside GRACE
    });
  });

  it("refuses outside [start(day), end(day)+GRACE) and never re-mints a deleted day", async () => {
    const stub = stubFor("salt-window");
    const d = futureDay(2);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      // No early issuance: one ms before D starts.
      i.clock = () => at(d, "00:00:00") - 1;
      await expect(i.getSalt(d)).rejects.toThrow();
      expect(saltRows(i, d)).toBe(0);
      // Past the deadline for a day never minted.
      i.clock = () => saltDeadline(d);
      await expect(i.getSalt(d)).rejects.toThrow();
      expect(saltRows(i, d)).toBe(0);
      // Mint, expire, delete: the deleted day cannot come back.
      i.clock = () => at(d, "12:00:00");
      await i.getSalt(d);
      i.clock = () => saltDeadline(d) + 1;
      await i.alarm();
      expect(saltRows(i, d)).toBe(0);
      await expect(i.getSalt(d)).rejects.toThrow();
      expect(saltRows(i, d)).toBe(0);
    });
  });
});

describe("SiteLive salt expiry alarm (ADR-0013 §3)", () => {
  it("deletes an expired salt with no further traffic and leaves no alarm armed", async () => {
    const stub = stubFor("salt-expire");
    const d = futureDay(2);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      i.clock = () => at(d, "12:00:00");
      await i.getSalt(d);
      expect(await i.ctx.storage.getAlarm()).toBe(saltDeadline(d)); // armed at mint
      i.clock = () => saltDeadline(d) + 1;
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      expect(saltRows(i, d)).toBe(0);
      expect(await i.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("an event arms a 15 s flush under a salt deadline; the drain re-arms the deadline", async () => {
    const stub = stubFor("salt-multiplex");
    const day = utcDayUTC();
    await stub.getSalt(day);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      expect(await i.ctx.storage.getAlarm()).toBe(saltDeadline(day));
    });
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt({ vid: "v1", path: "/a", siteId: "salt-multiplex-site", day })),
    });
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      expect(await i.ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 15_000);
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      expect(i.pending.size).toBe(0);
      expect(await i.ctx.storage.getAlarm()).toBe(saltDeadline(day));
    });
  });

  it("re-arms the salt deadline on wake when a salt row exists and no alarm is set", async () => {
    const stub = stubFor("salt-wake");
    const day = utcDayUTC();
    await stub.getSalt(day);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      await i.ctx.storage.deleteAlarm();
      await i.rearmOnWake();
      expect(await i.ctx.storage.getAlarm()).toBe(saltDeadline(day));
    });
  });

  it("deletes the salt even when every flush fails, and retries a failed delete in 60 s", async () => {
    const d = futureDay(2);
    const spy = vi.spyOn(env.DB, "batch").mockImplementation(() => {
      throw new Error("D1 down");
    });
    try {
      await runInDurableObject(stubFor("salt-flush-fail"), async (instance) => {
        const i = instance as unknown as SaltInstance;
        i.clock = () => at(d, "12:00:00");
        await i.getSalt(d);
        await i.recordEvent(evt({ vid: "v1", siteId: "salt-flush-fail-site", day: d }));
        i.clock = () => saltDeadline(d) + 1;
        await i.alarm(); // flush throws inside; the salt delete must still run
        expect(saltRows(i, d)).toBe(0);
        expect(i.pending.size).toBeGreaterThan(0);
        expect(await i.ctx.storage.getAlarm()).not.toBeNull();
      });
    } finally {
      spy.mockRestore();
    }

    await runInDurableObject(stubFor("salt-delete-fail"), async (instance) => {
      const i = instance as unknown as SaltInstance;
      i.clock = () => at(d, "12:00:00");
      await i.getSalt(d);
      const now = saltDeadline(d) + 1;
      i.clock = () => now;
      const sweep = vi.spyOn(i, "sweepSalts").mockImplementationOnce(() => {
        throw new Error("sqlite busy");
      });
      await i.alarm();
      expect(saltRows(i, d)).toBe(1);
      expect(await i.ctx.storage.getAlarm()).toBe(now + 60_000);
      sweep.mockRestore();
      await i.alarm();
      expect(saltRows(i, d)).toBe(0);
    });
  });
});

describe("SiteLive designated event day (ADR-0013 §1a)", () => {
  it("rolls an event up under its designated day, not the DO clock's day", async () => {
    const stub = stubFor("eday-1");
    const site = "eday-1-site";
    const d = futureDay(2);
    const d1 = futureDay(3);
    await runInDurableObject(stub, async (instance) => {
      const i = instance as unknown as SaltInstance;
      i.clock = () => at(d, "23:59:59");
      await i.getSalt(d); // the collector fetched D's salt at receipt
      i.clock = () => at(d1, "00:00:02"); // the DO clock is already on D+1
    });
    await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt({ vid: "v1", siteId: site, day: d })),
    });
    await runDurableObjectAlarm(stub);

    const rows = await env.DB.prepare(
      "SELECT day, pageviews FROM rollup_daily WHERE site_id=? AND dimension='total'",
    )
      .bind(site)
      .all<{ day: string; pageviews: number }>();
    expect(rows.results).toEqual([{ day: d, pageviews: 1 }]);
  });

  it("drops an event whose day has no salt row in this DO", async () => {
    const stub = stubFor("eday-2");
    const res = await stub.fetch("https://do-internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt({ vid: "v1", siteId: "eday-2-site", day: futureDay(-3) })),
    });
    expect(res.status).toBe(204);
    await runInDurableObject(stub, (instance) => {
      const i = instance as unknown as SaltInstance & { visitors: Map<string, unknown> };
      expect(i.pending.size).toBe(0);
      expect(i.visitors.size).toBe(0);
      const seen = i.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM seen").one().c;
      expect(seen).toBe(0);
    });
  });
});

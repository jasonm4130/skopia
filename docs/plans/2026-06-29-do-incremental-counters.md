# Event-Driven DO Incremental Counters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5-minute WAE-polling cron rollup with event-driven incremental counters in the per-site `SiteLive` Durable Object, flushing daily aggregates to D1 `rollup_daily` on a short post-activity alarm.

**Architecture:** The collector keeps writing every event to WAE (unchanged) and additionally forwards the enriched event to the site's DO. The DO accumulates per-`(dimension, dim_value)` pageview deltas in RAM and records each visitor in a durable SQLite `seen` set; an alarm flushes dirty rows to D1 (pageviews added, visitors recomputed exactly from `seen`). **No per-event writes to the counter table** — that is the cost guardrail. The cron is retired only after a shadow-table parallel run confirms parity (Phase 2).

**Tech Stack:** TypeScript (strict), Cloudflare Workers + Durable Objects (SQLite-backed, `new_sqlite_classes: ["SiteLive"]`), D1, Vitest + `@cloudflare/vitest-pool-workers`.

**Source spec:** `docs/specs/2026-06-29-do-incremental-counters-design.md`

## Global Constraints

- **Never write the per-event counter to durable storage.** Pageview counts accumulate in a RAM `Map` and flush periodically. Only the `seen` distinct-visitor set is written per-event (new-uniques only), which the cost model covers (free to ~20M PV/mo).
- **D1 `rollup_daily` schema is UNCHANGED:** `(site_id, day, dimension, dim_value, pageviews, visitors, sampled)`, PK `(site_id, day, dimension, dim_value)`. The DO always writes `sampled = 0`.
- **Dashboard is UNCHANGED** — it reads `rollup_daily` throughout. The DO writes to `rollup_daily_shadow` in Phase 1 and to `rollup_daily` only after the Phase 2 cutover.
- **Flush cadence `ALARM_INTERVAL_MS = 15_000`** (15s, comfortably under the ~70s DO eviction window).
- **Dimension semantics must mirror the old `runRollups` exactly** (`src/rollup/index.ts:48-60, 309-348`): 11 dimensions; `referrer` empty → `(direct)`; other empty dim values skipped; the `event` dimension counts every event (`count`, metric `1`) not `is_pageview`.
- **Composite Map keys must not use a NUL (`\x00`) separator** (it corrupts files/tooling). Use `\u0001` and also store the parsed parts in the value so keys never need re-parsing.
- **TDD:** red→green per step. Test runner: `pnpm exec vitest run <file>`. Typecheck: `pnpm typecheck`. Lint-fix before commit: `pnpm exec biome check --write <files>`.
- **Commit trailer** on every commit:
  `Claude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse`
- Work on branch `feat/do-incremental-counters` (already created; the spec is committed there).

## File Structure

| File | Responsibility |
|------|----------------|
| `src/dashboard/event-dimensions.ts` | **New.** Pure function `eventDimensions(e: CountEvent)` → the list of `(dimension, dimValue, pv)` contributions for one event. The `CountEvent` type. No I/O — fully unit-testable. |
| `src/dashboard/site-live.ts` | **Modify.** Add the durable `seen` table + constructor, `recordEvent`, `flush`, `maybeRollover`, the `/event` route + `handleEvent`, and unify the alarm to flush + evict. Keep the existing live-visitor map + WebSocket behaviour. |
| `src/collector/index.ts` | **Modify.** Forward the enriched event as a JSON POST body to the DO `/event` (replace the `vid`+`path` query-string `/hit`). |
| `migrations/0002_rollup_shadow.sql` | **New.** `rollup_daily_shadow` clone table — the Phase-1 flush target for the parallel run. |
| `test/event-dimensions.test.ts` | **New.** Unit tests for the fan-out helper. |
| `test/site-live.test.ts` | **New.** DO tests: `recordEvent`, `flush`, rollover, `/event`, alarm. |

---

## Task 1: `eventDimensions` fan-out helper

**Files:**
- Create: `src/dashboard/event-dimensions.ts`
- Test: `test/event-dimensions.test.ts`

**Interfaces:**
- Produces: `interface CountEvent { siteId: string; vid: string; isPageview: 0 | 1; path: string; referrer: string; utmSource: string; utmMedium: string; utmCampaign: string; country: string; device: string; browser: string; os: string; eventName: string; }`
- Produces: `interface DimContribution { dimension: RollupDimension; dimValue: string; pv: number; }`
- Produces: `function eventDimensions(e: CountEvent): DimContribution[]`

- [ ] **Step 1: Write the failing tests**

Create `test/event-dimensions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { type CountEvent, eventDimensions } from "../src/dashboard/event-dimensions";

function base(overrides: Partial<CountEvent> = {}): CountEvent {
  return {
    siteId: "s1",
    vid: "v1",
    isPageview: 1,
    path: "/blog",
    referrer: "google.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    country: "GB",
    device: "mobile",
    browser: "Firefox",
    os: "iOS",
    eventName: "",
    ...overrides,
  };
}

describe("eventDimensions", () => {
  it("fans a pageview across total + 6 single-value dims with pv=1, no utm/event", () => {
    const dims = eventDimensions(base());
    const map = Object.fromEntries(dims.map((d) => [`${d.dimension}:${d.dimValue}`, d.pv]));
    expect(map).toEqual({
      "total:": 1,
      "page:/blog": 1,
      "referrer:google.com": 1,
      "country:GB": 1,
      "device:mobile": 1,
      "browser:Firefox": 1,
      "os:iOS": 1,
    });
  });

  it("buckets empty referrer as (direct), never dropped", () => {
    const dims = eventDimensions(base({ referrer: "" }));
    expect(dims.find((d) => d.dimension === "referrer")).toEqual({
      dimension: "referrer",
      dimValue: "(direct)",
      pv: 1,
    });
  });

  it("skips empty utm/country/device/browser/os dims (but keeps total)", () => {
    const dims = eventDimensions(
      base({ country: "", device: "", browser: "", os: "" }),
    );
    const present = new Set(dims.map((d) => d.dimension));
    expect(present.has("country")).toBe(false);
    expect(present.has("device")).toBe(false);
    expect(present.has("total")).toBe(true);
  });

  it("emits utm dims with pv=1 when present", () => {
    const dims = eventDimensions(base({ utmSource: "newsletter", utmMedium: "email" }));
    expect(dims.find((d) => d.dimension === "utm_source")).toEqual({
      dimension: "utm_source",
      dimValue: "newsletter",
      pv: 1,
    });
    expect(dims.find((d) => d.dimension === "utm_medium")).toEqual({
      dimension: "utm_medium",
      dimValue: "email",
      pv: 1,
    });
  });

  it("custom event: pv=0 for pageview dims, event dim gets pv=1 (count), eventName drives it", () => {
    const dims = eventDimensions(base({ isPageview: 0, eventName: "signup" }));
    // pageview-metric dims contribute 0 pageviews but still register (for seen)
    expect(dims.find((d) => d.dimension === "total")?.pv).toBe(0);
    expect(dims.find((d) => d.dimension === "page")?.pv).toBe(0);
    // event dimension counts the fire
    expect(dims.find((d) => d.dimension === "event")).toEqual({
      dimension: "event",
      dimValue: "signup",
      pv: 1,
    });
  });

  it("pageview has no event-dim contribution (empty eventName)", () => {
    const dims = eventDimensions(base());
    expect(dims.find((d) => d.dimension === "event")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/event-dimensions.test.ts`
Expected: FAIL — cannot find module `../src/dashboard/event-dimensions`.

- [ ] **Step 3: Write the implementation**

Create `src/dashboard/event-dimensions.ts`:

```typescript
/**
 * Pure dimension fan-out for the DO incremental rollup (spec §5).
 *
 * Mirrors the old cron's GROUP-BY semantics (src/rollup/index.ts:48-60, 309-348)
 * exactly so rollup_daily stays byte-compatible:
 *   - 11 dimensions; `referrer` empty -> "(direct)"; other empty values skipped.
 *   - pageview metric is is_pageview for every dim EXCEPT `event`, which counts
 *     each fire (metric 1) so the events breakdown is non-empty.
 */
import type { RollupDimension } from "../shared/types";

export interface CountEvent {
  siteId: string;
  vid: string;
  isPageview: 0 | 1;
  path: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  eventName: string;
}

export interface DimContribution {
  dimension: RollupDimension;
  dimValue: string;
  /** Amount to add to this row's pageviews delta. */
  pv: number;
}

export function eventDimensions(e: CountEvent): DimContribution[] {
  const out: DimContribution[] = [];
  const pv = e.isPageview; // 0 or 1

  // total — always present; dim_value "" is its valid value.
  out.push({ dimension: "total", dimValue: "", pv });

  // page — skip only if path is empty (collector always sends at least "/").
  if (e.path) out.push({ dimension: "page", dimValue: e.path, pv });

  // referrer — empty becomes "(direct)" rather than being dropped.
  out.push({
    dimension: "referrer",
    dimValue: e.referrer === "" ? "(direct)" : e.referrer,
    pv,
  });

  // utm_* / geo / ua — single-value dims, skipped when empty.
  const singles: Array<[RollupDimension, string]> = [
    ["utm_source", e.utmSource],
    ["utm_medium", e.utmMedium],
    ["utm_campaign", e.utmCampaign],
    ["country", e.country],
    ["device", e.device],
    ["browser", e.browser],
    ["os", e.os],
  ];
  for (const [dimension, dimValue] of singles) {
    if (dimValue) out.push({ dimension, dimValue, pv });
  }

  // event — counts every fire (metric 1), keyed by event name; pageviews have none.
  if (e.eventName) out.push({ dimension: "event", dimValue: e.eventName, pv: 1 });

  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/event-dimensions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec biome check --write src/dashboard/event-dimensions.ts test/event-dimensions.test.ts
git add src/dashboard/event-dimensions.ts test/event-dimensions.test.ts
git commit -m "$(printf 'feat(rollup): pure event->dimension fan-out helper\n\nClaude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse')"
```

---

## Task 2: DO `seen` table + `recordEvent`

**Files:**
- Modify: `src/dashboard/site-live.ts`
- Test: `test/site-live.test.ts`

**Interfaces:**
- Consumes: `eventDimensions`, `CountEvent` (Task 1).
- Produces: `SiteLive.recordEvent(e: CountEvent): Promise<void>` — records the event into RAM `pending` deltas + the durable `seen` set, handling UTC day on first use.
- Produces (private RAM state): `pending: Map<string, { dimension: RollupDimension; dimValue: string; delta: number }>`, `currentDay: string | null`, `siteId: string | null`.
- Produces (durable): SQLite table `seen(day, dimension, dim_value, vid)`.

- [ ] **Step 1: Write the failing test**

Create `test/site-live.test.ts`:

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CountEvent } from "../src/dashboard/event-dimensions";
import { applyMigrations } from "./apply-migrations";

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
      const page = [...i.pending.values()].find((p) => p.dimension === "page" && p.dimValue === "/a");
      expect(total?.delta).toBe(3);
      expect(page?.delta).toBe(3);

      // seen distinct visitors for page:/a = 2 (v1, v2)
      const c = i.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM seen WHERE dimension = ? AND dim_value = ?",
          "page",
          "/a",
        )
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/site-live.test.ts`
Expected: FAIL — `instance.recordEvent is not a function`.

- [ ] **Step 3: Add the imports, constants, state, constructor, and `recordEvent`**

In `src/dashboard/site-live.ts`, extend the imports at the top:

```typescript
import { DurableObject } from "cloudflare:workers";
import { type CountEvent, eventDimensions } from "./event-dimensions";
import { utcDay } from "../shared/identity";
import type { BreakdownRow, Env, LiveSnapshot, RollupDimension } from "../shared/types";
```

Add module constants below the existing `ALARM_INTERVAL_MS` (change its value to `15_000`):

```typescript
/** Alarm tick interval: 15 seconds — flush + live-eviction (spec §6). */
const ALARM_INTERVAL_MS = 15_000;

/** Durable distinct-visitor set. WITHOUT ROWID => PK insert is 1 row written. */
const SEEN_DDL = `CREATE TABLE IF NOT EXISTS seen (
  day        TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  dim_value  TEXT NOT NULL,
  vid        TEXT NOT NULL,
  PRIMARY KEY (day, dimension, dim_value, vid)
) WITHOUT ROWID`;

/** RAM pending key: dimension + \u0001 + dim_value (NEVER \x00). */
function pendingKey(dimension: string, dimValue: string): string {
  return `${dimension}\u0001${dimValue}`;
}
```

Add the new RAM fields next to the existing `visitors` map and a constructor that ensures the table:

```typescript
export class SiteLive extends DurableObject<Env> {
  /** vid -> { lastSeen, path } — live window (RAM, ephemeral by design). */
  private visitors = new Map<string, VisitorEntry>();

  /** Per-(dimension,dim_value) pageview delta since the last flush + dirty set. */
  private pending = new Map<
    string,
    { dimension: RollupDimension; dimValue: string; delta: number }
  >();

  /** UTC day the RAM state belongs to (rollover detection). */
  private currentDay: string | null = null;

  /** site_id, learned from the first event (needed for the D1 flush). */
  private siteId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup is synchronous; safe in the constructor for SQLite DOs.
    this.ctx.storage.sql.exec(SEEN_DDL);
  }
```

Add `recordEvent` (place it after `handleHit`, before `handleLiveWs`):

```typescript
  /** Record one enriched event into RAM deltas + the durable seen set (spec §5). */
  async recordEvent(e: CountEvent): Promise<void> {
    this.siteId = e.siteId;
    const day = utcDay(new Date());
    await this.maybeRollover(day);
    this.currentDay = day;

    for (const c of eventDimensions(e)) {
      const key = pendingKey(c.dimension, c.dimValue);
      const cur = this.pending.get(key);
      if (cur) {
        cur.delta += c.pv;
      } else {
        this.pending.set(key, { dimension: c.dimension, dimValue: c.dimValue, delta: c.pv });
      }
      // INSERT OR IGNORE: a returning visitor is a no-op (0 rows written).
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO seen (day, dimension, dim_value, vid) VALUES (?, ?, ?, ?)",
        day,
        c.dimension,
        c.dimValue,
        e.vid,
      );
    }
  }
```

Add a temporary no-op `maybeRollover` so the class compiles (Task 4 fills it in):

```typescript
  /** Day-rollover hook — implemented in Task 4. */
  private async maybeRollover(_newDay: string): Promise<void> {
    // no-op until Task 4
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/site-live.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec biome check --write src/dashboard/site-live.ts test/site-live.test.ts
git add src/dashboard/site-live.ts test/site-live.test.ts
git commit -m "$(printf 'feat(rollup): DO recordEvent — RAM deltas + durable seen set\n\nClaude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse')"
```

---

## Task 3: DO `flush()` → `rollup_daily_shadow`

**Files:**
- Create: `migrations/0002_rollup_shadow.sql`
- Modify: `src/dashboard/site-live.ts`
- Test: `test/site-live.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `recordEvent`, `pending`, `currentDay`, `siteId` (Task 2).
- Produces: `SiteLive.flush(): Promise<void>` — UPSERTs each dirty row into `rollup_daily_shadow` with pageviews **added** and visitors **recomputed absolutely** from `seen`, then clears `pending`.

- [ ] **Step 1: Create the shadow-table migration**

Create `migrations/0002_rollup_shadow.sql`:

```sql
-- Phase-1 parallel-run target for the DO incremental rollup
-- (docs/specs/2026-06-29-do-incremental-counters-design.md §9). Identical shape
-- to rollup_daily. The DO writes here while the cron still owns rollup_daily;
-- after parity is confirmed (Phase 2) the DO repoints to rollup_daily and this
-- table is dropped.
CREATE TABLE IF NOT EXISTS rollup_daily_shadow (
  site_id   TEXT NOT NULL,
  day       TEXT NOT NULL,
  dimension TEXT NOT NULL,
  dim_value TEXT NOT NULL DEFAULT '',
  pageviews INTEGER NOT NULL DEFAULT 0,
  visitors  INTEGER NOT NULL DEFAULT 0,
  sampled   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, dimension, dim_value)
);
```

- [ ] **Step 2: Write the failing test**

Append to `test/site-live.test.ts`:

```typescript
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
```

Add this helper import at the top of the file (next to the existing imports) — the test needs the same UTC-day string the DO uses:

```typescript
import { utcDay } from "../src/shared/identity";
function utcDayUTC(): string {
  return utcDay(new Date());
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run test/site-live.test.ts`
Expected: FAIL — `instance.flush is not a function`.

- [ ] **Step 4: Implement `flush` + the UPSERT constant**

In `src/dashboard/site-live.ts`, add the flush target constant near `SEEN_DDL`:

```typescript
/** Phase 1 writes the shadow table; Phase 2 flips this to "rollup_daily". */
const FLUSH_TABLE = "rollup_daily_shadow";

const FLUSH_UPSERT = `
INSERT INTO ${FLUSH_TABLE} (site_id, day, dimension, dim_value, pageviews, visitors, sampled)
VALUES (?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(site_id, day, dimension, dim_value)
DO UPDATE SET
  pageviews = ${FLUSH_TABLE}.pageviews + excluded.pageviews,
  visitors  = excluded.visitors,
  sampled   = 0
`.trim();
```

Add the `flush` method (after `recordEvent`):

```typescript
  /** Flush dirty counters to D1 (spec §6). Pageviews add; visitors are exact. */
  async flush(): Promise<void> {
    if (this.siteId === null || this.currentDay === null || this.pending.size === 0) return;
    const day = this.currentDay;
    const site = this.siteId;

    const stmts = [];
    for (const { dimension, dimValue, delta } of this.pending.values()) {
      const visitors = this.countSeen(day, dimension, dimValue);
      stmts.push(this.env.DB.prepare(FLUSH_UPSERT).bind(site, day, dimension, dimValue, delta, visitors));
    }

    try {
      for (let i = 0; i < stmts.length; i += 100) {
        await this.env.DB.batch(stmts.slice(i, i + 100));
      }
      this.pending.clear(); // only on success — otherwise retry next alarm
    } catch {
      // Leave pending intact; the next flush retries. WAE still holds the raw events.
    }
  }

  /** Exact distinct visitors for a (day, dimension, value) from the durable set. */
  private countSeen(day: string, dimension: string, dimValue: string): number {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT COUNT(*) AS c FROM seen WHERE day = ? AND dimension = ? AND dim_value = ?",
        day,
        dimension,
        dimValue,
      )
      .one();
    return Number(row.c);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run test/site-live.test.ts`
Expected: PASS (all `recordEvent` + `flush` tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec biome check --write src/dashboard/site-live.ts test/site-live.test.ts
git add migrations/0002_rollup_shadow.sql src/dashboard/site-live.ts test/site-live.test.ts
git commit -m "$(printf 'feat(rollup): DO flush — additive pageviews, exact visitors -> shadow\n\nClaude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse')"
```

---

## Task 4: UTC day rollover

**Files:**
- Modify: `src/dashboard/site-live.ts`
- Test: `test/site-live.test.ts` (add a `describe`)

**Interfaces:**
- Replaces the Task-2 no-op `maybeRollover` with the real one: when the day changes, flush the old day, `DROP`/recreate `seen`, and reset `pending`.

- [ ] **Step 1: Write the failing test**

The DO derives the day from the wall clock, so the test drives rollover by calling `maybeRollover` directly with an explicit new day after seeding the old day. Append to `test/site-live.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/site-live.test.ts -t "rollover"`
Expected: FAIL — old-day row absent / seen not reset (no-op `maybeRollover`).

- [ ] **Step 3: Implement `maybeRollover`**

Replace the Task-2 no-op `maybeRollover` in `src/dashboard/site-live.ts` with:

```typescript
  /** On a UTC day change: flush the old day, reset the seen set, clear pending. */
  private async maybeRollover(newDay: string): Promise<void> {
    if (this.currentDay !== null && this.currentDay !== newDay) {
      await this.flush(); // flushes under the OLD this.currentDay
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS seen"); // not DELETE — no per-row writes
      this.ctx.storage.sql.exec(SEEN_DDL);
      this.pending.clear();
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/site-live.test.ts`
Expected: PASS (all DO tests so far).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec biome check --write src/dashboard/site-live.ts test/site-live.test.ts
git add src/dashboard/site-live.ts test/site-live.test.ts
git commit -m "$(printf 'feat(rollup): DO UTC rollover — flush old day, DROP+reset seen\n\nClaude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse')"
```

---

## Task 5: `/event` route + `handleEvent` + unified alarm

**Files:**
- Modify: `src/dashboard/site-live.ts`
- Test: `test/site-live.test.ts` (add a `describe`)

**Interfaces:**
- Produces: DO HTTP route `POST /event` → `handleEvent` parses the JSON `CountEvent` body, updates the live-visitor map + broadcasts (unchanged behaviour), calls `recordEvent`, and arms the alarm. `/hit` is kept untouched for now (removed in Task 6).
- Modifies: `alarm()` now flushes counters first, then evicts stale live visitors, rescheduling while `visitors.size > 0 || pending.size > 0`.

- [ ] **Step 1: Write the failing test**

Append to `test/site-live.test.ts` (add `runDurableObjectAlarm` to the `cloudflare:test` import):

```typescript
// update the top import to:
// import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

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
      body: JSON.stringify(evt({ vid: "v1", path: "/a" })),
    });
    await runDurableObjectAlarm(stub); // fire the scheduled flush+evict tick

    const row = await env.DB.prepare(
      "SELECT pageviews FROM rollup_daily_shadow WHERE site_id=? AND day=? AND dimension='total'",
    )
      .bind("do-site", day)
      .first<{ pageviews: number }>();
    expect(row?.pageviews).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/site-live.test.ts -t "/event"`
Expected: FAIL — `/event` returns 404 (route not wired).

- [ ] **Step 3: Wire the route, `handleEvent`, and the unified alarm**

In `src/dashboard/site-live.ts` `fetch`, add the `/event` route (keep `/hit`):

```typescript
    if (url.pathname === "/event") {
      return this.handleEvent(request);
    }

    if (url.pathname === "/hit") {
      return this.handleHit(request);
    }
```

Add `handleEvent` (after `handleHit`):

```typescript
  /** Collector hot path: live-map update + dimensional counting in one call. */
  private async handleEvent(request: Request): Promise<Response> {
    let e: CountEvent;
    try {
      e = (await request.json()) as CountEvent;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // Live window (same behaviour the old /hit had).
    this.visitors.set(e.vid, { lastSeen: Date.now(), path: e.path });

    // Dimensional counting (new).
    await this.recordEvent(e);

    // Arm the flush/evict alarm if none is pending (idempotent).
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }

    this.broadcast();
    return new Response(null, { status: 204 });
  }
```

Replace the existing `alarm()` body so it flushes first, then evicts:

```typescript
  /** Tick: flush counters, then evict stale live visitors (spec §6). */
  override async alarm(): Promise<void> {
    await this.flush();

    const cutoff = Date.now() - VISITOR_TTL_MS;
    let evicted = false;
    for (const [vid, entry] of this.visitors) {
      if (entry.lastSeen < cutoff) {
        this.visitors.delete(vid);
        evicted = true;
      }
    }
    if (evicted) this.broadcast();

    // Reschedule while there is live activity or counters still to flush.
    if (this.visitors.size > 0 || this.pending.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/site-live.test.ts`
Expected: PASS (all DO tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec biome check --write src/dashboard/site-live.ts test/site-live.test.ts
git add src/dashboard/site-live.ts test/site-live.test.ts
git commit -m "$(printf 'feat(rollup): DO /event route + flush-then-evict alarm\n\nClaude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse')"
```

---

## Task 6: Collector forwards `/event`; remove dead `/hit`

**Files:**
- Modify: `src/collector/index.ts:236-248`
- Modify: `src/dashboard/site-live.ts` (remove `/hit` route + `handleHit`)
- Modify: `test/collector.test.ts` (extend the DO-bump test)

**Interfaces:**
- Consumes: DO `/event` (Task 5).
- The collector POSTs the enriched `CountEvent` JSON body to `https://do-internal/event` instead of the `vid`+`path` query string.

- [ ] **Step 1: Update the collector to post the enriched event**

Replace `src/collector/index.ts:236-248` (the `// ---------- 13. Bump SiteLive DO ----------` block) with:

```typescript
  // ---------- 13. Bump SiteLive DO (async, non-blocking) ----------
  // One DO call per event drives BOTH the live count and the dimensional rollup
  // (spec §3). The DO reads a JSON body — query-string params are not used.
  const doId = env.SITE_LIVE.idFromName(siteId);
  const doStub = env.SITE_LIVE.get(doId);
  const eventBody = JSON.stringify({
    siteId,
    vid,
    isPageview,
    path: beacon.p ?? "/",
    referrer: referrerHost,
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    country: cf.country,
    device: deviceClass,
    browser: uaInfo.browser,
    os: uaInfo.os,
    eventName: beacon.n ?? "",
  });
  ctx.waitUntil(
    doStub
      .fetch(
        new Request("https://do-internal/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: eventBody,
        }),
      )
      .catch(() => {
        // DO is best-effort; WAE already holds the durable copy.
      }),
  );
```

- [ ] **Step 2: Extend the collector DO-bump test**

The existing test (`test/collector.test.ts:388-419`) asserts `visitors.size === 2`; it stays valid because `handleEvent` still populates the live map. Add a counting assertion right after the existing `expect(count).toBe(2);` line, inside the same `it(...)`:

```typescript
    // The same /event calls also feed the incremental rollup. Fire the DO alarm
    // to flush, then the shadow table must hold the two pageviews.
    const { runDurableObjectAlarm } = await import("cloudflare:test");
    await runDurableObjectAlarm(stub);
    const shadow = await env.DB.prepare(
      "SELECT pageviews, visitors FROM rollup_daily_shadow WHERE site_id=? AND dimension='total'",
    )
      .bind("live-site")
      .first<{ pageviews: number; visitors: number }>();
    expect(shadow?.pageviews).toBe(2);
    expect(shadow?.visitors).toBe(2);
```

- [ ] **Step 3: Run the collector test to verify it passes**

Run: `pnpm exec vitest run test/collector.test.ts -t "SiteLive DO bump"`
Expected: PASS (live count 2 + shadow pageviews/visitors 2).

- [ ] **Step 4: Remove the now-dead `/hit` route + `handleHit`**

In `src/dashboard/site-live.ts`, delete the `/hit` route block from `fetch`:

```typescript
    if (url.pathname === "/hit") {
      return this.handleHit(request);
    }
```

and delete the entire `handleHit` method (the `private async handleHit(request: Request)` block). `handleEvent` fully supersedes it.

- [ ] **Step 5: Run the full DO + collector suites to verify nothing regressed**

Run: `pnpm exec vitest run test/site-live.test.ts test/collector.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec biome check --write src/collector/index.ts src/dashboard/site-live.ts test/collector.test.ts
git add src/collector/index.ts src/dashboard/site-live.ts test/collector.test.ts
git commit -m "$(printf 'feat(rollup): collector forwards enriched /event; drop dead /hit\n\nClaude-Session: https://claude.ai/code/session_015H5GrhVKRZLRJKtAPMvFse')"
```

---

## Phase 1 done — validation gate ⛔

Before Phase 2, deploy Phase 1 and let the DO write `rollup_daily_shadow` alongside the live cron for **1–2 days of real traffic**, then compare:

```bash
# Per (site, day, dimension): cron's rollup_daily vs the DO's shadow.
wrangler d1 execute skopia --remote --command "
  SELECT r.site_id, r.day, r.dimension,
         r.pageviews AS cron_pv, s.pageviews AS do_pv,
         r.visitors  AS cron_v,  s.visitors  AS do_v
  FROM rollup_daily r JOIN rollup_daily_shadow s
    ON (r.site_id,r.day,r.dimension,r.dim_value)=(s.site_id,s.day,s.dimension,s.dim_value)
  WHERE r.dimension='total' ORDER BY r.day DESC LIMIT 50;"
```

Expect pageviews to match closely and visitors to match within a small tolerance (cron sampling vs. DO's ≤15s eviction-window pageview loss). Also capture real DO `meta.rows_written` (observability) to confirm the §7 cost shape. **If the diff is bad, do NOT proceed — the cron is untouched and still authoritative.** Only when parity holds, run Phase 2.

---

## Phase 2: Cutover (run ONLY after the validation gate passes)

> These steps retire the cron. Do them as one PR after Phase 1 parity is confirmed. Each is small; keep them TDD where a test exists.

- [ ] **Step 1: Repoint the DO flush to the real table**

In `src/dashboard/site-live.ts`, change the constant:

```typescript
const FLUSH_TABLE = "rollup_daily"; // was "rollup_daily_shadow"
```

Update the two shadow-table assertions in `test/site-live.test.ts` and the one in `test/collector.test.ts` to read `rollup_daily` instead of `rollup_daily_shadow`. Run `pnpm exec vitest run test/site-live.test.ts test/collector.test.ts` → PASS.

- [ ] **Step 2: Lower the salt TTL and delete `rotateDailySalt`**

In `src/shared/identity.ts:67`, change the TTL:

```typescript
  // TTL ~25 h: the date-keyed salt is only needed for its own UTC day, so it
  // self-deletes ~1 h into the next day — the ~24 h cross-day-correlation window
  // the old cron's explicit delete provided, with zero infrastructure (spec §8).
  await kv.put(key, salt, { expirationTtl: 25 * 60 * 60 });
```

Delete the entire `rotateDailySalt` function (`src/shared/identity.ts:78-87`). Update `test/identity.test.ts`: remove any `rotateDailySalt` test and assert the TTL passed to `kv.put` is `25 * 60 * 60`. Run `pnpm exec vitest run test/identity.test.ts` → PASS.

- [ ] **Step 3: Delete the cron rollup**

```bash
git rm src/rollup/index.ts test/rollup.test.ts
```

In `src/index.ts`, remove the `handleScheduled` import (line 14) and the entire `scheduled(...)` property from the default export (lines 57-59), leaving:

```typescript
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
```

In `wrangler.jsonc`, remove the `"triggers"` / `"crons"` block (the `*/5 * * * *` schedule).

- [ ] **Step 4: Drop the shadow table**

```bash
wrangler d1 execute skopia --remote --command "DROP TABLE IF EXISTS rollup_daily_shadow;"
```

Add a migration `migrations/0003_drop_rollup_shadow.sql` with `DROP TABLE IF EXISTS rollup_daily_shadow;` so fresh deploys/tests don't recreate it.

- [ ] **Step 5: Full verification + ADR**

```bash
pnpm typecheck && pnpm lint && pnpm exec vitest run && pnpm build
```

Expected: all green; no reference to `rotateDailySalt`, `handleScheduled`, or `rollup_daily_shadow` remains. Write `docs/decisions/0010-event-driven-do-rollup.md` recording the supersession of ADR-0003, then commit.

---

## Self-Review

**Spec coverage (against `docs/specs/2026-06-29-do-incremental-counters-design.md`):**

- §3 collector→DO JSON payload → Task 6. The "one DO call per event / parse JSON body" requirement → Task 5 (`handleEvent` parses body) + Task 6 (collector posts body, `/hit` removed).
- §4 DO state (RAM `pending`, durable `seen` `WITHOUT ROWID`) → Tasks 2–3. (`deltas`+`dirty` from the spec are unified into one `pending` map keyed `dimension\u0001dim_value` with parts stored in the value — equivalent, avoids NUL/key-parsing; noted in Global Constraints.)
- §5 dimension fan-out (table, direct bucketing, event-dim count, custom-event-to-seen) → Task 1, mirrored from `runRollups`.
- §6 flush (additive pageviews, absolute visitors from `seen`), post-activity 15s alarm, UTC rollover with `DROP` → Tasks 3, 4, 5.
- §7 cost guardrails (no per-event counter writes; `WITHOUT ROWID`; `DROP` not `DELETE`) → Global Constraints + Tasks 2–4.
- §8 salt TTL 48h→25h + drop `rotateDailySalt` → Phase 2 Step 2 (coupled to cron deletion because `rotateDailySalt` lives in the cron and is still needed while the cron runs during Phase-1 validation).
- §9 clean seam + shadow parallel-run + delete cron/`src/rollup`/`scheduled()` → `rollup_daily_shadow` (Task 3), validation gate, Phase 2 Steps 1, 3.
- §11 HLL / live-DO-read / WAE-replay escape hatches → out of scope (documented in the spec; not built).
- §12 files touched → all mapped to tasks.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The Task-2 `maybeRollover` no-op is explicitly a stub replaced with full code in Task 4 (called out in both tasks), not a placeholder.

**Type consistency:** `CountEvent` (Task 1) is the single event shape used by `recordEvent` (Task 2), `handleEvent` (Task 5), and the collector body (Task 6). `eventDimensions` returns `DimContribution{dimension, dimValue, pv}` consumed identically in `recordEvent`. `pending` value shape `{dimension, dimValue, delta}` is written in Task 2 and read in Tasks 3–5. `FLUSH_TABLE`/`FLUSH_UPSERT` defined in Task 3, flipped in Phase 2 Step 1. `countSeen(day, dimension, dimValue)` defined and used within Task 3. Alarm reschedule predicate uses `pending.size` (Task 5) — `pending` exists from Task 2.

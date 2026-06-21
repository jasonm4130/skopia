# Stratus — Phase 0 + 1 (Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the end-to-end loop — a pageview fired by a sub-2 KB script lands in Workers Analytics Engine, is rolled up into D1, and appears as a time-series on an auth-gated dashboard for one seeded site.

**Architecture:** A single Cloudflare Worker (Hono router) exposes a public collector route `/e`, an authed dashboard, and a `scheduled` cron handler. The collector derives a cookieless daily-salt HMAC visitor id and writes one Analytics Engine data point per pageview. A cron rolls WAE → exact daily aggregates in D1. The dashboard reads D1. (Multi-site, custom events, real-time, public dashboards, full dimensions, and one-click deploy are later phases — see `docs/specs/2026-06-21-product-plan.md`.)

**Tech Stack:** TypeScript (strict), Cloudflare Workers, Hono, Workers Analytics Engine, D1, Workers KV, Web Crypto (HMAC-SHA256), Vitest + `@cloudflare/vitest-pool-workers`, Wrangler.

## Global Constraints

- **Client tracking script ≤ 2 KB gzipped** — CI-enforced; a regression fails the build (copied from `CLAUDE.md`). Defend it by doing all enrichment server-side.
- **Cookieless by architecture** — the client script sets **zero** cookies and uses **zero** `localStorage`/`sessionStorage`. CI-audited. Raw IP is **never** persisted anywhere.
- **TypeScript strict mode** everywhere. No `any` in committed code without a justifying comment.
- **WAE write limits** (live-verified 2026-06-21): ≤ 250 data points/invocation, ≤ 20 blobs, ≤ 20 doubles, **1 index**, ≤ 16 KB total blobs, index ≤ 96 bytes. We write **1 data point/event, index = `site_id`**.
- **WAE reads are via the SQL HTTP API** (`POST https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`, bearer token with *Account Analytics Read*) — **not** a binding. Every count must be sampling-corrected: `SUM(_sample_interval)`, never bare `COUNT(*)`.
- **License:** AGPL-3.0 (add the `LICENSE` file in Task 0.1).
- **Commit after every passing task.** Branch off `main` for the work; do not commit product code directly to `main` without the per-task cadence below.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | toolchain: deps, strict TS, Workers test pool |
| `wrangler.jsonc` | Worker config + bindings (WAE, DB, SALT KV); secrets declared, not committed |
| `LICENSE` | AGPL-3.0 text |
| `migrations/0001_init.sql` | D1 schema: `sites`, `users`, `rollup_daily`; seed one site |
| `src/index.ts` | Worker entry: Hono `fetch` + `scheduled` cron handler |
| `src/collector.ts` | collector: CORS, validate, enrich, identity, `writeDataPoint` |
| `src/cron.ts` | rollup: query WAE SQL → upsert D1 `rollup_daily` + sampled flag |
| `src/dashboard.ts` | Hono routes: login, logout, dashboard time-series (authed) |
| `src/lib/identity.ts` | `deriveVid`, `getDailySalt` (cookieless visitor id) |
| `src/lib/auth.ts` | `hashPassword`, `verifyPassword`, `signSession`, `verifySession`, middleware |
| `src/lib/wae.ts` | `queryWae` — typed SQL-API client |
| `src/lib/env.ts` | the `Env` interface (shared binding/secret types) |
| `src/client/stratus.ts` | the tracking script source (compiled + size-checked) |
| `scripts/check-size.mjs` | fail build if `dist/stratus.js` > 2 KB gz |
| `scripts/check-cookieless.mjs` | fail build if the script source references cookie/storage APIs |
| `test/**` | one test file per module (colocated path mirrors `src/`) |

---

## Phase 0 — Foundations

### Task 0.1: Project scaffold + LICENSE + Env types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `LICENSE`, `src/lib/env.ts`, `test/smoke.test.ts`
- Create: `src/index.ts` (minimal placeholder)

**Interfaces:**
- Produces: `Env` interface (consumed by every later task); a runnable `wrangler dev` + `vitest` toolchain.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "stratus",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build:client": "esbuild src/client/stratus.ts --bundle --minify --format=iife --outfile=dist/stratus.js",
    "check:size": "node scripts/check-size.mjs",
    "check:cookieless": "node scripts/check-cookieless.mjs",
    "ci": "npm run typecheck && npm run test && npm run build:client && npm run check:size && npm run check:cookieless"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20260601.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "~2.1.0",
    "wrangler": "^4.68.0"
  },
  "dependencies": {
    "hono": "^4.6.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `wrangler.jsonc`** (bindings for the walking skeleton only)

```jsonc
{
  "name": "stratus",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-18",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "analytics_engine_datasets": [
    { "binding": "WAE", "dataset": "stratus_events" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "stratus", "database_id": "placeholder-set-on-deploy" }
  ],
  "kv_namespaces": [
    { "binding": "SALT", "id": "placeholder-set-on-deploy" }
  ],
  "triggers": { "crons": ["*/5 * * * *"] },
  "vars": { "RETENTION_DAYS": "90" }
  // Secrets (set via `wrangler secret put`, never committed):
  //   IDENTITY_HMAC_SECRET, AUTH_COOKIE_SECRET, CF_ACCOUNT_ID, WAE_API_TOKEN
}
```

- [ ] **Step 4: Write `src/lib/env.ts`**

```ts
export interface Env {
  WAE: AnalyticsEngineDataset;
  DB: D1Database;
  SALT: KVNamespace;
  RETENTION_DAYS: string;
  // secrets
  IDENTITY_HMAC_SECRET: string;
  AUTH_COOKIE_SECRET: string;
  CF_ACCOUNT_ID: string;
  WAE_API_TOKEN: string;
}
```

- [ ] **Step 5: Write `src/index.ts`** (placeholder; fleshed out in later tasks)

```ts
import { Hono } from "hono";
import type { Env } from "./lib/env";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.text("ok"));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // test-only secret/var overrides
          bindings: {
            IDENTITY_HMAC_SECRET: "test-identity-secret",
            AUTH_COOKIE_SECRET: "test-cookie-secret",
            CF_ACCOUNT_ID: "test-account",
            WAE_API_TOKEN: "test-token",
            RETENTION_DAYS: "90",
          },
        },
      },
    },
  },
});
```

- [ ] **Step 7: Add the `LICENSE` file**

Run (fetches the canonical AGPL-3.0 text — do not hand-type it):
```bash
curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE
head -1 LICENSE   # expect: "                    GNU AFFERO GENERAL PUBLIC LICENSE"
```

- [ ] **Step 8: Write the smoke test `test/smoke.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("smoke", () => {
  it("serves /health", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
```

- [ ] **Step 9: Install + run the toolchain**

Run: `npm install && npm run typecheck && npm run test`
Expected: typecheck clean; smoke test PASS (1 passed).

- [ ] **Step 10: Commit**

```bash
git checkout -b phase-0-1-walking-skeleton
git add -A
git commit -m "chore: scaffold toolchain, env types, AGPL LICENSE"
```

---

### Task 0.2: D1 schema + migration + seed site

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `test/migrations.test.ts`

**Interfaces:**
- Produces: tables `sites(id, name, domain, created_at)`, `users(id, email, pw_hash, created_at)`, `rollup_daily(site_id, day, metric, value, sampled)`; a seeded site with `id = 'default'`.

- [ ] **Step 1: Write the failing test `test/migrations.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

async function applyMigrations() {
  const sql = readFileSync("migrations/0001_init.sql", "utf8");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

describe("migration 0001", () => {
  beforeAll(applyMigrations);

  it("creates the rollup_daily table", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rollup_daily'"
    ).first<{ name: string }>();
    expect(row?.name).toBe("rollup_daily");
  });

  it("seeds a default site", async () => {
    const row = await env.DB.prepare("SELECT id FROM sites WHERE id='default'").first<{ id: string }>();
    expect(row?.id).toBe("default");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- migrations`
Expected: FAIL (no such table / file not found).

- [ ] **Step 3: Write `migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS rollup_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  sampled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, metric)
);

INSERT OR IGNORE INTO sites (id, name, domain) VALUES ('default', 'My Site', '');
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- migrations`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add migrations/0001_init.sql test/migrations.test.ts
git commit -m "feat: D1 schema (sites, users, rollup_daily) + seed default site"
```

---

## Phase 1 — Walking skeleton

### Task 1.1: Cookieless visitor id (`deriveVid`)

**Files:**
- Create: `src/lib/identity.ts`
- Create: `test/identity.test.ts`

**Interfaces:**
- Produces: `deriveVid(secret: string, salt: string, ip: string, ua: string, siteId: string): Promise<string>` — 16-hex-char HMAC-SHA256 truncation. Deterministic for same inputs; different when salt differs. Raw IP/UA never returned.

- [ ] **Step 1: Write the failing test `test/identity.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { deriveVid } from "../src/lib/identity";

describe("deriveVid", () => {
  it("is deterministic for identical inputs", async () => {
    const a = await deriveVid("sec", "salt1", "1.2.3.4", "UA", "default");
    const b = await deriveVid("sec", "salt1", "1.2.3.4", "UA", "default");
    expect(a).toBe(b);
  });

  it("returns a 16-char hex string", async () => {
    const v = await deriveVid("sec", "salt1", "1.2.3.4", "UA", "default");
    expect(v).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the daily salt rotates (cross-day unlinkable)", async () => {
    const d1 = await deriveVid("sec", "salt1", "1.2.3.4", "UA", "default");
    const d2 = await deriveVid("sec", "salt2", "1.2.3.4", "UA", "default");
    expect(d1).not.toBe(d2);
  });

  it("differs across sites for the same visitor", async () => {
    const s1 = await deriveVid("sec", "salt1", "1.2.3.4", "UA", "siteA");
    const s2 = await deriveVid("sec", "salt1", "1.2.3.4", "UA", "siteB");
    expect(s1).not.toBe(s2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- identity`
Expected: FAIL ("deriveVid is not a function").

- [ ] **Step 3: Write `src/lib/identity.ts`**

```ts
const enc = new TextEncoder();

export async function deriveVid(
  secret: string,
  salt: string,
  ip: string,
  ua: string,
  siteId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // salt rotates daily; raw ip/ua are consumed here and never stored.
  const msg = `${salt}|${ip}|${ua}|${siteId}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  const bytes = new Uint8Array(sig).slice(0, 8); // 8 bytes -> 16 hex chars
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- identity`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/identity.ts test/identity.test.ts
git commit -m "feat: cookieless daily-salt HMAC visitor id"
```

---

### Task 1.2: Daily salt store (`getDailySalt`)

**Files:**
- Modify: `src/lib/identity.ts`
- Create: `test/salt.test.ts`

**Interfaces:**
- Consumes: `Env.SALT` (KV).
- Produces: `getDailySalt(kv: KVNamespace, day: string): Promise<string>` — returns the salt for `day` (UTC `YYYY-MM-DD`), creating + storing a random one with a 48-hour TTL on first access; stable within the same day.

- [ ] **Step 1: Write the failing test `test/salt.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getDailySalt } from "../src/lib/identity";

describe("getDailySalt", () => {
  it("returns a stable salt within the same day", async () => {
    const a = await getDailySalt(env.SALT, "2026-06-21");
    const b = await getDailySalt(env.SALT, "2026-06-21");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("returns different salts for different days", async () => {
    const a = await getDailySalt(env.SALT, "2026-06-21");
    const b = await getDailySalt(env.SALT, "2026-06-22");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- salt`
Expected: FAIL ("getDailySalt is not a function").

- [ ] **Step 3: Append to `src/lib/identity.ts`**

```ts
export async function getDailySalt(kv: KVNamespace, day: string): Promise<string> {
  const key = `salt:${day}`;
  const existing = await kv.get(key);
  if (existing) return existing;
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const salt = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  // 48h TTL: yesterday's salt expires, making cross-day correlation impossible.
  await kv.put(key, salt, { expirationTtl: 60 * 60 * 48 });
  return salt;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- salt`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/identity.ts test/salt.test.ts
git commit -m "feat: KV daily-salt store with 48h TTL"
```

---

### Task 1.3: Collector — CORS preflight + validation

**Files:**
- Create: `src/collector.ts`
- Modify: `src/index.ts`
- Create: `test/collector.test.ts`

**Interfaces:**
- Consumes: `Env`.
- Produces: `handleCollect(req: Request, env: Env, ctx: ExecutionContext): Promise<Response>`; routed at `OPTIONS /e` and `POST /e`. Valid pageview body: `{ "t": "pv", "s": "<site_id>", "p": "<pathname>", "r": "<referrer>" }`. Invalid/oversized/unknown-site → non-204. Valid → 204.

- [ ] **Step 1: Write the failing test `test/collector.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";

beforeAll(async () => {
  const sql = readFileSync("migrations/0001_init.sql", "utf8");
  for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await env.DB.prepare(s).run();
});

function post(body: unknown) {
  return new Request("https://x/e", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "UA", "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

describe("collector /e", () => {
  it("answers CORS preflight", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x/e", { method: "OPTIONS" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects an unknown site", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ t: "pv", s: "nope", p: "/", r: "" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("accepts a valid pageview with 204", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ t: "pv", s: "default", p: "/home", r: "https://g.co" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- collector`
Expected: FAIL (route 404 / handler missing).

- [ ] **Step 3: Write `src/collector.ts`**

```ts
import type { Env } from "./lib/env";
import { deriveVid, getDailySalt, utcDay } from "./lib/identity";

const CORS = {
  "access-control-allow-origin": "*", // tightened to a per-site allowlist in Phase 3 (multi-site)
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

interface PageviewBody {
  t: "pv";
  s: string; // site_id
  p: string; // pathname
  r?: string; // referrer
}

function isPageview(v: unknown): v is PageviewBody {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.t === "pv" && typeof o.s === "string" && typeof o.p === "string";
}

export function handlePreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function handleCollect(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 2048) return new Response("payload too large", { status: 413, headers: CORS });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400, headers: CORS });
  }
  if (!isPageview(body)) return new Response("bad event", { status: 400, headers: CORS });

  const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(body.s).first<{ id: string }>();
  if (!site) return new Response("unknown site", { status: 400, headers: CORS });

  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const salt = await getDailySalt(env.SALT, utcDay(new Date()));
  const vid = await deriveVid(env.IDENTITY_HMAC_SECRET, salt, ip, ua, body.s);

  const country = (req.cf?.country as string | undefined) ?? "XX";
  let referrerHost = "";
  if (body.r) {
    try {
      referrerHost = new URL(body.r).hostname;
    } catch {
      /* ignore malformed referrer */
    }
  }

  env.WAE.writeDataPoint({
    indexes: [body.s], // 1 index, <=96 bytes
    blobs: [vid, body.p, referrerHost, country],
    doubles: [1],
  });

  return new Response(null, { status: 204, headers: CORS });
}
```

- [ ] **Step 4: Wire routes in `src/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./lib/env";
import { handleCollect, handlePreflight } from "./collector";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.text("ok"));
app.options("/e", () => handlePreflight());
app.post("/e", (c) => handleCollect(c.req.raw, c.env, c.executionCtx));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -- collector`
Expected: PASS (3 passed). (WAE `writeDataPoint` is a no-op in the test pool but does not throw.)

- [ ] **Step 6: Commit**

```bash
git add src/collector.ts src/index.ts test/collector.test.ts
git commit -m "feat: collector /e — CORS, validation, cookieless identity, WAE write"
```

---

### Task 1.4: The tracking script (`stratus.ts`) + size budget

**Files:**
- Create: `src/client/stratus.ts`
- Create: `scripts/check-size.mjs`
- Create: `scripts/check-cookieless.mjs`
- Create: `test/client.test.ts`

**Interfaces:**
- Produces: `dist/stratus.js` (built, minified, IIFE) that POSTs one pageview to `/e` on load and on `visibilitychange==='hidden'`, using `fetch(..., {keepalive:true})`, reading `site_id` from the script tag's `data-site` attribute. Sets no cookies/storage. ≤ 2 KB gz.

- [ ] **Step 1: Write the failing test `test/client.test.ts`** (verifies behavior via a DOM stub)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom-free minimal DOM/window stub for the IIFE under test.
function setup(href: string, siteAttr: string) {
  const calls: { url: string; opts: RequestInit }[] = [];
  const script = { getAttribute: (k: string) => (k === "data-site" ? siteAttr : null) };
  (globalThis as any).window = {};
  (globalThis as any).document = {
    currentScript: script,
    referrer: "https://ref.example",
    title: "T",
    addEventListener: () => {},
    visibilityState: "visible",
  };
  (globalThis as any).location = new URL(href);
  (globalThis as any).navigator = { sendBeacon: undefined };
  (globalThis as any).fetch = vi.fn((url: string, opts: RequestInit) => {
    calls.push({ url, opts });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  return calls;
}

describe("stratus client script", () => {
  beforeEach(() => vi.resetModules());

  it("posts a pageview to /e with site + path + referrer on load", async () => {
    const calls = setup("https://my.site/home?x=1", "default");
    await import("../src/client/stratus");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/e");
    const body = JSON.parse(calls[0]!.opts.body as string);
    expect(body).toMatchObject({ t: "pv", s: "default", p: "/home" });
    expect(calls[0]!.opts.keepalive).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- client`
Expected: FAIL (module `src/client/stratus` not found).

- [ ] **Step 3: Write `src/client/stratus.ts`** (kept tiny — no cookies, no storage)

```ts
// Stratus tracking script. Budget: <2KB gz. No cookies, no localStorage.
(function () {
  var d = document;
  var s = (d.currentScript as HTMLScriptElement | null);
  var site = s && s.getAttribute("data-site");
  if (!site) return;
  var endpoint = (s && s.getAttribute("data-endpoint")) || "/e";

  function send() {
    var body = JSON.stringify({
      t: "pv",
      s: site,
      p: location.pathname,
      r: d.referrer || "",
    });
    fetch(endpoint, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: body });
  }

  send(); // pageview on load
  d.addEventListener("visibilitychange", function () {
    if (d.visibilityState === "hidden") send();
  });
})();
```

- [ ] **Step 4: Write `scripts/check-size.mjs`**

```js
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const bytes = gzipSync(readFileSync("dist/stratus.js")).length;
const LIMIT = 2048;
console.log(`stratus.js gzipped: ${bytes} bytes (limit ${LIMIT})`);
if (bytes > LIMIT) {
  console.error(`FAIL: tracking script ${bytes}B exceeds ${LIMIT}B budget`);
  process.exit(1);
}
```

- [ ] **Step 5: Write `scripts/check-cookieless.mjs`**

```js
import { readFileSync } from "node:fs";

const src = readFileSync("src/client/stratus.ts", "utf8");
const banned = ["document.cookie", "localStorage", "sessionStorage", "indexedDB"];
const hits = banned.filter((b) => src.includes(b));
if (hits.length) {
  console.error(`FAIL: tracking script references banned storage APIs: ${hits.join(", ")}`);
  process.exit(1);
}
console.log("cookieless audit passed");
```

- [ ] **Step 6: Run unit test, build, and both checks**

Run: `npm run test -- client && npm run build:client && npm run check:size && npm run check:cookieless`
Expected: client test PASS; build emits `dist/stratus.js`; size check prints a number well under 2048 and exits 0; cookieless audit passes.

- [ ] **Step 7: Commit**

```bash
git add src/client/stratus.ts scripts/check-size.mjs scripts/check-cookieless.mjs test/client.test.ts
echo "dist/" >> .gitignore
git add .gitignore
git commit -m "feat: <2KB tracking script + size budget + cookieless CI gates"
```

---

### Task 1.5: WAE SQL client (`queryWae`)

**Files:**
- Create: `src/lib/wae.ts`
- Create: `test/wae.test.ts`

**Interfaces:**
- Consumes: `Env.CF_ACCOUNT_ID`, `Env.WAE_API_TOKEN`.
- Produces: `queryWae<T>(env: Env, sql: string, fetcher?: typeof fetch): Promise<T[]>` — POSTs to the Analytics Engine SQL API, returns `data` rows. The injectable `fetcher` lets tests stub the HTTP call (the SQL API is external, not a binding).

- [ ] **Step 1: Write the failing test `test/wae.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { queryWae } from "../src/lib/wae";

describe("queryWae", () => {
  it("POSTs SQL to the analytics_engine endpoint and returns rows", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/analytics_engine/sql");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      expect(init.body).toContain("SELECT");
      return new Response(JSON.stringify({ data: [{ day: "2026-06-21", pageviews: 5 }] }), { status: 200 });
    });
    const rows = await queryWae<{ day: string; pageviews: number }>(env, "SELECT 1", fakeFetch as unknown as typeof fetch);
    expect(rows).toEqual([{ day: "2026-06-21", pageviews: 5 }]);
  });

  it("throws on a non-200 response", async () => {
    const fakeFetch = vi.fn(async () => new Response("nope", { status: 429 }));
    await expect(queryWae(env, "SELECT 1", fakeFetch as unknown as typeof fetch)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- wae`
Expected: FAIL ("queryWae is not a function").

- [ ] **Step 3: Write `src/lib/wae.ts`**

```ts
import type { Env } from "./env";

export async function queryWae<T>(env: Env, sql: string, fetcher: typeof fetch = fetch): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetcher(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WAE_API_TOKEN}`, "content-type": "text/plain" },
    body: sql,
  });
  if (!res.ok) throw new Error(`WAE SQL ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: T[] };
  return json.data;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- wae`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wae.ts test/wae.test.ts
git commit -m "feat: Analytics Engine SQL API client with injectable fetcher"
```

---

### Task 1.6: Cron rollup → D1

**Files:**
- Create: `src/cron.ts`
- Modify: `src/index.ts`
- Create: `test/cron.test.ts`

**Interfaces:**
- Consumes: `queryWae`, `Env.DB`.
- Produces: `runRollups(env: Env, fetcher?: typeof fetch): Promise<void>` — queries WAE for per-day pageviews + visitors per site, upserts into `rollup_daily` (`metric` ∈ {`pageviews`,`visitors`}), and sets `sampled=1` when `SUM(_sample_interval) != count()`. Exported `scheduled` handler calls it.

> **Verify before building:** confirm the date-bucket function (`toStartOfInterval`/`toDate`) and `_sample_interval` usage against the current WAE SQL reference (`developers.cloudflare.com/analytics/analytics-engine/sql-reference/`). The query below uses documented functions as of the 2026-06-21 research; adjust the date function name if the reference differs.

- [ ] **Step 1: Write the failing test `test/cron.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { runRollups } from "../src/cron";

beforeAll(async () => {
  const sql = readFileSync("migrations/0001_init.sql", "utf8");
  for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await env.DB.prepare(s).run();
});

describe("runRollups", () => {
  it("upserts pageviews + visitors into rollup_daily from WAE rows", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ site_id: "default", day: "2026-06-21", pageviews: 10, visitors: 4, raw_rows: 10 }],
        }),
        { status: 200 },
      ),
    );
    await runRollups(env, fakeFetch as unknown as typeof fetch);

    const pv = await env.DB.prepare(
      "SELECT value, sampled FROM rollup_daily WHERE site_id='default' AND day='2026-06-21' AND metric='pageviews'",
    ).first<{ value: number; sampled: number }>();
    expect(pv?.value).toBe(10);
    expect(pv?.sampled).toBe(0); // pageviews == raw_rows -> unsampled

    const v = await env.DB.prepare(
      "SELECT value FROM rollup_daily WHERE site_id='default' AND day='2026-06-21' AND metric='visitors'",
    ).first<{ value: number }>();
    expect(v?.value).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- cron`
Expected: FAIL ("runRollups is not a function").

- [ ] **Step 3: Write `src/cron.ts`**

```ts
import type { Env } from "./lib/env";
import { queryWae } from "./lib/wae";

interface RollupRow {
  site_id: string;
  day: string;
  pageviews: number;
  visitors: number;
  raw_rows: number;
}

export async function runRollups(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  const days = Number(env.RETENTION_DAYS) || 90;
  // index1 = site_id, blob1 = vid, double1 = 1. Sampling-corrected via _sample_interval.
  const sql = `
    SELECT
      index1 AS site_id,
      formatDateTime(toDate(timestamp), '%Y-%m-%d') AS day,
      SUM(_sample_interval) AS pageviews,
      COUNT(DISTINCT blob1) AS visitors,
      count() AS raw_rows
    FROM stratus_events
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY site_id, day
  `;
  const rows = await queryWae<RollupRow>(env, sql, fetcher);

  const stmt = env.DB.prepare(
    `INSERT INTO rollup_daily (site_id, day, metric, value, sampled)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id, day, metric) DO UPDATE SET value=excluded.value, sampled=excluded.sampled`,
  );
  const batch = [];
  for (const r of rows) {
    const sampled = Math.round(r.pageviews) !== Math.round(r.raw_rows) ? 1 : 0;
    batch.push(stmt.bind(r.site_id, r.day, "pageviews", Math.round(r.pageviews), sampled));
    batch.push(stmt.bind(r.site_id, r.day, "visitors", Math.round(r.visitors), sampled));
  }
  if (batch.length) await env.DB.batch(batch);
}
```

- [ ] **Step 4: Add the `scheduled` handler in `src/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./lib/env";
import { handleCollect, handlePreflight } from "./collector";
import { runRollups } from "./cron";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.text("ok"));
app.options("/e", () => handlePreflight());
app.post("/e", (c) => handleCollect(c.req.raw, c.env, c.executionCtx));

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runRollups(env));
  },
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -- cron`
Expected: PASS (1 passed).

- [ ] **Step 6: Commit**

```bash
git add src/cron.ts src/index.ts test/cron.test.ts
git commit -m "feat: cron rollup WAE -> D1 with sampling-honesty flag"
```

---

### Task 1.7: Auth primitives (`hashPassword`, `signSession`, `verifySession`)

**Files:**
- Create: `src/lib/auth.ts`
- Create: `test/auth.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): Promise<string>` and `verifyPassword(pw: string, stored: string): Promise<boolean>` (PBKDF2 via Web Crypto, salt embedded).
  - `signSession(secret: string, userId: number, now: number): Promise<string>` and `verifySession(secret: string, token: string, now: number): Promise<number | null>` (HMAC-signed `userId|expiry`, 30-day expiry; returns userId or null).

- [ ] **Step 1: Write the failing test `test/auth.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, signSession, verifySession } from "../src/lib/auth";

describe("auth", () => {
  it("hashes and verifies a password", async () => {
    const h = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("signs and verifies a session token", async () => {
    const now = 1_000_000;
    const tok = await signSession("sec", 1, now);
    expect(await verifySession("sec", tok, now + 1000)).toBe(1);
  });

  it("rejects an expired token", async () => {
    const now = 1_000_000;
    const tok = await signSession("sec", 1, now);
    const later = now + 31 * 24 * 60 * 60 * 1000;
    expect(await verifySession("sec", tok, later)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const tok = await signSession("sec", 1, 1_000_000);
    expect(await verifySession("sec", tok + "x", 1_000_001)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- auth`
Expected: FAIL ("hashPassword is not a function").

- [ ] **Step 3: Write `src/lib/auth.ts`**

```ts
const enc = new TextEncoder();
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return `${toHex(salt.buffer)}:${toHex(bits)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return toHex(bits) === hashHex;
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export async function signSession(secret: string, userId: number, now: number): Promise<string> {
  const expiry = now + SESSION_MS;
  const payload = `${userId}|${expiry}`;
  return `${payload}|${await hmac(secret, payload)}`;
}

export async function verifySession(secret: string, token: string, now: number): Promise<number | null> {
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [userId, expiry, sig] = parts as [string, string, string];
  if (await hmac(secret, `${userId}|${expiry}`) !== sig) return null;
  if (now > Number(expiry)) return null;
  return Number(userId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- auth`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts test/auth.test.ts
git commit -m "feat: PBKDF2 password hashing + HMAC signed-session tokens"
```

---

### Task 1.8: Dashboard — login + authed time-series

**Files:**
- Create: `src/dashboard.ts`
- Modify: `src/index.ts`
- Create: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`, `hashPassword`, `signSession`, `verifySession`, `Env.DB`, `Env.AUTH_COOKIE_SECRET`.
- Produces: a Hono sub-app mounted at `/`:
  - `GET /login` (form), `POST /login` (sets `stratus_session` HttpOnly cookie on success).
  - `GET /` — redirects to `/login` if unauthenticated; else renders the last-30-days pageviews time-series for site `default` from `rollup_daily`.
  - First-run: if no `users` row exists, `POST /login` creates the owner from the submitted password.

- [ ] **Step 1: Write the failing test `test/dashboard.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";

beforeAll(async () => {
  const sql = readFileSync("migrations/0001_init.sql", "utf8");
  for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await env.DB.prepare(s).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO rollup_daily (site_id, day, metric, value, sampled) VALUES ('default','2026-06-20','pageviews',7,0)",
  ).run();
});

async function call(req: Request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("dashboard", () => {
  it("redirects unauthenticated / to /login", async () => {
    const res = await call(new Request("https://x/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("first-run login sets a session cookie", async () => {
    const res = await call(
      new Request("https://x/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=hunter2",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("stratus_session=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("shows the pageviews total when authenticated", async () => {
    const login = await call(
      new Request("https://x/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=hunter2",
      }),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await call(new Request("https://x/", { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("7");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- dashboard`
Expected: FAIL (route 404).

- [ ] **Step 3: Write `src/dashboard.ts`**

```ts
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "./lib/env";
import { hashPassword, verifyPassword, signSession, verifySession } from "./lib/auth";

export const dashboard = new Hono<{ Bindings: Env }>();

async function currentUser(c: { req: { raw: Request }; env: Env }): Promise<number | null> {
  const token = getCookie(c as never, "stratus_session");
  if (!token) return null;
  return verifySession(c.env.AUTH_COOKIE_SECRET, token, Date.now());
}

dashboard.get("/login", (c) =>
  c.html(
    `<!doctype html><meta charset=utf-8><title>Stratus login</title>
     <form method=post action=/login>
       <input type=password name=password placeholder=Password required>
       <button>Sign in</button>
     </form>`,
  ),
);

dashboard.post("/login", async (c) => {
  const form = await c.req.formData();
  const pw = String(form.get("password") ?? "");
  if (!pw) return c.text("password required", 400);

  let user = await c.env.DB.prepare("SELECT id, pw_hash FROM users ORDER BY id LIMIT 1").first<{ id: number; pw_hash: string }>();
  if (!user) {
    // first-run: create the owner
    const hash = await hashPassword(pw);
    const ins = await c.env.DB.prepare("INSERT INTO users (email, pw_hash) VALUES ('owner', ?)").bind(hash).run();
    user = { id: Number(ins.meta.last_row_id), pw_hash: hash };
  } else if (!(await verifyPassword(pw, user.pw_hash))) {
    return c.text("invalid password", 401);
  }

  const token = await signSession(c.env.AUTH_COOKIE_SECRET, user.id, Date.now());
  setCookie(c, "stratus_session", token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return c.redirect("/", 302);
});

dashboard.get("/", async (c) => {
  const uid = await currentUser(c);
  if (uid === null) return c.redirect("/login", 302);

  const rows = await c.env.DB.prepare(
    `SELECT day, value, sampled FROM rollup_daily
     WHERE site_id='default' AND metric='pageviews'
     ORDER BY day DESC LIMIT 30`,
  ).all<{ day: string; value: number; sampled: number }>();

  const total = rows.results.reduce((s, r) => s + r.value, 0);
  const list = rows.results
    .map((r) => `<li>${r.day}: ${r.value}${r.sampled ? " ~est" : ""}</li>`)
    .join("");
  return c.html(
    `<!doctype html><meta charset=utf-8><title>Stratus</title>
     <h1>Pageviews (last 30 days): ${total}</h1>
     <ul>${list}</ul>`,
  );
});
```

- [ ] **Step 4: Mount the dashboard in `src/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./lib/env";
import { handleCollect, handlePreflight } from "./collector";
import { runRollups } from "./cron";
import { dashboard } from "./dashboard";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.text("ok"));
app.options("/e", () => handlePreflight());
app.post("/e", (c) => handleCollect(c.req.raw, c.env, c.executionCtx));
app.route("/", dashboard);

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runRollups(env));
  },
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -- dashboard`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.ts src/index.ts test/dashboard.test.ts
git commit -m "feat: dashboard — first-run login, signed-cookie auth, pageviews time-series"
```

---

### Task 1.9: End-to-end loop test + README quickstart

**Files:**
- Create: `test/e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the full Worker (`fetch` + `runRollups`).
- Produces: a single test proving the loop: beacon → (WAE write, stubbed read) → rollup → D1 → dashboard shows the count. Plus a developer quickstart in the README.

- [ ] **Step 1: Write the failing test `test/e2e.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { runRollups } from "../src/cron";

beforeAll(async () => {
  const sql = readFileSync("migrations/0001_init.sql", "utf8");
  for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await env.DB.prepare(s).run();
});

describe("walking skeleton e2e", () => {
  it("ingests a pageview, rolls it up, and shows it on the dashboard", async () => {
    // 1. beacon -> collector (writes to WAE; no-op in test pool, must not throw)
    const ctx = createExecutionContext();
    const beacon = new Request("https://x/e", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "UA", "cf-connecting-ip": "9.9.9.9" },
      body: JSON.stringify({ t: "pv", s: "default", p: "/landing", r: "" }),
    });
    const res = await worker.fetch(beacon, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);

    // 2. cron rollup with a stubbed WAE SQL read (the event the collector "wrote")
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ site_id: "default", day: "2026-06-21", pageviews: 1, visitors: 1, raw_rows: 1 }] }), { status: 200 }),
    );
    await runRollups(env, fakeFetch as unknown as typeof fetch);

    // 3. login + dashboard shows the count
    const ctx2 = createExecutionContext();
    const login = await worker.fetch(
      new Request("https://x/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=pw" }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const ctx3 = createExecutionContext();
    const dash = await worker.fetch(new Request("https://x/", { headers: { cookie } }), env, ctx3);
    await waitOnExecutionContext(ctx3);
    const html = await dash.text();
    expect(html).toContain("Pageviews (last 30 days): 1");
  });
});
```

- [ ] **Step 2: Run to verify it fails (or passes if all wiring is correct)**

Run: `npm run test -- e2e`
Expected: PASS once all prior tasks are integrated. If it fails, the failure localizes the broken layer — fix that layer's task, not this test.

- [ ] **Step 3: Add a developer quickstart to `README.md`**

Append:
```markdown
## Local development (walking skeleton)

```bash
npm install
npm run ci            # typecheck + tests + build client + size & cookieless gates
npm run dev           # wrangler dev — Worker at http://localhost:8787

# embed the script on a test page:
# <script defer src="http://localhost:8787/stratus.js" data-site="default"
#         data-endpoint="http://localhost:8787/e"></script>
```

Set secrets before deploying: `IDENTITY_HMAC_SECRET`, `AUTH_COOKIE_SECRET`,
`CF_ACCOUNT_ID`, `WAE_API_TOKEN` (via `wrangler secret put <NAME>`).
```

- [ ] **Step 4: Run the full CI script**

Run: `npm run ci`
Expected: all green — typecheck clean, all tests pass, client builds, size < 2 KB, cookieless audit passes.

- [ ] **Step 5: Commit**

```bash
git add test/e2e.test.ts README.md
git commit -m "test: end-to-end walking-skeleton loop + dev quickstart"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage (vs technical spec §1–§7, scoped to Phase 0+1):**
- Collection layer (script, fetch+keepalive, visibilitychange) → Task 1.4 ✅
- Ingestion (CORS, validate, enrich, cookieless identity, WAE write) → Tasks 1.3 + 1.1 + 1.2 ✅
- Storage backbone (WAE write, D1 schema) → Tasks 1.3 + 0.2 ✅ (KV used for salt)
- Query/rollup (Cron WAE→D1, sampling-honesty flag) → Task 1.6 + 1.5 ✅
- Dashboard + self-rolled auth → Tasks 1.8 + 1.7 ✅
- Global constraints (≤2 KB gz, cookieless audit, AGPL) → Tasks 1.4 + 0.1 ✅
- **Deferred (correctly out of Phase 0+1, tracked in product-plan):** real-time DO (Phase 4), multi-site + per-site allowlist + custom events + SPA tracking (Phase 2–3), KV dashboard cache (Phase 2), one-click Deploy button (Phase 5), full dimension set (Phase 2). These are noted inline where the code stubs the seam (e.g. CORS `*` → allowlist in Phase 3).

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" left. The only `placeholder-set-on-deploy` strings are wrangler resource IDs, which are legitimately filled by `wrangler deploy`/the Deploy button. The one "verify before building" note (Task 1.6 WAE date function) is an explicit live-doc-check instruction with a working default query, not a gap.

**3. Type consistency:** `Env` (Task 0.1) is consumed unchanged everywhere. `deriveVid`/`getDailySalt`/`utcDay` (1.1/1.2) match their call sites in `collector.ts` (1.3). `queryWae` signature (1.5) matches `cron.ts` usage (1.6). `signSession`/`verifySession`/`hashPassword`/`verifyPassword` (1.7) match `dashboard.ts` (1.8). WAE write shape (index `site_id`, blobs `[vid, pathname, referrerHost, country]`, doubles `[1]`) in 1.3 matches the rollup query columns (`index1`, `blob1`, `_sample_interval`/`double1`) in 1.6.

---

## Execution Handoff

After the walking skeleton is green, the next plan covers **Phase 2** (full dimensions: referrers/UTM, device/browser/OS/geo, top pages, date-range picker, KV cache, sampling badge UI) — written once Phase 0+1 is merged. Real-time, multi-site, custom events, public dashboards, and the one-click deploy follow per `docs/specs/2026-06-21-product-plan.md` §3.

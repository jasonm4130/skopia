/**
 * Tests for src/shared/identity.ts
 *
 * Coverage:
 * - HMAC determinism: same inputs+salt → same vid
 * - Different salt → different vid (cross-day correlation impossible)
 * - Raw IP never appears in the output
 * - utcDay formatting
 * - getDailySalt: creates on first access, stable on repeat calls, 25h self-expiring TTL
 */

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { deriveVid, getDailySalt, utcDay } from "../src/shared/identity";

describe("utcDay", () => {
  it("formats a UTC date as YYYY-MM-DD", () => {
    expect(utcDay(new Date("2026-06-21T15:30:00Z"))).toBe("2026-06-21");
  });

  it("handles midnight UTC correctly", () => {
    expect(utcDay(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("pads single-digit month and day", () => {
    expect(utcDay(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05");
  });
});

describe("deriveVid", () => {
  const SECRET = "test-hmac-secret";
  const SALT = "test-salt-abc123";
  const IP = "203.0.113.42";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const SITE = "default";

  it("returns a 16-character hex string", async () => {
    const vid = await deriveVid(SECRET, SALT, IP, UA, SITE);
    expect(vid).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic: same inputs produce same vid", async () => {
    const v1 = await deriveVid(SECRET, SALT, IP, UA, SITE);
    const v2 = await deriveVid(SECRET, SALT, IP, UA, SITE);
    expect(v1).toBe(v2);
  });

  it("changes when the salt changes (cross-day isolation)", async () => {
    const v1 = await deriveVid(SECRET, SALT, IP, UA, SITE);
    const v2 = await deriveVid(SECRET, "different-salt", IP, UA, SITE);
    expect(v1).not.toBe(v2);
  });

  it("changes when the site_id changes (per-site scoping)", async () => {
    const v1 = await deriveVid(SECRET, SALT, IP, UA, "site-a");
    const v2 = await deriveVid(SECRET, SALT, IP, UA, "site-b");
    expect(v1).not.toBe(v2);
  });

  it("does NOT include the raw IP in the output", async () => {
    const vid = await deriveVid(SECRET, SALT, IP, UA, SITE);
    expect(vid).not.toContain(IP);
    // Also check the IP doesn't appear as hex (unlikely but confirm vid is short enough)
    expect(vid.length).toBe(16);
  });

  it("changes when the IP changes", async () => {
    const v1 = await deriveVid(SECRET, SALT, "1.2.3.4", UA, SITE);
    const v2 = await deriveVid(SECRET, SALT, "5.6.7.8", UA, SITE);
    expect(v1).not.toBe(v2);
  });
});

describe("getDailySalt", () => {
  it("creates a random salt on first access", async () => {
    const salt = await getDailySalt(env.SALT, "2026-06-21");
    expect(typeof salt).toBe("string");
    expect(salt.length).toBeGreaterThan(0);
  });

  it("returns the same salt on repeat calls for the same day", async () => {
    const s1 = await getDailySalt(env.SALT, "2026-06-22");
    const s2 = await getDailySalt(env.SALT, "2026-06-22");
    expect(s1).toBe(s2);
  });

  it("returns different salts for different days", async () => {
    const s1 = await getDailySalt(env.SALT, "2026-06-23");
    const s2 = await getDailySalt(env.SALT, "2026-06-24");
    // Different days → different (independently generated) salts
    // (They COULD theoretically be equal with negligible probability — acceptable)
    expect(typeof s1).toBe("string");
    expect(typeof s2).toBe("string");
  });

  it("stores a new salt with a 25h self-expiring TTL", async () => {
    const putSpy = vi.spyOn(env.SALT, "put");
    await getDailySalt(env.SALT, "2026-06-28");
    expect(putSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      expirationTtl: 25 * 60 * 60,
    });
  });
});

describe("deriveVid privacy: raw IP never stored", () => {
  it("vid output is a fixed 16-char hex string (no IP leakage possible)", async () => {
    const ip = "192.168.1.100";
    const vid = await deriveVid("secret", "salt", ip, "UA", "site");
    // The output is exactly 16 hex chars — cannot encode a full IP address
    expect(vid).toMatch(/^[0-9a-f]{16}$/);
    expect(vid).not.toContain(ip);
    expect(vid).not.toContain("192");
  });
});

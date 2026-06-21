/**
 * Tests for src/shared/config.ts
 *
 * Coverage:
 * - requireSecrets throws SecretsMissingError with correct .missing when a secret is undefined
 * - requireSecrets throws SecretsMissingError with correct .missing when a secret is empty string
 * - requireSecrets does not throw when all named secrets are present
 * - SecretsMissingError lists all missing names (not just the first)
 */

import { describe, it, expect } from "vitest";
import { requireSecrets, SecretsMissingError } from "../src/shared/config";
import type { Env } from "../src/shared/types";

// Minimal Env stub: only the fields under test need values; everything else is cast.
function makeEnv(overrides: Partial<Record<keyof Env, string>>): Env {
  return overrides as unknown as Env;
}

describe("requireSecrets", () => {
  it("throws SecretsMissingError when a secret is undefined", () => {
    const env = makeEnv({});
    expect(() => requireSecrets(env, ["AUTH_COOKIE_SECRET"])).toThrow(SecretsMissingError);
  });

  it("includes the missing name in .missing", () => {
    const env = makeEnv({});
    try {
      requireSecrets(env, ["AUTH_COOKIE_SECRET"]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsMissingError);
      expect((err as SecretsMissingError).missing).toEqual(["AUTH_COOKIE_SECRET"]);
    }
  });

  it("throws SecretsMissingError when a secret is an empty string", () => {
    const env = makeEnv({ AUTH_COOKIE_SECRET: "" });
    try {
      requireSecrets(env, ["AUTH_COOKIE_SECRET"]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsMissingError);
      expect((err as SecretsMissingError).missing).toEqual(["AUTH_COOKIE_SECRET"]);
    }
  });

  it("does not throw when all secrets are present and non-empty", () => {
    const env = makeEnv({ AUTH_COOKIE_SECRET: "some-secret-value" });
    expect(() => requireSecrets(env, ["AUTH_COOKIE_SECRET"])).not.toThrow();
  });

  it("lists ALL missing names (not just the first)", () => {
    const env = makeEnv({ AUTH_COOKIE_SECRET: "present" });
    try {
      requireSecrets(env, ["AUTH_COOKIE_SECRET", "IDENTITY_HMAC_SECRET"]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsMissingError);
      expect((err as SecretsMissingError).missing).toEqual(["IDENTITY_HMAC_SECRET"]);
    }
  });

  it("lists multiple missing names when both are absent", () => {
    const env = makeEnv({});
    try {
      requireSecrets(env, ["AUTH_COOKIE_SECRET", "IDENTITY_HMAC_SECRET"]);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsMissingError);
      expect((err as SecretsMissingError).missing).toContain("AUTH_COOKIE_SECRET");
      expect((err as SecretsMissingError).missing).toContain("IDENTITY_HMAC_SECRET");
      expect((err as SecretsMissingError).missing).toHaveLength(2);
    }
  });

  it("SecretsMissingError is an instance of Error", () => {
    const env = makeEnv({});
    try {
      requireSecrets(env, ["AUTH_COOKIE_SECRET"]);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("AUTH_COOKIE_SECRET");
    }
  });
});

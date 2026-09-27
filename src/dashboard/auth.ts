/**
 * Skopia — dashboard auth primitives (spec §7.2): HMAC-SHA256 signed session
 * cookie, PBKDF2 password hashing, and the requireAuth middleware. Web Crypto
 * only.
 */

import type { Context, Next } from "hono";
import { requireSecrets, SecretsMissingError } from "../shared/config";
import type { DashEnv } from "./env";
import { notConfiguredPage } from "./render/pages";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

export const COOKIE_NAME = "skopia_session";
export const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signCookie(userId: number, expiry: number, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const payload = `${userId}|${expiry}`;
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${payload}.${sigHex}`;
}

export async function verifyCookie(value: string, secret: string): Promise<number | null> {
  const dotIdx = value.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payload = value.slice(0, dotIdx);
  const sigHex = value.slice(dotIdx + 1);
  const pipeIdx = payload.indexOf("|");
  if (pipeIdx === -1) return null;
  const userIdStr = payload.slice(0, pipeIdx);
  const expiryStr = payload.slice(pipeIdx + 1);
  const userId = parseInt(userIdStr, 10);
  const expiry = parseInt(expiryStr, 10);
  if (Number.isNaN(userId) || Number.isNaN(expiry)) return null;
  if (Date.now() > expiry) return null;

  const key = await getHmacKey(secret);
  const enc = new TextEncoder();

  // Decode the submitted signature hex to bytes.
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
  if (sigBytes.length === 0) return null;

  // Platform constant-time HMAC verify (avoids manual hex comparison).
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
  return valid ? userId : null;
}

/** decodeURIComponent throws URIError on a lone/invalid '%' escape — never let one bad cookie 500 the request. */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((c) => {
      const eq = c.indexOf("=");
      return eq === -1
        ? [c.trim(), ""]
        : [c.slice(0, eq).trim(), safeDecodeURIComponent(c.slice(eq + 1).trim())];
    }),
  );
}

// The Workers runtime caps PBKDF2 at 100k iterations — a runtime policy, not
// a compat-dated behavior (enforcement reached production ~2026-07 and turned
// every login into a 500 while this code asked for 210k). Local workerd does
// NOT enforce the cap, so tests can't catch a raise; the verify clamp below is
// the guard. Higher work factors aren't available in Workers WebCrypto.
export const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  // Derive a 32-byte salt via random bytes, then PBKDF2 for the hash.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2:")) return false;
  const parts = stored.split(":");
  let iterations: number;
  let saltHex: string;
  let expectedHex: string;
  if (parts.length === 4) {
    // v2 format: pbkdf2:<iterations>:<salt>:<hash>
    iterations = Number(parts[1]);
    saltHex = parts[2] as string;
    expectedHex = parts[3] as string;
  } else if (parts.length === 3) {
    // Legacy v1 format (no embedded count): those hashes were derived at 100k.
    iterations = 100_000;
    saltHex = parts[1] as string;
    expectedHex = parts[2] as string;
  } else {
    return false;
  }
  // Never derive above the runtime cap — deriveBits would throw in production
  // (NotSupportedError), turning a bad stored hash into a 500 instead of a 401.
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  let bits: ArrayBuffer;
  try {
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256,
    );
  } catch {
    // Any future runtime policy change degrades to "invalid credentials",
    // never a 500.
    return false;
  }
  const hashHex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time compare
  if (hashHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hashHex.length; i++) {
    diff |= hashHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

// Fixed PBKDF2 hash burned at module load so a wrong-email login still pays
// the same cost as a wrong-password login (timing oracle fix). Generated
// once with hashPassword(); the password behind it was discarded and is
// never a real account's.
export const DUMMY_PW_HASH =
  "pbkdf2:100000:524fefbac9c6134c2670b09d5e378de5:35fbc1405f9293d4a7caff3c4a0cb75beb6999be6b2e9ee09e775e1f3726388a";

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export async function requireAuth(c: Context<DashEnv>, next: Next): Promise<Response | void> {
  // Fail closed: on a cold deploy AUTH_COOKIE_SECRET may be unset. Reading a
  // stale session cookie would pass undefined/"" into the HMAC import and throw
  // an unhandled 500. Guard before touching the cookie and surface a clear
  // "not configured" page instead.
  try {
    requireSecrets(c.env, ["AUTH_COOKIE_SECRET"]);
  } catch (err) {
    if (err instanceof SecretsMissingError) {
      return c.html(notConfiguredPage(c.get("nonce"), err.missing), 500);
    }
    throw err;
  }

  const cookies = parseCookies(c.req.header("cookie") ?? null);
  const cookieVal = cookies[COOKIE_NAME];
  if (cookieVal) {
    const userId = await verifyCookie(cookieVal, c.env.AUTH_COOKIE_SECRET);
    if (userId !== null) {
      c.set("userId", userId);
      return next();
    }
  }
  return c.redirect("/login");
}

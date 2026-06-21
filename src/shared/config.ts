/**
 * Skopia — fail-closed secret guard (foundation-owned).
 *
 * Cold deploys leave the crypto secrets unset; reading them as `undefined` makes
 * the collector throw a 500 and the auth path sign cookies with the literal key
 * `undefined` (forgeable sessions). Call {@link requireSecrets} at request entry,
 * BEFORE any crypto, and translate the thrown {@link SecretsMissingError} into a
 * clear "not configured" response (collector → 503, dashboard → 500 page).
 */

import type { Env } from "./types";

/** Thrown by {@link requireSecrets} listing every required secret that is unset. */
export class SecretsMissingError extends Error {
  constructor(public missing: string[]) {
    super(`Missing required secrets: ${missing.join(", ")}`);
    this.name = "SecretsMissingError";
  }
}

/**
 * Throws {@link SecretsMissingError} if any named env value is undefined or an
 * empty string. Treats empty string as missing so a blank Deploy-button prompt
 * fails closed rather than signing with "".
 */
export function requireSecrets(env: Env, names: ReadonlyArray<keyof Env>): void {
  const missing = names.filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
  if (missing.length > 0) {
    throw new SecretsMissingError(missing as string[]);
  }
}

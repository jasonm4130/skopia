/**
 * Skopia — cookieless visitor identity (foundation-owned signatures, FINAL).
 *
 * The visitor id is a daily-salted HMAC over (ip, ua, site_id). The raw IP is
 * NEVER persisted; each day's salt self-expires via KV TTL (see
 * {@link getDailySalt}), so cross-day correlation is impossible (spec §3.5 /
 * ADR-0002).
 */

// Module-level single-entry memo: the collector calls deriveVid with the same
// IDENTITY_HMAC_SECRET on every request within an isolate, so importing the
// HMAC key is otherwise a wasted crypto.subtle round trip per beacon.
let hmacKeyMemo: { secret: string; key: CryptoKey } | null = null;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (hmacKeyMemo && hmacKeyMemo.secret === secret) return hmacKeyMemo.key;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  hmacKeyMemo = { secret, key };
  return key;
}

/**
 * Derive a 16-hex-char cookieless visitor id.
 * Deterministic for identical inputs within a day; changes when the salt rotates
 * or the site differs. Raw ip/ua are consumed here and never returned or stored.
 *
 * @param secret   the IDENTITY_HMAC_SECRET
 * @param salt     today's daily salt (from {@link getDailySalt})
 * @param ip       client IP (cf-connecting-ip) — never persisted
 * @param ua       User-Agent header
 * @param siteId   the site_id (scopes the id per site)
 */
export async function deriveVid(
  secret: string,
  salt: string,
  ip: string,
  ua: string,
  siteId: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await importHmacKey(secret);
  // The message is: salt|ip|ua|siteId (pipe-separated; raw IP consumed + discarded)
  const message = `${salt}|${ip}|${ua}|${siteId}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  // Take the first 8 bytes (64 bits) → 16 hex chars
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    const b = bytes[i];
    if (b !== undefined) hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Get the salt for a UTC day, creating + storing a random one (48 h TTL) on first
 * access. Stable within the same day; different across days.
 *
 * @param kv   the SALT KV namespace
 * @param day  UTC 'YYYY-MM-DD'
 */
export async function getDailySalt(kv: KVNamespace, day: string): Promise<string> {
  const key = `salt:${day}`;
  const existing = await kv.get(key);
  if (existing !== null) return existing;

  // Generate a cryptographically random 32-byte salt, hex-encoded
  const random = crypto.getRandomValues(new Uint8Array(32));
  let salt = "";
  for (const b of random) salt += b.toString(16).padStart(2, "0");

  // TTL = 25 h (ADR-0011): the date-keyed salt is only needed for its own UTC
  // day; ~25 h self-deletion preserves the ~24 h cross-day-correlation window
  // the cron's explicit delete previously provided.
  await kv.put(key, salt, { expirationTtl: 25 * 60 * 60 });
  return salt;
}

/** Format a Date as a UTC day string, 'YYYY-MM-DD'. */
export function utcDay(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

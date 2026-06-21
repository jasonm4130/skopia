/**
 * Stratus — cookieless visitor identity (foundation-owned signatures, FINAL).
 *
 * The visitor id is a daily-salted HMAC over (ip, ua, site_id). The raw IP is
 * NEVER persisted; the salt rotates at UTC midnight and yesterday's salt is
 * deleted, so cross-day correlation is impossible (spec §3.5 / ADR-0002).
 */

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
  // Import the IDENTITY_HMAC_SECRET as a sign key
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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

  // TTL = 48 h so yesterday's salt expires automatically (spec §3.5)
  await kv.put(key, salt, { expirationTtl: 48 * 60 * 60 });
  return salt;
}

/**
 * Rotate the daily salt: ensure today's salt exists and let yesterday's expire.
 * Called by the cron daily pass (spec §3.5). Idempotent.
 *
 * @param kv   the SALT KV namespace
 * @param now  the current time
 */
export async function rotateDailySalt(kv: KVNamespace, now: Date): Promise<void> {
  const today = utcDay(now);
  // Ensure today's salt is created (getDailySalt is idempotent: no-op if exists)
  await getDailySalt(kv, today);
  // Yesterday's salt was stored with a 48 h TTL, so it expires on its own.
  // Explicitly delete it for prompter cross-day correlation prevention.
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = `salt:${utcDay(yesterday)}`;
  await kv.delete(yesterdayKey);
}

/** Format a Date as a UTC day string, 'YYYY-MM-DD'. */
export function utcDay(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

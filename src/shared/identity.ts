/**
 * Stratus — cookieless visitor identity (foundation-owned signatures, FINAL).
 *
 * The visitor id is a daily-salted HMAC over (ip, ua, site_id). The raw IP is
 * NEVER persisted; the salt rotates at UTC midnight and yesterday's salt is
 * deleted, so cross-day correlation is impossible (spec §3.5 / ADR-0002).
 *
 * Stubs throw until the backbone/collector agent implements them.
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
  void secret, void salt, void ip, void ua, void siteId;
  throw new Error("not implemented");
}

/**
 * Get the salt for a UTC day, creating + storing a random one (48 h TTL) on first
 * access. Stable within the same day; different across days.
 *
 * @param kv   the SALT KV namespace
 * @param day  UTC 'YYYY-MM-DD'
 */
export async function getDailySalt(kv: KVNamespace, day: string): Promise<string> {
  void kv, void day;
  throw new Error("not implemented");
}

/**
 * Rotate the daily salt: ensure today's salt exists and let yesterday's expire.
 * Called by the cron daily pass (spec §3.5). Idempotent.
 *
 * @param kv   the SALT KV namespace
 * @param now  the current time
 */
export async function rotateDailySalt(kv: KVNamespace, now: Date): Promise<void> {
  void kv, void now;
  throw new Error("not implemented");
}

/** Format a Date as a UTC day string, 'YYYY-MM-DD'. */
export function utcDay(now: Date): string {
  void now;
  throw new Error("not implemented");
}

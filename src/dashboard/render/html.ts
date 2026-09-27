/** Skopia — HTML escaping + number formatting shared by every render module. */

/** Escape a string for safe insertion into HTML text content or attributes. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for safe embedding inside an inline `<script>` block.
 * `JSON.stringify` does not neutralize "</script>" (or a literal U+2028 /
 * U+2029 line separator) inside a string value — an attacker-controlled
 * value could otherwise close the script tag early. Escaping the TEXT of
 * the JSON output (not the runtime characters) keeps it valid JSON/JS.
 */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------
// Formatting helpers (server-side counterpart to the design's fmt())
// ---------------------------------------------------------------------------

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function fmtPct(r: number): string {
  return `${Math.round(r * 100)}%`;
}

// Fail the build if the BUILT tracking script references any client-side storage
// API. Cookieless-by-architecture is a product guarantee (spec §0 / CLAUDE.md).
// Scans dist/skopia.js so the minified output — what actually ships — is audited.
import { readFileSync } from "node:fs";

const FILE = "dist/skopia.js";
const BANNED = ["document.cookie", "localStorage", "sessionStorage", "indexedDB"];

let src;
try {
  src = readFileSync(FILE, "utf8");
} catch {
  console.error(`FAIL: ${FILE} not found — run "npm run build:script" first.`);
  process.exit(1);
}

const hits = BANNED.filter((api) => src.includes(api));
if (hits.length) {
  console.error(`FAIL: tracking script references banned storage APIs: ${hits.join(", ")}`);
  process.exit(1);
}
console.log(`PASS: cookieless audit clean (no ${BANNED.join(" / ")}).`);

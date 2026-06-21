// Fail the build if the tracking script exceeds the 2 KB gzipped budget.
// Run after `npm run build:script` (emits dist/stratus.js). Spec §2 / CLAUDE.md.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const FILE = "dist/stratus.js";
const LIMIT = 2048;

let raw;
try {
  raw = readFileSync(FILE);
} catch {
  console.error(`FAIL: ${FILE} not found — run "npm run build:script" first.`);
  process.exit(1);
}

const gz = gzipSync(raw, { level: 9 }).length;
console.log(`${FILE}: ${raw.length} B raw, ${gz} B gzipped (limit ${LIMIT} B)`);

if (gz > LIMIT) {
  console.error(`FAIL: tracking script ${gz} B gzipped exceeds the ${LIMIT} B budget.`);
  process.exit(1);
}
console.log("PASS: tracking script within the 2 KB gzipped budget.");

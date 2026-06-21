// Fail the build if any source file references a known third-party host. The
// privacy thesis requires ZERO third-party requests from rendered pages (plan
// Task 3); fonts + jsVectorMap are vendored under public/. Scans src/ ONLY —
// vendored files under public/ are the allowed self-hosted copies.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const SRC = resolve(root, "src");

const BANNED = /googleapis|gstatic|jsdelivr|unpkg|cdnjs|cdn\./;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (full.endsWith(".ts")) files.push(full);
  }
  return files;
}

const hits = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (BANNED.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (hits.length) {
  console.error("check-no-external: FAIL — third-party host(s) referenced in src/:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log("no-external: OK");

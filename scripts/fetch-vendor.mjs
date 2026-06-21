/**
 * fetch-vendor.mjs — download the self-hosted assets into public/ so rendered
 * pages make ZERO third-party requests (plan Task 3, the privacy thesis).
 *
 *   (a) Latin + latin-ext woff2 for Space Grotesk (400/500/600/700),
 *       Hanken Grotesk (400/500/600/700), JetBrains Mono (400/500) → public/fonts/
 *   (b) jsVectorMap 1.6.0 css/js + maps/world.js → public/vendor/jsvectormap@1.6.0/
 *
 * Commit the fetched files (simplest for the Deploy button; a version bump is a
 * deliberate PR). Run: `npm run fetch-vendor`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const FONTS_DIR = resolve(root, "public/fonts");
const VENDOR_DIR = resolve(root, "public/vendor/jsvectormap@1.6.0");

// A modern desktop UA so Google Fonts' css2 endpoint serves woff2 (not ttf).
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const JSVM = "https://cdn.jsdelivr.net/npm/jsvectormap@1.6.0/dist";

// Google Fonts families → weights. css2 axis order is ital,wght (we only want
// upright). Each "subset" maps a css2 family spec to a filename prefix.
const FONTS = [
  { name: "Space Grotesk", prefix: "space-grotesk", weights: [400, 500, 600, 700] },
  { name: "Hanken Grotesk", prefix: "hanken-grotesk", weights: [400, 500, 600, 700] },
  { name: "JetBrains Mono", prefix: "jetbrains-mono", weights: [400, 500] },
];

// Only keep the latin + latin-ext @font-face blocks (drop cyrillic/greek/viet).
const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);

function buildCss2Url(name, weights) {
  const fam = name.replace(/ /g, "+");
  return `https://fonts.googleapis.com/css2?family=${fam}:wght@${weights.join(";")}&display=swap`;
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function fetchBuffer(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Parse a Google Fonts css2 response into per-@font-face descriptors, keeping
 * only the latin / latin-ext blocks. Google annotates each block with a
 * `/* subset *\/` comment line immediately before it.
 */
function parseFontFaces(css, weights) {
  const out = [];
  // Split on the subset comment markers Google emits, e.g. "/* latin */".
  const parts = css.split(/\/\*\s*([\w-]+)\s*\*\//).slice(1);
  for (let i = 0; i < parts.length; i += 2) {
    const subset = parts[i];
    const block = parts[i + 1] ?? "";
    if (!KEEP_SUBSETS.has(subset)) continue;
    const wghtMatch = block.match(/font-weight:\s*(\d+)/);
    const urlMatch = block.match(/url\(([^)]+\.woff2)\)/);
    if (!wghtMatch || !urlMatch) continue;
    const weight = Number(wghtMatch[1]);
    if (!weights.includes(weight)) continue;
    out.push({ subset, weight, url: urlMatch[1].replace(/['"]/g, "") });
  }
  return out;
}

async function main() {
  mkdirSync(FONTS_DIR, { recursive: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(resolve(FONTS_DIR, ".gitkeep"), "");
  writeFileSync(resolve(VENDOR_DIR, ".gitkeep"), "");

  const written = [];

  // (a) Fonts.
  for (const { name, prefix, weights } of FONTS) {
    const css = await fetchText(buildCss2Url(name, weights), { "User-Agent": UA });
    const faces = parseFontFaces(css, weights);
    if (faces.length === 0) {
      throw new Error(`no latin/latin-ext woff2 faces parsed for ${name}`);
    }
    for (const face of faces) {
      const filename = `${prefix}-${face.weight}-${face.subset}.woff2`;
      const buf = await fetchBuffer(face.url, { "User-Agent": UA });
      writeFileSync(resolve(FONTS_DIR, filename), buf);
      written.push(`fonts/${filename}`);
    }
  }

  // (b) jsVectorMap 1.6.0.
  const vendorFiles = [
    { url: `${JSVM}/jsvectormap.min.css`, name: "jsvectormap.min.css" },
    { url: `${JSVM}/jsvectormap.min.js`, name: "jsvectormap.min.js" },
    { url: `${JSVM}/maps/world.js`, name: "world.js" },
  ];
  for (const { url, name } of vendorFiles) {
    const buf = await fetchBuffer(url);
    writeFileSync(resolve(VENDOR_DIR, name), buf);
    written.push(`vendor/jsvectormap@1.6.0/${name}`);
  }

  console.log("fetch-vendor: wrote " + written.length + " files:");
  for (const f of written) console.log("  public/" + f);
}

main().catch((err) => {
  // Network may be unavailable in CI/sandbox. Leave .gitkeep placeholders and
  // tell the operator to fetch before deploy — do NOT hard-fail the toolchain.
  try {
    mkdirSync(FONTS_DIR, { recursive: true });
    mkdirSync(VENDOR_DIR, { recursive: true });
    writeFileSync(resolve(FONTS_DIR, ".gitkeep"), "");
    writeFileSync(resolve(VENDOR_DIR, ".gitkeep"), "");
  } catch {
    /* ignore */
  }
  console.error("fetch-vendor: FAILED to download assets — " + err.message);
  console.error(
    "fetch-vendor: assets MUST be fetched via `npm run fetch-vendor` before deploy.",
  );
  process.exitCode = 1;
});

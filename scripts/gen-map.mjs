/**
 * gen-map.mjs — rasterise a world outline into the dashboard's hex dot map.
 *
 * Input: jsVectorMap 1.6.0's `dist/maps/world.js` (MIT). It is no longer
 * vendored; recover it from git history or the npm tarball, e.g.
 *   git show 1f5f677:public/vendor/jsvectormap@1.6.0/world.js > /tmp/world.js
 *   node scripts/gen-map.mjs /tmp/world.js
 *
 * Output (both committed):
 *   public/assets/map-base.svg        — every land dot, one static cacheable file
 *   src/dashboard/render/map-data.ts  — per-ISO-code dot paths, so the SSR can
 *                                       light any country with no client library
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/gen-map.mjs <path to jsvectormap world.js>");
  process.exit(1);
}

let map;
globalThis.jsVectorMap = {
  addMap: (_name, m) => {
    map = m;
  },
};
new Function(readFileSync(input, "utf8"))();

// Parse each country's SVG path (M/l/L/Z only) into polygon rings.
const polys = {};
for (const [cc, { path }] of Object.entries(map.paths)) {
  const rings = [];
  let ring = null;
  let x = 0;
  let y = 0;
  for (const [, c, args] of path.matchAll(/([MlLZ])([^MlLZ]*)/g)) {
    const n = args.split(/[ ,]+/).filter(Boolean).map(Number);
    if (c === "M") {
      x = n[0];
      y = n[1];
      ring = [[x, y]];
      rings.push(ring);
    } else if (c === "l") {
      for (let i = 0; i < n.length; i += 2) {
        x += n[i];
        y += n[i + 1];
        ring.push([x, y]);
      }
    } else if (c === "L") {
      for (let i = 0; i < n.length; i += 2) {
        x = n[i];
        y = n[i + 1];
        ring.push([x, y]);
      }
    }
  }
  polys[cc] = rings;
}

// Even-odd point-in-polygon across all of a country's rings.
const inside = (rings, px, py) => {
  let c = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
  return c;
};

// Hex grid: 6 px across, 5.2 px down, odd rows offset. Antarctica is dropped.
const DX = 6;
const DY = 5.2;
const H = 400;
const base = [];
const cc = {};
for (let row = 0, y = 3; y < H; row++, y = +(3 + row * DY).toFixed(1)) {
  for (let x = row % 2 ? 6 : 3; x < 900; x += DX) {
    for (const [k, rings] of Object.entries(polys)) {
      if (k !== "AQ" && inside(rings, x, y)) {
        const p = `M${x} ${y}h0`;
        base.push(p);
        cc[k] = cc[k] ?? [];
        cc[k].push(p);
        break;
      }
    }
  }
}

// ---------- fallback dots for places the grid misses ----------
// A country smaller than the grid pitch (BE, DK, IL, TW, LU…) gets no sample
// inside its outline, and some (SG, HK, MT, BH…) have no outline at all. Either
// way a site visited mostly from there would show a dark map, so every such
// place gets one dot at the grid point nearest its centre.
const snap = (px, py) => {
  const row = Math.max(0, Math.round((py - 3) / DY));
  const y = +(3 + row * DY).toFixed(1);
  const off = row % 2 ? 6 : 3;
  const x = off + Math.round((px - off) / DX) * DX;
  return `M${x} ${y}h0`;
};
const addDot = (k, p) => {
  if (!base.includes(p)) base.push(p);
  cc[k] = cc[k] ?? [];
  cc[k].push(p);
};

// Outline present, no grid sample inside: the area-weighted centroid of its
// largest ring (the mainland, not an outlying island).
const ringArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
};
const centroid = (r) => {
  const a = ringArea(r);
  if (Math.abs(a) < 1e-9) {
    const n = r.length;
    return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    cx += (r[j][0] + r[i][0]) * f;
    cy += (r[j][1] + r[i][1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
};
for (const [k, rings] of Object.entries(polys)) {
  if (k === "AQ" || cc[k]) continue;
  const big = rings.reduce((m, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(m)) ? r : m));
  addDot(k, snap(...centroid(big)));
}

// No outline at all: place by latitude/longitude through the map's own Miller
// projection (single inset, central meridian from the source file).
const { projection, insets } = map;
const [inset] = insets;
const R = 6381372;
const RAD = Math.PI / 180;
const project = (lat, lng) => {
  let l = lng;
  if (l < -180 + projection.centralMeridian) l += 360;
  const mx = R * (l - projection.centralMeridian) * RAD;
  const my = (-R * Math.log(Math.tan((45 + 0.4 * lat) * RAD))) / 0.8;
  const [b0, b1] = inset.bbox;
  return [
    inset.left + ((mx - b0.x) / (b1.x - b0.x)) * inset.width,
    inset.top + ((my - b0.y) / (b1.y - b0.y)) * inset.height,
  ];
};
// Self-check: Paris must project inside France's outline.
if (!inside(polys.FR, ...project(48.86, 2.35))) throw new Error("gen-map: projection check failed");
const POINTS = {
  AD: [42.5, 1.5],
  AG: [17.1, -61.8],
  BB: [13.1, -59.6],
  BH: [26.0, 50.55],
  CV: [15.1, -23.6],
  DM: [15.4, -61.4],
  FM: [6.9, 158.2],
  GD: [12.1, -61.7],
  HK: [22.32, 114.17],
  KI: [1.87, -157.4],
  KM: [-11.7, 43.3],
  KN: [17.3, -62.7],
  LC: [13.9, -61.0],
  LI: [47.16, 9.55],
  MC: [43.74, 7.42],
  MH: [7.1, 171.2],
  MO: [22.2, 113.55],
  MT: [35.9, 14.4],
  MU: [-20.2, 57.5],
  MV: [3.2, 73.2],
  NR: [-0.53, 166.9],
  PW: [7.5, 134.6],
  SC: [-4.68, 55.49],
  SG: [1.35, 103.82],
  SM: [43.94, 12.46],
  ST: [0.19, 6.61],
  TO: [-21.2, -175.2],
  TV: [-8.5, 179.2],
  VA: [41.9, 12.45],
  VC: [13.25, -61.2],
  WS: [-13.76, -172.1],
};
for (const [k, [lat, lng]] of Object.entries(POINTS)) {
  if (!cc[k]) addDot(k, snap(...project(lat, lng)));
}

// Every outline country (bar Antarctica) must now have at least one dot; the
// test suite re-checks this against the code list written below.
const outline = Object.keys(polys)
  .filter((k) => k !== "AQ")
  .sort();
const dark = outline.filter((k) => !cc[k]);
if (dark.length) throw new Error(`gen-map: no dots for ${dark.join(", ")}`);
writeFileSync(
  resolve(root, "test/fixtures/map-outline-codes.json"),
  `${JSON.stringify(outline, null, 2)}\n`,
);

writeFileSync(
  resolve(root, "public/assets/map-base.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 906 ${H + 3}"><path fill="none" stroke="#262c28" stroke-width="3.3" stroke-linecap="round" d="${base.join("")}"/></svg>\n`,
);

const entries = Object.keys(cc)
  .sort()
  .map((k) => `  ${k}: "${cc[k].join("")}",`)
  .join("\n");
writeFileSync(
  resolve(root, "src/dashboard/render/map-data.ts"),
  `// GENERATED by scripts/gen-map.mjs — do not edit. Per-country dot paths for the
// hex dot map; the unlit base grid is public/assets/map-base.svg.

/** Height of the dot grid in map units (width is 900). */
export const MAP_H = ${H};

/** ISO 3166-1 alpha-2 code → SVG path of that country's dots. */
export const COUNTRY_DOTS: Record<string, string> = {
${entries}
};
`,
);
console.log(`gen-map: ${base.length} dots, ${Object.keys(cc).length} countries`);

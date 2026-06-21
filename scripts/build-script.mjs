/**
 * build-script.mjs — bundles + minifies the tracking script via esbuild's JS API.
 *
 * Uses the API (not the `esbuild` CLI) so it is robust under pnpm: the CLI bin is
 * a native binary that pnpm's node-based bin shim cannot exec. The JS API spawns
 * the native binary as a subprocess directly. Output equals the prior CLI flags
 * (--bundle --minify --format=iife). Followed by scripts/build-embed.mjs.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/script/stratus.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "dist/stratus.js",
});

console.log("build-script: wrote dist/stratus.js");

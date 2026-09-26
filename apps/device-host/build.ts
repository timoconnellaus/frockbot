// Bundles the module host and the module runtime into two standalone ES
// modules for the Mac app's Deno: `device-host.js` and `device-runtime.js`.
// Node's built-ins stay imports, which Deno serves; everything else, the app's
// and core's code included, is inlined.
//
//   bun apps/device-host/build.ts <out-dir>

import { join, resolve } from "node:path";

import { build } from "esbuild";

const out = resolve(process.argv[2] ?? join(import.meta.dirname, "dist"));

await build({
  entryPoints: {
    "device-host": join(import.meta.dirname, "src/host.ts"),
    "device-runtime": join(import.meta.dirname, "src/runtime.ts"),
  },
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2023",
  logLevel: "warning",
});

console.log(out);

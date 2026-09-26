// Bundles the module host and the module runtime into two standalone ES
// modules for the Mac app's Deno: `device-host.js` and `device-runtime.js`.
// Node's built-ins stay imports, which Deno serves; everything else, the app's
// and core's code included, is inlined.
//
//   bun apps/device-host/build.ts <out-dir>
//
// `scripts/build-module-try.ts` bundles the runtime with these same options
// for `plugin_module_try`, so the Bot's Computer runs what the Mac runs.

import { join, resolve } from "node:path";

import { build, type BuildOptions } from "esbuild";

export const DEVICE_HOST_BUILD_OPTIONS_V1 = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2023",
  logLevel: "warning",
} as const satisfies BuildOptions;

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? join(import.meta.dirname, "dist"));
  await build({
    ...DEVICE_HOST_BUILD_OPTIONS_V1,
    entryPoints: {
      "device-host": join(import.meta.dirname, "src/host.ts"),
      "device-runtime": join(import.meta.dirname, "src/runtime.ts"),
    },
    outdir: out,
  });
  console.log(out);
}

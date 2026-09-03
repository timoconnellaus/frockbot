// Bundles the `applet` CLI into one file plain Node can run.
//
// The Computer image has Node and no Bun (`packages/computer-host-runtime`),
// and this package's sources are TypeScript that resolve siblings through
// `.js` specifiers — a convention Bun and esbuild honour and Node's ESM
// resolver does not. So the published `bin` is a bundle, not a source file.
//
// Only the SDK's own modules are bundled. `typescript`, `eslint`,
// `typescript-eslint`, `esbuild`, and `miniflare` stay external: they are real
// dependencies npm installs beside this package on the Computer, they are
// large, and two of them load their own workers and WASM by path.
import { build } from "esbuild";

const root = new URL("../", import.meta.url);

const result = await build({
  entryPoints: [new URL("src/cli/main.ts", root).pathname],
  outfile: new URL("dist/cli.mjs", root).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
  metafile: false,
});

if (result.errors.length > 0) process.exit(1);
await Bun.$`chmod +x ${new URL("dist/cli.mjs", root).pathname}`.quiet();
console.log("Built dist/cli.mjs");

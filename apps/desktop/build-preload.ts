import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(import.meta.dirname, "resources/preload");
await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dirname, "src/bridge/index.ts")],
  target: "node",
  format: "cjs",
  outdir: outputDirectory,
  naming: "index.cjs",
  external: ["electron"],
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
  process.exitCode = 1;
}

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const outdir = resolve(root, "../desktop/resources/cordis-agent");
  await rm(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [resolve(root, "src/index.ts")],
    outdir,
    target: "node",
    format: "esm",
    naming: "[name].mjs",
    sourcemap: "external",
    external: ["cordis"],
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    process.exitCode = 1;
  }
}

void main();

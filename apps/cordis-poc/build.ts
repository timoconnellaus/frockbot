import { rm } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const root = import.meta.dirname;
  const outdir = resolve(root, "dist");

  await rm(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [resolve(root, "src/main.ts"), resolve(root, "src/worker.ts")],
    outdir,
    target: "node",
    format: "esm",
    packages: "external",
    naming: "[name].mjs",
    sourcemap: "external",
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    process.exitCode = 1;
    return;
  }

  await Bun.write(
    resolve(outdir, "package.json"),
    `${JSON.stringify({ type: "module", main: "main.mjs" }, null, 2)}\n`,
  );
}

void main();

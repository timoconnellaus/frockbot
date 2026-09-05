#!/usr/bin/env node
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateDeclarations } from "./generate";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const entry = args[0];
  const outAt = args.indexOf("--out");
  const exportAt = args.indexOf("--export");
  const tsconfigAt = args.indexOf("--tsconfig");
  const out = outAt < 0 ? undefined : args[outAt + 1];
  if (!entry || !out) {
    throw new Error(
      "usage: compose-declarations <entry> --out <file> [--export <name>] [--tsconfig <file>]",
    );
  }
  const generated = generateDeclarations({
    entry,
    exportName: exportAt < 0 ? "base" : (args[exportAt + 1] ?? "base"),
    ...(tsconfigAt < 0 || !args[tsconfigAt + 1]
      ? {}
      : { tsconfig: args[tsconfigAt + 1] }),
  });
  const target = resolve(out);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, generated.text);
  await rename(temporary, target);
  process.stdout.write(`${generated.version}\n`);
}

void main();

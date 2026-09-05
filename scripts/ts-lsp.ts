#!/usr/bin/env bun
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Launches TypeScript 7's native Go language server over stdio, for any editor
// that speaks LSP.
//
// TypeScript 7 ships no `tsserver`: the published `typescript` package exposes
// only `bin/tsc`, and the language server lives inside the native binary behind
// `tsc --lsp --stdio`. Point your editor's TypeScript LSP command at this file.
//
// The binary is per-platform (@typescript/typescript-<platform>-<arch>) and is
// only installed under packages that declare `typescript` at ^7.0.2, so resolve
// it from one of those rather than from the repo root, whose `typescript` is
// the tsgo bridge — the same 7.0.2 checker, but reached through a NAPI addon
// rather than the standalone binary an editor needs to spawn.

const repoRoot = resolve(import.meta.dirname, "..");

// Any package on ^7.0.2 will do; protocol is the smallest and has no siblings
// that would drag it back to the bridge.
const anchor = join(repoRoot, "packages/protocol/package.json");

const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;

// Two steps, mirroring typescript's own lib/getExePath.js: find the TypeScript 7
// package, then resolve the platform binary *from there*. The binary is an
// optional dependency of `typescript`, so under bun's isolated node_modules it
// sits beside that copy of typescript rather than anywhere near the workspace
// package that asked for it.
let exe: string;
try {
  const typescriptManifest = createRequire(anchor).resolve(
    "typescript/package.json",
  );
  const platformManifest = createRequire(typescriptManifest).resolve(
    `${platformPackage}/package.json`,
  );
  exe = join(platformManifest.replace(/\/package\.json$/, ""), "lib", "tsc");
} catch {
  console.error(
    `Could not resolve ${platformPackage}. Run \`bun install\` first, or your platform is unsupported by TypeScript 7.`,
  );
  process.exit(1);
}

if (process.platform === "win32") exe += ".exe";

if (!existsSync(exe)) {
  console.error(`TypeScript 7 native binary not found at ${exe}`);
  process.exit(1);
}

const proc = Bun.spawn([exe, "--lsp", "--stdio", ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);

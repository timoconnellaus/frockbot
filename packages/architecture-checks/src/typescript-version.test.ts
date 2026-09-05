// One TypeScript checks this repo, and it is 7.0.2.
//
// A package left on TypeScript 5 is not visibly broken — it type-checks, it is
// just checking against a different language version than every package that
// imports it, so a diagnostic can appear or vanish depending on which package
// happened to run the compiler. The root copy was the worst of these: it is
// what `node_modules/typescript` resolves to, so editors and anything run from
// the root silently used 5.9 while CI used 7.
//
// Two spellings are allowed. `^7.0.2` is the Go compiler. The
// `typescript-native-bridge` alias is the same tsgo 7.0.2 checker reached
// through a NAPI addon, and it is what a package must use when a tool it
// depends on (`vue-tsc` via Volar, `typescript-eslint`, or its own
// `ts.createProgram` call) needs the JavaScript compiler API that TypeScript
// 7's package does not ship. See ADR 0029.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

const TSGO_BRIDGE =
  "npm:typescript-native-bridge@6.0.3-bridge.16.tsgo.7.0.2" as const;

/**
 * `@frockbot/compose-typescript` bundles TypeScript into the Worker as a
 * runtime library so a Bot's written plugin source can be checked in-process.
 * The bridge resolves a per-platform native binary, which cannot go in a Worker
 * bundle, so this one declares the last JavaScript TypeScript instead.
 */
const RUNTIME_LIBRARY_EXCEPTIONS: Record<string, string> = {
  "packages/compose-typescript/package.json": "6.0.2",
};

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("every package checks with TypeScript 7", () => {
  test("no workspace manifest declares TypeScript 5", async () => {
    const listed =
      await $`git -C ${repoRoot} ls-files -z package.json '*/package.json' '*/*/package.json'`
        .quiet()
        .text();
    const manifests = listed.split("\0").filter((path) => path.length > 0);
    // A sanity floor: an empty listing would make this test pass vacuously.
    expect(manifests.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    let declared = 0;
    for (const path of manifests) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, path), "utf8"),
      ) as Manifest;
      const spec =
        manifest.dependencies?.typescript ??
        manifest.devDependencies?.typescript;
      if (spec === undefined) continue;
      declared += 1;
      const allowed = RUNTIME_LIBRARY_EXCEPTIONS[path];
      if (allowed !== undefined) {
        if (spec !== allowed) offenders.push(`${path}: ${spec}`);
        continue;
      }
      if (spec === TSGO_BRIDGE) continue;
      if (/^\^?7\.\d+\.\d+$/u.test(spec)) continue;
      offenders.push(`${path}: ${spec}`);
    }

    expect(declared).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

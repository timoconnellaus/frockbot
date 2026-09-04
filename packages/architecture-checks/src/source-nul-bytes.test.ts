// A NUL byte inside a source file is invisible in an editor and harmless at
// runtime — a template literal holding one is just a string with a separator
// no name can contain. What it is not harmless to is git: a file whose first
// 8000 bytes contain a NUL is binary, and git has no three-way merge for a
// binary file. Two branches that both edit it do not conflict; one side is
// kept whole and the other's edits vanish, with nothing in the merge output
// to say so. That is how `packages/plugin-flock/src/client/index.ts` became a
// file every merge gambled on. Write the byte as an escape instead, so the
// string is identical and the file stays text.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

describe("tracked source files are text", () => {
  test("no source file under packages/ or apps/ contains a NUL byte", async () => {
    const listed = await $`git -C ${repoRoot} ls-files -z packages apps`
      .quiet()
      .text();
    const sources = listed
      .split("\0")
      .filter((path) => path.length > 0)
      .filter((path) => /\.(ts|tsx|vue|css|md|json|jsonc|html)$/u.test(path));
    // A sanity floor: an empty listing would make this test pass vacuously.
    expect(sources.length).toBeGreaterThan(100);

    const offenders = sources.filter((path) =>
      readFileSync(join(repoRoot, path)).includes(0),
    );
    expect(offenders).toEqual([]);
  });
});

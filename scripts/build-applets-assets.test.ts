/// <reference types="bun" />
/*
 * A Skill is a directory (ADR 0030), so the generator copies one where it used
 * to copy a file. Nothing else proves that a reference authored beside a
 * managed `SKILL.md` reaches the bundle: `--check` is what the typecheck gate
 * runs, so a generator that silently ignored `references/` would keep passing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REFERENCES = join(ROOT, "applets/skills/applets/references");
const FIXTURE = join(REFERENCES, "generator-fixture.md");

async function check(): Promise<number> {
  const process = Bun.spawn(
    ["bun", "scripts/build-applets-assets.ts", "--check"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  return await process.exited;
}

// The Skill this runs against is the real one in the checkout, so cleanup
// removes the fixture it wrote and nothing an author put there.
let referencesExisted = false;

afterEach(() => {
  rmSync(FIXTURE, { force: true });
  if (!referencesExisted) rmSync(REFERENCES, { recursive: true, force: true });
});

describe("the managed Skill generator", () => {
  test("the committed modules are fresh, and a new reference makes them stale", async () => {
    expect(await check()).toBe(0);

    referencesExisted = existsSync(REFERENCES);
    mkdirSync(REFERENCES, { recursive: true });
    writeFileSync(FIXTURE, "# Fixture\n");

    // Stale, because the generated module now has a reference to carry.
    expect(await check()).not.toBe(0);
  });
});

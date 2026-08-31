// ADR 0004 — "the Fly Sprites SDK is loaded in exactly one place". The SDK's
// HTTP exec protocol depends on response chunk boundaries workerd does not
// preserve, so it may only run in the Node container app; every other package
// reaches the Computer through the `COMPUTER_HOST` service binding. The rule is
// a source-graph fact, so `scripts/check-computer-host-imports.ts` enforces it
// and this file proves both that the tree obeys it and that the linter bites.
import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Spelled in halves so this file's own fixtures are not a violation of the
// rule it proves.
const SDK = ["@fly", "sprites"].join("/");

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const checkScript = join(repoRoot, "scripts", "check-computer-host-imports.ts");

function runCheck(cwd: string): { output: string; exitCode: number | null } {
  const check = Bun.spawnSync({
    cmd: ["bun", "scripts/check-computer-host-imports.ts"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    output: `${check.stdout.toString()}${check.stderr.toString()}`,
    exitCode: check.exitCode,
  };
}

const fixtures: string[] = [];

// A miniature repo with the linter copied in, so a violation can be staged
// without writing one into this tree.
function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "computer-host-lint-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(
    checkScript,
    join(root, "scripts", "check-computer-host-imports.ts"),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe("computer host boundaries", () => {
  test("the Fly Sprites SDK is imported only by the Computer host", () => {
    const { output, exitCode } = runCheck(repoRoot);
    expect(output).toContain("Computer host import contract passed");
    expect(exitCode).toBe(0);
  });

  test("the check refuses a static import outside the Computer host", () => {
    const root = fixtureRepo({
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/src/index.ts": `import { SpritesClient } from "${SDK}";\n`,
    });
    const { output, exitCode } = runCheck(root);
    expect(exitCode).toBe(1);
    expect(output).toContain("packages/example/src/index.ts:1");
    expect(output).toContain(SDK);
  });

  test("the check refuses a dynamic import and a Vue single-file component", () => {
    const root = fixtureRepo({
      "packages/example/package.json": JSON.stringify({ name: "example" }),
      "packages/example/src/lazy.ts": `export const sdk = () => import("${SDK}/exec");\n`,
      "packages/example/src/Panel.vue": `<script setup lang="ts">\nimport { SpritesClient } from "${SDK}";\n</script>\n`,
    });
    const { output, exitCode } = runCheck(root);
    expect(exitCode).toBe(1);
    expect(output).toContain("packages/example/src/lazy.ts");
    expect(output).toContain("packages/example/src/Panel.vue");
  });

  test("the check refuses a manifest that declares the SDK outside the host", () => {
    const root = fixtureRepo({
      "apps/cloudflare/package.json": JSON.stringify({
        name: "cloudflare",
        devDependencies: { [SDK]: "0.1.0" },
      }),
    });
    const { output, exitCode } = runCheck(root);
    expect(exitCode).toBe(1);
    expect(output).toContain("apps/cloudflare/package.json");
    expect(output).toContain("devDependencies");
  });

  test("the Computer host itself may import the SDK and declare it", () => {
    const root = fixtureRepo({
      "apps/computer-host/package.json": JSON.stringify({
        name: "computer-host",
        dependencies: { [SDK]: "0.1.0" },
      }),
      "apps/computer-host/container/server.ts": `import { SpritesClient } from "${SDK}";\n`,
      "apps/computer-host/container/package.json": JSON.stringify({
        name: "container",
        dependencies: { [SDK]: "0.1.0" },
      }),
    });
    const { output, exitCode } = runCheck(root);
    expect(output).toContain("Computer host import contract passed");
    expect(exitCode).toBe(0);
  });
});

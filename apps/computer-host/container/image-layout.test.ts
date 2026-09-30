// The container image carries only the `computer` and `core` files the
// Dockerfile names, and Node, not Bun, loads them. Bun resolves a `.js`
// specifier to its `.ts` sibling and reads the whole workspace, so a module the
// image lacks passes every other test here and fails only when the container
// starts. This lays the files out as the Dockerfile does and loads each
// workspace module the container imports under Node.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const container = import.meta.dirname;
const repositoryRoot = resolve(container, "../../..");
const dockerfile = readFileSync(join(container, "../Dockerfile"), "utf8");
const dockerignore = readFileSync(
  join(repositoryRoot, ".dockerignore"),
  "utf8",
);
const layout = mkdtempSync(join(tmpdir(), "computer-host-image-"));

afterAll(() => rmSync(layout, { recursive: true, force: true }));

function workspaceSpecifiers(): string[] {
  const specifiers = new Set<string>();
  for (const file of readdirSync(container)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(container, file), "utf8");
    for (const match of source.matchAll(/from "(@frockbot\/[^"]+)"/g)) {
      specifiers.add(match[1]!);
    }
  }
  return [...specifiers].sort();
}

function layOutImage(): void {
  for (const [, source, target] of dockerfile.matchAll(
    /^COPY ((?:computer|core)\/\S+) (\S+)$/gm,
  )) {
    // The build context admits only what `.dockerignore` names.
    expect(dockerignore.split("\n")).toContain(`!${source}`);
    const destination = join(layout, target!);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, source!), destination, { recursive: true });
  }
  const strip = /^RUN node --no-warnings -e \\\n\s+"(.+)"$/m.exec(dockerfile);
  if (!strip) throw new Error("the Dockerfile's type-stripping step moved");
  run(["--no-warnings", "-e", strip[1]!]);
  for (const [, target, link] of dockerfile.matchAll(
    /ln -s (\S+) (node_modules\/\S+)/g,
  )) {
    mkdirSync(dirname(join(layout, link!)), { recursive: true });
    symlinkSync(target!, join(layout, link!));
  }
}

function run(args: string[]) {
  const result = spawnSync("node", args, { cwd: layout, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

describe("the Computer host image", () => {
  test("Node loads every workspace module the container imports", () => {
    const version = run(["--version"]).stdout.trim();
    const [major, minor] = version.slice(1).split(".").map(Number);
    // The image is Node 24; 22.18 is the oldest that strips types unflagged.
    expect(
      major! > 22 || (major === 22 && minor! >= 18),
      `node ${version} cannot strip types; run this with Node 24`,
    ).toBe(true);

    layOutImage();
    const specifiers = workspaceSpecifiers();
    expect(specifiers).toContain("@frockbot/computer/fly/runtime");
    const result = run([
      "--no-warnings",
      "--input-type=module",
      "-e",
      specifiers
        .map((specifier) => `await import(${JSON.stringify(specifier)});`)
        .join("\n"),
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

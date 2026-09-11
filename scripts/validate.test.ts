import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  categories,
  ignoredWorkingPath,
  prePushCategories,
  pushCommits,
  requireLinearBranch,
  snapshot,
  validate,
} from "./validate";

const roots: string[] = [];
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode) throw new Error(result.stderr.toString());
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "validation-test-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, ".gitignore"), ".local-validation/\n");
  writeFileSync(join(root, "source.ts"), "export {};\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  delete categories.probe;
});

test("documentation exceptions do not ignore nested prompts or new code", () => {
  expect(ignoredWorkingPath("docs/plan.md")).toBe(true);
  expect(ignoredWorkingPath("README.md")).toBe(true);
  expect(ignoredWorkingPath("app/prompt.md")).toBe(false);
  const root = fixture();
  writeFileSync(join(root, "README.md"), "notes");
  expect(() => snapshot(root)).not.toThrow();
  writeFileSync(join(root, "new.ts"), "export {};");
  expect(() => snapshot(root)).toThrow("new.ts");
});

test("success is reused per category and commit, while forced failure removes it", async () => {
  const root = fixture();
  categories.probe = [
    [
      process.execPath,
      "-e",
      'const p=".local-validation/count"; await Bun.write(p,String(Number(await Bun.file(p).exists()?await Bun.file(p).text():0)+1))',
    ],
  ];
  await validate(root, ["probe"]);
  await validate(root, ["probe"]);
  expect(readFileSync(join(root, ".local-validation/count"), "utf8")).toBe("1");
  git(root, "commit", "--allow-empty", "-qm", "new commit");
  await validate(root, ["probe"]);
  expect(readFileSync(join(root, ".local-validation/count"), "utf8")).toBe("2");
  categories.probe = [[process.execPath, "-e", "process.exit(1)"]];
  await expect(validate(root, ["probe"], true)).rejects.toThrow("failed");
  expect(
    await Bun.file(
      join(root, ".local-validation", snapshot(root), "probe.json"),
    ).exists(),
  ).toBe(false);
});

test("commands that dirty source never earn a receipt", async () => {
  const root = fixture();
  categories.probe = [
    [process.execPath, "-e", 'await Bun.write("source.ts","changed")'],
  ];
  const sha = snapshot(root);
  await expect(validate(root, ["probe"])).rejects.toThrow("source.ts");
  expect(
    await Bun.file(join(root, ".local-validation", sha, "probe.json")).exists(),
  ).toBe(false);
});

test("deletions are ignored and outgoing commits are deduplicated", () => {
  expect(
    pushCommits(
      `refs/heads/a abc refs/heads/a def\nrefs/tags/v abc refs/tags/v def\n(delete) 0000 refs/heads/old abc\n`,
    ),
  ).toEqual(["abc"]);
  expect(() => pushCommits("bad input")).toThrow();
});

test("pre-push owes the fast tier only, and every category it names exists", () => {
  expect(prePushCategories).toEqual(["format", "typecheck", "unit"]);
  for (const name of prePushCategories)
    expect(Object.hasOwn(categories, name)).toBe(true);
});

test("a branch behind main may push, but a merge commit on it may not", () => {
  const remote = fixture();
  git(remote, "branch", "-M", "main");
  const local = mkdtempSync(join(tmpdir(), "validation-clone-"));
  roots.push(local);
  git(local, "clone", "-q", remote, ".");
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Test");
  git(local, "config", "core.hooksPath", "/dev/null");
  git(local, "checkout", "-qb", "feature");
  git(local, "commit", "--allow-empty", "-qm", "feature");
  expect(() => requireLinearBranch(local, "origin")).not.toThrow();
  git(remote, "commit", "--allow-empty", "-qm", "advance main");
  expect(() => requireLinearBranch(local, "origin")).not.toThrow();
  git(local, "fetch", "-q", "origin");
  git(local, "merge", "-q", "--no-edit", "origin/main");
  expect(() => requireLinearBranch(local, "origin")).toThrow("merge commits");
  git(local, "reset", "-q", "--hard", "HEAD~1");
  git(local, "rebase", "-q", "origin/main");
  expect(() => requireLinearBranch(local, "origin")).not.toThrow();
  expect(() => requireLinearBranch(local, join(remote, "missing"))).toThrow();
});

test("validation gives each run its own local service registry", async () => {
  const root = fixture();
  categories.probe = [
    [
      process.execPath,
      "-e",
      'await Bun.write(".local-validation/registry-path", process.env.WRANGLER_REGISTRY_PATH!)',
    ],
  ];
  await validate(root, ["probe"]);
  const first = readFileSync(
    join(root, ".local-validation/registry-path"),
    "utf8",
  );
  expect(first.startsWith(join(root, ".local-validation"))).toBe(true);
  await validate(root, ["probe"], true);
  expect(
    readFileSync(join(root, ".local-validation/registry-path"), "utf8"),
  ).not.toBe(first);
});

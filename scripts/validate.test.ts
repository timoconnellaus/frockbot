import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  categories,
  ignoredWorkingPath,
  inputFingerprint,
  isCategoryInput,
  prePushCategories,
  pushCommits,
  requireLinearBranch,
  snapshot,
  validate,
  GIT_ENV,
} from "./validate";

const roots: string[] = [];
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: GIT_ENV });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
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
  // The shapes the input fingerprints discriminate between: documentation no
  // category reads, and the Flutter client only some of them do.
  writeFileSync(join(root, "README.md"), "# fixture\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "plan.md"), "plan\n");
  mkdirSync(join(root, "apps", "native"), { recursive: true });
  writeFileSync(join(root, "apps", "native", "main.dart"), "void main() {}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  delete categories.probe;
  delete categories.sleeper;
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

test("a test run under a git hook leaves the hooked repository untouched", () => {
  // Git exports GIT_DIR and friends to hooks; a `git init` under a fixture
  // then re-initialised the repository being committed to, marking it bare
  // and pointing its hooks at /dev/null. Bun hands a child the environment
  // it started with, so mutating process.env here never reaches a spawned
  // git: the variables must reach `bun test` the way git delivers them, from
  // outside.
  const hooked = fixture();
  git(hooked, "config", "core.hooksPath", "hooks-of-hooked");
  const child = Bun.spawnSync(
    [process.execPath, "test", import.meta.path, "-t", "^documentation"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...GIT_ENV,
        GIT_DIR: join(hooked, ".git"),
        GIT_WORK_TREE: hooked,
        GIT_INDEX_FILE: join(hooked, ".git", "index"),
        GIT_PREFIX: "",
      },
    },
  );
  expect(child.stderr.toString()).toContain(" 1 pass");
  expect(child.exitCode).toBe(0);
  expect(git(hooked, "config", "--bool", "core.bare")).toBe("false");
  expect(git(hooked, "config", "core.hooksPath")).toBe("hooks-of-hooked");
  expect(git(hooked, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(hooked, "status", "--porcelain")).toBe("");
});

test("a category runs under the shell's environment, not git's hook environment", async () => {
  const root = fixture();
  categories.probe = [
    [
      process.execPath,
      "-e",
      'await Bun.write(".local-validation/gitdir", process.env.GIT_DIR ?? "unset")',
    ],
  ];
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nowhere/.git";
  try {
    await validate(root, ["probe"]);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  expect(readFileSync(join(root, ".local-validation/gitdir"), "utf8")).toBe(
    "unset",
  );
});

/** How many times the counting probe has actually run in `root`. */
function probeRuns(root: string): string {
  return readFileSync(join(root, ".local-validation/count"), "utf8");
}
const countingProbe = [
  process.execPath,
  "-e",
  'const p=".local-validation/count"; await Bun.write(p,String(Number(await Bun.file(p).exists()?await Bun.file(p).text():0)+1))',
];

test("success is reused while a category's inputs are unchanged, and a forced failure removes it", async () => {
  const root = fixture();
  categories.probe = [countingProbe];
  await validate(root, ["probe"]);
  await validate(root, ["probe"]);
  expect(probeRuns(root)).toBe("1");
  // A new commit that changes nothing the category reads is not a reason to
  // re-run it: the receipt is keyed on content, not on the commit carrying it.
  git(root, "commit", "--allow-empty", "-qm", "new commit");
  await validate(root, ["probe"]);
  expect(probeRuns(root)).toBe("1");
  // Changed source is.
  writeFileSync(join(root, "source.ts"), "export const changed = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "change source");
  await validate(root, ["probe"]);
  expect(probeRuns(root)).toBe("2");
  // `--force` disregards a receipt that still stands.
  await validate(root, ["probe"], true);
  expect(probeRuns(root)).toBe("3");
  // A failure is never recorded, so a second run re-earns it rather than
  // reading a receipt the first run had no right to write.
  categories.probe = [[process.execPath, "-e", "process.exit(1)"]];
  await expect(validate(root, ["probe"])).rejects.toThrow("failed");
  await expect(validate(root, ["probe"])).rejects.toThrow("failed");
});

// Not named for what it is about: the hook test above selects by
// `-t "^documentation"` and counts the tests that match.
test("prose is not an input to a category that reads only code", async () => {
  const root = fixture();
  categories.probe = [countingProbe];
  await validate(root, ["probe"]);
  expect(probeRuns(root)).toBe("1");
  writeFileSync(join(root, "README.md"), "# changed\n");
  writeFileSync(join(root, "docs", "plan.md"), "changed\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "documentation only");
  await validate(root, ["probe"]);
  expect(probeRuns(root)).toBe("1");
});

test("a killed category's surviving descendants cannot wedge the run", async () => {
  const root = fixture();
  // `sleeper` leaks a grandchild into a process group of its own — what
  // `wrangler dev` deliberately does — so the kill that `probe`'s failure
  // provokes cannot reach it, and it holds the inherited pipe open long after
  // the command it was spawned from is gone. Exit, not end-of-pipe, is what
  // says a command is done.
  categories.probe = [[process.execPath, "-e", "process.exit(1)"]];
  categories.sleeper = [
    [
      process.execPath,
      "-e",
      'Bun.spawn(["sleep", "10"], { stdout: "inherit", stderr: "inherit", detached: true }); await Bun.sleep(10_000);',
    ],
  ];
  const started = Date.now();
  await expect(validate(root, ["probe", "sleeper"])).rejects.toThrow(
    "probe failed",
  );
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(existsSync(join(root, ".local-validation", "running"))).toBe(false);
  expect(readdirSync(join(root, ".local-validation", "receipts"))).toEqual([]);
});

test("an interrupt reaches the children it took out of the foreground", async () => {
  const root = fixture();
  const scratch = mkdtempSync(join(tmpdir(), "validation-interrupt-"));
  roots.push(scratch);
  const marker = join(scratch, "child.pid");
  // A real interrupt, delivered to a real validator process, because that is
  // the whole claim: the children sit in process groups of their own and no
  // longer receive the terminal's signal. The first records its pid and then
  // sleeps far longer than the test allows.
  const driver = join(scratch, "driver.ts");
  writeFileSync(
    driver,
    `import { categories, validate } from ${JSON.stringify(resolve(import.meta.dirname, "validate.ts"))};
categories.probe = [
  [process.execPath, "-e", ${JSON.stringify(`await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await Bun.sleep(60_000);`)}],
  [process.execPath, "-e", "await Bun.sleep(60_000)"],
];
try {
  await validate(${JSON.stringify(root)}, ["probe"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
`,
  );
  const validator = Bun.spawn([process.execPath, driver], {
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  // `Bun.write` creates the file and then fills it, so existence alone is not
  // a value: read until the content parses, and give up loudly rather than
  // hanging if the child never gets that far.
  const deadline = Date.now() + 15_000;
  let child = 0;
  while (!child) {
    if (Date.now() > deadline) {
      throw new Error("the validator's child never recorded its pid");
    }
    const recorded = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    child = Number.parseInt(recorded, 10) || 0;
    if (!child) await Bun.sleep(25);
  }
  validator.kill("SIGINT");
  expect(await validator.exited).not.toBe(0);
  expect(await new Response(validator.stderr).text()).toContain(
    "interrupted by SIGINT",
  );
  // The child, and the process group it leads, are gone rather than still
  // holding ports and scratch after the developer got their prompt back. The
  // group is the claim: that is what the capture path put the child into and
  // what the interrupt has to reach.
  expect(() => process.kill(child, 0)).toThrow();
  expect(() => process.kill(-child, 0)).toThrow();
  // And the run cleaned up after itself, which only happens if it unwound
  // rather than being cut down where it stood.
  expect(existsSync(join(root, ".local-validation", "running"))).toBe(false);
  expect(readdirSync(join(root, ".local-validation", "receipts"))).toEqual([]);
}, 30_000);

test("the input rules exclude prose without excluding nested code", () => {
  expect(isCategoryInput("unit", "docs/plan.md")).toBe(false);
  expect(isCategoryInput("unit", "README.md")).toBe(false);
  expect(isCategoryInput("unit", "apps/cloudflare/skill.md")).toBe(true);
  expect(isCategoryInput("unit", "apps/native/lib/main.dart")).toBe(true);
  expect(isCategoryInput("runtime", "apps/native/lib/main.dart")).toBe(false);
  // `prettier --check .` reads the repository, prose included, so nothing is
  // excluded from it.
  expect(isCategoryInput("format", "docs/plan.md")).toBe(true);
  expect(isCategoryInput("format", "README.md")).toBe(true);
  expect(isCategoryInput("format", "apps/native/lib/main.dart")).toBe(true);
});

test("the formatter re-runs on the prose the other categories skip", () => {
  const root = fixture();
  const before = {
    format: inputFingerprint(root, "format"),
    unit: inputFingerprint(root, "unit"),
  };
  writeFileSync(join(root, "README.md"), "# changed\n");
  writeFileSync(join(root, "docs", "plan.md"), "changed\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "prose only");
  expect(inputFingerprint(root, "format")).not.toBe(before.format);
  expect(inputFingerprint(root, "unit")).toBe(before.unit);
});

test("the workerd suite does not read the Flutter client, and the rest do", () => {
  const root = fixture();
  const before = {
    runtime: inputFingerprint(root, "runtime"),
    unit: inputFingerprint(root, "unit"),
  };
  writeFileSync(
    join(root, "apps", "native", "main.dart"),
    "void main() { print('changed'); }\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "client only");
  expect(inputFingerprint(root, "runtime")).toBe(before.runtime);
  expect(inputFingerprint(root, "unit")).not.toBe(before.unit);
});

test("commands that dirty source never earn a receipt", async () => {
  const root = fixture();
  categories.probe = [
    [process.execPath, "-e", 'await Bun.write("source.ts","changed")'],
  ];
  await expect(validate(root, ["probe"])).rejects.toThrow("source.ts");
  expect(
    readdirSync(join(root, ".local-validation", "receipts")).filter((entry) =>
      entry.startsWith("probe-"),
    ),
  ).toEqual([]);
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

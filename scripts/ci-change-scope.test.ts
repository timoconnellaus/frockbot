import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GIT_ENV,
  scopeDecisionV1,
  slowTierRequiredV1,
} from "./ci-change-scope";

test("a push that only touches a separately deployed site skips the slow tier", () => {
  expect(
    slowTierRequiredV1([
      "apps/marketing/src/index.html",
      "apps/marketing/package.json",
    ]),
  ).toBe(false);
  expect(slowTierRequiredV1(["apps/admin-portal/src/main.ts"])).toBe(false);
  expect(
    slowTierRequiredV1([
      "apps/marketing/src/index.html",
      "apps/admin-portal/src/main.ts",
    ]),
  ).toBe(false);
});

test("anything the application is built from obliges the slow tier", () => {
  for (const path of [
    "apps/cloudflare/src/gateway.ts",
    "core/deadline.ts",
    "app/billing/stripe.ts",
    "providers/catalog/models.ts",
    "apps/native/lib/main.dart",
    "package.json",
    "bun.lock",
    ".github/workflows/main.yml",
    "scripts/validate.ts",
  ])
    expect(slowTierRequiredV1([path])).toBe(true);
});

test("one unrecognised path among skippable ones is enough to oblige it", () => {
  expect(
    slowTierRequiredV1(["apps/marketing/src/index.html", "core/deadline.ts"]),
  ).toBe(true);
});

test("a file moved out of the application obliges it, both paths named", () => {
  // A rename is two paths, and only the destination is under an excused
  // prefix. The source is the whole point: the move deleted an application
  // file. `main.yml` passes `--no-renames` so both sides are reported, and
  // this is the behaviour that depends on it.
  expect(
    slowTierRequiredV1(["core/deadline.ts", "apps/marketing/src/deadline.ts"]),
  ).toBe(true);
});

test("a prefix is a directory, not a string the path merely starts with", () => {
  // `apps/marketing-experiments/` is not `apps/marketing/`, and a deployable
  // nobody has classified must not inherit the skip by sharing a name.
  expect(slowTierRequiredV1(["apps/marketing-experiments/index.ts"])).toBe(
    true,
  );
  expect(slowTierRequiredV1(["apps/admin-portal-v2/main.ts"])).toBe(true);
});

test("an undetermined change set is treated as obliging everything", () => {
  // A force push, a first push, or a range that could not be resolved reports
  // no paths. That is absence of evidence, not evidence the push was empty.
  expect(slowTierRequiredV1([])).toBe(true);
});

test("documentation is excused exactly where the workflow trigger excuses it", () => {
  // The same claim `main.yml`'s `paths-ignore` makes. It has to be made here
  // too because the measured range starts at the last release tag, so it
  // spans pushes the trigger never started a run for.
  expect(slowTierRequiredV1(["docs/architecture.md"])).toBe(false);
  expect(slowTierRequiredV1(["README.md", "docs/plan.md"])).toBe(false);
  expect(
    slowTierRequiredV1(["docs/architecture.md", "apps/marketing/index.html"]),
  ).toBe(false);
  // Markdown below the root is code: a Package may ship a Skill or a prompt.
  expect(slowTierRequiredV1(["app/prompt.md"])).toBe(true);
  expect(slowTierRequiredV1(["packages/skills/review.md"])).toBe(true);
});

// The decision against real history. The pure tests above state the rule; these
// prove the script reads a repository the way the rule assumes — in particular
// that both sides of a rename are reported, which no hand-written path list can
// establish.

const roots: string[] = [];
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: GIT_ENV });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function write(root: string, path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ci-change-scope-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.hooksPath", "/dev/null");
  write(root, "core/deadline.ts", "export {};\n");
  write(root, "apps/marketing/index.html", "<p>one</p>\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("a repository with no release tag obliges the tier rather than guessing", () => {
  const root = fixture();
  write(root, "apps/marketing/index.html", "<p>two</p>\n");
  git(root, "commit", "-qam", "marketing only");
  expect(scopeDecisionV1(root).base).toBe(null);
  expect(scopeDecisionV1(root).slowTier).toBe(true);
});

test("a tagged repository measures from the newest release tag", () => {
  const root = fixture();
  write(root, "core/deadline.ts", "export const a = 1;\n");
  git(root, "commit", "-qam", "released application change");
  git(root, "tag", "v1.0.0");
  write(root, "apps/marketing/index.html", "<p>two</p>\n");
  git(root, "commit", "-qam", "marketing only");

  // The application change is behind the tag, so it is not in the range.
  expect(scopeDecisionV1(root)).toEqual({ base: "v1.0.0", slowTier: false });

  // An unreleased application change is, and obliges the tier.
  write(root, "core/deadline.ts", "export const a = 2;\n");
  git(root, "commit", "-qam", "unreleased application change");
  expect(scopeDecisionV1(root)).toEqual({ base: "v1.0.0", slowTier: true });
});

test("a tag that is not a release tag is not a watermark", () => {
  const root = fixture();
  git(root, "tag", "nightly-2026-09-17");
  write(root, "apps/marketing/index.html", "<p>two</p>\n");
  git(root, "commit", "-qam", "marketing only");
  expect(scopeDecisionV1(root).base).toBe(null);
  expect(scopeDecisionV1(root).slowTier).toBe(true);
});

test("a file moved out of the application obliges the tier", () => {
  // Git detects this as a rename, and rename detection would report the
  // destination alone — an excused workspace — hiding that an application file
  // was deleted. This fails if `--no-renames` is ever dropped.
  const root = fixture();
  git(root, "tag", "v1.0.0");
  const body = "export const moved = 1;\n".repeat(20);
  write(root, "core/deadline.ts", body);
  git(root, "commit", "-qam", "grow the file so a rename is detectable");
  git(root, "tag", "v1.1.0");
  git(root, "mv", "core/deadline.ts", "apps/marketing/deadline.ts");
  git(root, "commit", "-qm", "move it out of the application");

  expect(
    git(root, "diff", "--name-only", "--find-renames", "v1.1.0", "HEAD"),
  ).toBe("apps/marketing/deadline.ts");
  expect(scopeDecisionV1(root)).toEqual({ base: "v1.1.0", slowTier: true });
});

test("documentation behind the trigger still measures as excused", () => {
  // The range spans pushes the trigger filtered out, so documentation reaches
  // the classifier here and must not oblige the tier on its own.
  const root = fixture();
  git(root, "tag", "v1.0.0");
  write(root, "docs/architecture.md", "# notes\n");
  write(root, "README.md", "# readme\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "documentation only");
  write(root, "apps/marketing/index.html", "<p>two</p>\n");
  git(root, "commit", "-qam", "marketing only");
  expect(scopeDecisionV1(root)).toEqual({ base: "v1.0.0", slowTier: false });
});

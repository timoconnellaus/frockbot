import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";

export const categories: Record<string, string[][]> = {
  format: [["bun", "run", "format:check"]],
  typecheck: [["bun", "run", "typecheck"]],
  unit: [["bun", "test"]],
  runtime: ["cloudflare", "computer-host", "applet-build"].map((name) => [
    "bun",
    "run",
    "--filter",
    `@frockbot/${name}`,
    "test:workerd",
  ]),
  integration: [
    ["bun", "run", "--filter", "@frockbot/cloudflare", "test:integration"],
  ],
  e2e: [
    [
      "bun",
      "run",
      "--filter",
      "@frockbot/cloudflare",
      "test:e2e",
      "--forbid-only",
      "--workers=1",
      "--retries=2",
    ],
  ],
  build: [["bun", "run", "build"]],
};

/**
 * What a push owes before it leaves the machine: the fast tier, the same set
 * `check.yml` runs on the pull request. The slow categories — runtime,
 * integration, e2e, build — run once per landed change on `main`
 * (`main.yml`), and by hand through `bun run validate` when a change warrants
 * it.
 */
export const prePushCategories = ["format", "typecheck", "unit"];

export function ignoredWorkingPath(path: string): boolean {
  return (
    path.startsWith("docs/") || (!path.includes("/") && path.endsWith(".md"))
  );
}

// Git exports GIT_DIR (and friends) to hooks, and this runs from the pre-push
// hook. Every git call here is about `root`, so inherited repository pointers
// must not redirect it: from a worktree hook they name the worktree's git
// dir, which is not a work tree for any other `root`.
export const GIT_ENV: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("GIT_") || name === "GIT_EXEC_PATH",
  ),
);

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

export function snapshot(root: string): string {
  const paths = new Set([
    ...git(root, "diff", "HEAD", "--name-only", "--no-renames", "-z").split(
      "\0",
    ),
    ...git(root, "ls-files", "--others", "--exclude-standard", "-z").split(
      "\0",
    ),
  ]);
  const dirty = [...paths].filter((path) => path && !ignoredWorkingPath(path));
  if (dirty.length)
    throw new Error(
      `Commit or set aside code/config changes before validation:\n${dirty.join("\n")}`,
    );
  return git(root, "rev-parse", "HEAD").trim();
}

export async function validate(
  root: string,
  names: string[],
  force = false,
): Promise<void> {
  for (const name of names)
    if (!Object.hasOwn(categories, name))
      throw new Error(`Unknown category: ${name}`);
  const sha = snapshot(root);
  const cache = join(root, ".local-validation", sha);
  mkdirSync(cache, { recursive: true });
  // A per-checkout lock prevents one run from reusing a receipt while another
  // is replacing it. An interrupted process leaves an explicit recovery step.
  const lock = join(root, ".local-validation", "running");
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(
      `Validation already running. If interrupted, remove ${lock} and retry.`,
    );
  }
  const registry = mkdtempSync(join(cache, "registry-"));
  try {
    for (const name of names) {
      if (snapshot(root) !== sha)
        throw new Error("Commit changed during validation");
      const key = createHash("sha256")
        .update(
          JSON.stringify({
            sha,
            commands: categories[name],
            bun: Bun.version,
            node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(),
            platform: process.platform,
            arch: process.arch,
            validator: readFileSync(import.meta.path, "utf8"),
          }),
        )
        .digest("hex");
      const receipt = join(cache, `${name}.json`);
      let passed = false;
      try {
        passed = JSON.parse(readFileSync(receipt, "utf8")).key === key;
      } catch {
        /* Missing or damaged receipts require validation. */
      }
      if (passed && !force) {
        console.log(`validate: ${name} cached (${sha.slice(0, 8)})`);
        continue;
      }
      rmSync(receipt, { force: true });
      console.log(`validate: running ${name}`);
      for (const command of categories[name]!) {
        const child = Bun.spawn(command, {
          cwd: root,
          // Wrangler otherwise shares service discovery across all worktrees.
          env: { ...process.env, WRANGLER_REGISTRY_PATH: registry },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((await child.exited) !== 0)
          throw new Error(`${name} failed; no success recorded`);
      }
      if (snapshot(root) !== sha)
        throw new Error(
          "Commit changed during validation; no success recorded",
        );
      const temp = `${receipt}.${process.pid}.tmp`;
      await Bun.write(
        temp,
        JSON.stringify({
          key,
          sha,
          category: name,
          completedAt: new Date().toISOString(),
        }) + "\n",
      );
      renameSync(temp, receipt);
    }
    if (snapshot(root) !== sha)
      throw new Error("Commit changed during validation");
  } finally {
    rmSync(registry, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * A branch may be behind `main` — `main.yml` checks the merge commit itself,
 * so a rebase before every push proved nothing the merge would not — but it
 * keeps a linear history: a merge commit on the branch is `main` merged into
 * it, which the eventual merge folds into an unreadable one.
 */
export function requireLinearBranch(root: string, remote: string): void {
  git(root, "fetch", "--no-tags", "--", remote, "refs/heads/main");
  const base = git(root, "merge-base", "FETCH_HEAD", "HEAD").trim();
  if (git(root, "rev-list", "--merges", `${base}..HEAD`).trim())
    throw new Error(
      "PR branch contains merge commits. Rebase onto main before pushing.",
    );
}

export function pushCommits(input: string): string[] {
  return [
    ...new Set(
      input
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          if (parts.length !== 4) throw new Error("Invalid pre-push input");
          return parts[1]!;
        })
        .filter((sha) => !/^0+$/.test(sha)),
    ),
  ];
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dirname, "..");
    const args = process.argv.slice(2);
    if (args.includes("--pre-push")) {
      const commits = pushCommits(await Bun.stdin.text());
      if (commits.length) {
        const head = snapshot(root);
        for (const object of commits) {
          if (git(root, "rev-parse", `${object}^{commit}`).trim() !== head)
            throw new Error(
              "Push only the checked-out commit; validate other branches in their own checkout.",
            );
        }
        const remote = args[args.indexOf("--pre-push") + 1];
        if (!remote) throw new Error("Pre-push requires a remote");
        requireLinearBranch(root, remote);
        await validate(root, prePushCategories);
        if (snapshot(root) !== head)
          throw new Error("Commit changed while preparing push");
      }
    } else {
      const names = args.filter((arg) => arg !== "--force");
      await validate(
        root,
        names.length ? names : Object.keys(categories),
        args.includes("--force"),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

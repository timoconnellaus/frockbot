import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
    ],
  ],
  build: [["bun", "run", "build"]],
};

export function ignoredWorkingPath(path: string): boolean {
  return (
    path.startsWith("docs/") || (!path.includes("/") && path.endsWith(".md"))
  );
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
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
    rmSync(lock, { recursive: true, force: true });
  }
}

export function requireCurrentMain(root: string, remote: string): void {
  git(root, "fetch", "--no-tags", "--", remote, "refs/heads/main");
  const base = git(root, "rev-parse", "FETCH_HEAD").trim();
  const result = Bun.spawnSync(
    ["git", "merge-base", "--is-ancestor", base, "HEAD"],
    { cwd: root },
  );
  if (result.exitCode !== 0)
    throw new Error(
      "Your branch is behind remote main. Rebase onto main, validate, and push again.",
    );
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
        requireCurrentMain(root, remote);
        await validate(root, Object.keys(categories));
        requireCurrentMain(root, remote);
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

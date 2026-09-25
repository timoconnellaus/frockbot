import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = Bun.spawnSync(
  ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: root },
);
if (git.exitCode !== 0) throw new Error("Cannot locate the main repository");
const commonDir = git.stdout.toString().trim();
// Linked worktrees share the main checkout's Git directory and credentials, so
// the common directory's parent is the main checkout. A bare common directory
// has no checkout beside it; fall back to the worktrees sharing it.
const worktrees = Bun.spawnSync(
  ["git", "--git-dir", commonDir, "worktree", "list", "--porcelain"],
  { cwd: root },
)
  .stdout.toString()
  .split("\n")
  .flatMap((line) =>
    line.startsWith("worktree ") ? [line.slice("worktree ".length)] : [],
  );
const envFile = [dirname(commonDir), root, ...worktrees]
  .map((dir) => join(dir, ".dev.vars"))
  .find((candidate) => existsSync(candidate));
if (!envFile && !(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY))
  throw new Error(
    "No .dev.vars beside the Git common directory, and no JEV_API_KEY or TYPESAFE_API_KEY in the environment",
  );
const child = Bun.spawn(
  [
    process.execPath,
    ...(envFile ? [`--env-file=${envFile}`] : []),
    "app/evals/context-selection-run.ts",
  ],
  {
    cwd: root,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;

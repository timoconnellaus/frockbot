import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = Bun.spawnSync(
  ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: root },
);
if (git.exitCode !== 0) throw new Error("Cannot locate the main repository");
// Linked worktrees share the main checkout's Git directory and credentials.
const envFile = join(dirname(git.stdout.toString().trim()), ".dev.vars");
const child = Bun.spawn(
  [process.execPath, `--env-file=${envFile}`, "app/evals/greeting.ts"],
  {
    cwd: root,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;

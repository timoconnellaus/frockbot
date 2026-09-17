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
  // Worker count and retries belong to `e2e/playwright.config.ts`, which
  // chooses both per environment and explains each: files share nothing a run
  // can see, so locally the parallelism is between workers rather than between
  // CI runners, and locally "a failure should stay failed". Overriding them to
  // `--workers=1 --retries=2` here contradicted both and made the slowest
  // category run on one core while hiding the flake it then retried.
  // `--forbid-only` stays: the config only forbids `.only` under CI, and a
  // push is the other place it must not leave the machine.
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

/**
 * What a push owes before it leaves the machine: the fast tier, the same set
 * `check.yml` runs on the pull request. The slow categories — runtime,
 * integration, e2e, build — run once per landed change on `main`
 * (`main.yml`), and by hand through `bun run validate` when a change warrants
 * it.
 */
export const prePushCategories = ["format", "typecheck", "unit"];

/**
 * What a category's result depends on, as a predicate over tracked paths at
 * `HEAD`. A receipt is keyed on the content at those paths, not on the commit
 * that carried it, so amending a message, reordering commits, or rebasing onto
 * a base that touched nothing a category reads all reuse the previous run.
 *
 * A category that names no exclusions reads everything `ignoredWorkingPath`
 * does not ignore. That direction matters: a new category, or a new top-level
 * directory, re-runs until someone proves it can be excluded, rather than
 * being silently skipped.
 *
 * `runtime` is the one category narrower than that, and only because two
 * independent things say so: nothing under `apps/cloudflare`, `core`, `app` or
 * `providers` imports these directories, and `main.yml` says of the same suite
 * that it "never needs Flutter". The Flutter client reaches the other slow
 * categories through the built artifact — `test:integration` reads
 * `../native/lib` directly — so none of them may borrow this list.
 */
const CATEGORY_EXCLUSIONS: Record<string, string[]> = {
  runtime: ["apps/native/", "apps/marketing/", "apps/admin-portal/"],
};

export function isCategoryInput(name: string, path: string): boolean {
  if (ignoredWorkingPath(path)) return false;
  return !CATEGORY_EXCLUSIONS[name]?.some((directory) =>
    path.startsWith(directory),
  );
}

/**
 * Categories that build the deployable artifact, and so cannot run beside each
 * other: `test:integration` reaches `artifact:build` and the end-to-end web
 * server builds the same tree. They write one `apps/cloudflare/dist`, so two
 * of them at once race on its contents. They run in order, as a group, beside
 * everything else.
 */
const SHARED_ARTIFACT = new Set(["integration", "e2e"]);

/**
 * Categories that may not run beside anything at all. `build` writes that same
 * `apps/cloudflare/dist`, but the sharper reason is that `bun run build`
 * truncates and rewrites five tracked generated sources through
 * `scripts/build-applets-assets.ts`. Every other category reads the work tree
 * — through its own commands, and through `snapshot`, whose whole job is to
 * prove the tree still matches the commit — so a concurrent category can
 * observe a half-written file and fail spuriously. `build` is not in
 * `prePushCategories`, so running it alone costs the push path nothing.
 */
const EXCLUSIVE = new Set(["build"]);

/**
 * How long a captured command's pipes may still be read after the process
 * itself has exited. Exit is the authority on when a command is done: a pipe
 * closes only once every descendant that inherited the write end has let go,
 * and a killed package-manager wrapper can leave one behind forever. Whatever
 * has arrived by the end of this window is what gets printed.
 */
const CAPTURE_DRAIN_MS = 2_000;

/**
 * The content of everything `name` reads, as one hash. `snapshot` has proven
 * the work tree matches `HEAD` everywhere `ignoredWorkingPath` does not
 * ignore, which is why `HEAD` is the thing to hash: the index says nothing
 * about what is being validated, and a staged-then-reverted change would key a
 * receipt on content no command ever saw.
 *
 * Each `ls-tree` line carries the blob's object id, so this hashes content
 * rather than names. It takes no pathspec — the filtering is `isCategoryInput`
 * — because pathspec magic and the tree listing do not mix.
 */
export function inputFingerprint(root: string, name: string): string {
  const inputs = git(root, "ls-tree", "-r", "-z", "HEAD")
    .split("\0")
    .filter((line) => line)
    .filter((line) =>
      isCategoryInput(name, line.slice(line.indexOf("\t") + 1)),
    );
  return createHash("sha256").update(inputs.join("\n")).digest("hex");
}

export function ignoredWorkingPath(path: string): boolean {
  return (
    path.startsWith("docs/") || (!path.includes("/") && path.endsWith(".md"))
  );
}

// Git exports GIT_DIR (and friends) to hooks, and this runs from the pre-push
// hook. Every git call here — and every command a category spawns — is about
// `root`, so inherited repository pointers must not redirect it: from a
// worktree hook they name the worktree's git dir, which is not a work tree for
// any other `root`, and a test that runs `git init` in a temp directory under
// that pointer marks this repository bare instead.
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
  // Live streams are the default: one command owns the terminal and its
  // progress — Playwright's, vitest's — is worth watching as it happens.
  // Capture is what concurrency costs. The whole run decides this once, from
  // how many commands it will spawn in total, so a lone run of the one
  // multi-command category still captures while a lone `e2e` or `build` does
  // not.
  const captureOutput =
    names.reduce((total, name) => total + categories[name]!.length, 0) > 1;
  const sha = snapshot(root);
  // Receipts are addressed by what they validated, not by the commit that
  // carried it, so this directory is shared across commits rather than being
  // one per `sha`. A receipt names its own key, so two commits with identical
  // inputs land on the same file and the second reuses the first.
  const cache = join(root, ".local-validation", "receipts");
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
  // Beside the receipts rather than among them: this is scratch for one run,
  // and the receipt directory is now long-lived.
  const registry = mkdtempSync(join(root, ".local-validation", "registry-"));
  // The registry directory and the lock exist for as long as a child can still
  // read them, so nothing may be removed while one is alive. The first failure
  // stops the rest by killing every live child; a concurrent category is
  // already spawned by then, so only the kill path stops one, while the guard
  // in `runCategory` holds back work that has genuinely not begun.
  const live = new Set<() => void>();
  let failure: unknown;
  const stop = (error: unknown): void => {
    // The first failure is the one worth reporting; what the kill below
    // provokes in the others is a consequence of it, not a second cause.
    failure ??= error;
    for (const kill of live) kill();
  };
  /**
   * Wait for every job before propagating the first failure, so nothing
   * removed below outlives a child still reading it. The first rejection is
   * rethrown as it came, so a caller sees the same error it always did.
   */
  const settle = async (jobs: Promise<unknown>[]): Promise<void> => {
    const results = await Promise.allSettled(jobs);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  };
  /**
   * One category: decide whether its receipt still stands, run its commands if
   * not, and record the result. Commands within a category are independent by
   * construction — `runtime`'s three are separate packages with separate
   * outputs, and every other category holds one — so they run together.
   *
   * A captured command's output is printed as one block when it ends, so
   * concurrent categories cannot interleave; otherwise it inherits the
   * terminal and streams live. Capture is also why a command gets its own
   * process group: what `stop` must reach is not the package-manager wrapper
   * but the workers below it, which are what hold the pipe open.
   */
  const runCategory = async (name: string): Promise<void> => {
    if (failure !== undefined) return;
    if (snapshot(root) !== sha)
      throw new Error("Commit changed during validation");
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          inputs: inputFingerprint(root, name),
          commands: categories[name],
          bun: Bun.version,
          node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(),
          platform: process.platform,
          arch: process.arch,
          validator: readFileSync(import.meta.path, "utf8"),
        }),
      )
      .digest("hex");
    const receipt = join(cache, `${name}-${key}.json`);
    let passed = false;
    try {
      passed = JSON.parse(readFileSync(receipt, "utf8")).key === key;
    } catch {
      /* Missing or damaged receipts require validation. */
    }
    if (passed && !force) {
      console.log(`validate: ${name} cached (inputs ${key.slice(0, 8)})`);
      return;
    }
    rmSync(receipt, { force: true });
    console.log(`validate: running ${name}`);
    await settle(
      categories[name]!.map(async (command) => {
        const options = {
          cwd: root,
          env: {
            ...GIT_ENV,
            // Wrangler otherwise shares service discovery across all worktrees.
            WRANGLER_REGISTRY_PATH: registry,
          },
          stdin: "inherit",
        } as const;
        const child = captureOutput
          ? Bun.spawn(command, {
              ...options,
              stdout: "pipe",
              stderr: "pipe",
              detached: true,
            })
          : Bun.spawn(command, {
              ...options,
              stdout: "inherit",
              stderr: "inherit",
            });
        const kill = (): void => {
          try {
            process.kill(captureOutput ? -child.pid : child.pid, "SIGTERM");
          } catch {
            /* Already gone. */
          }
        };
        live.add(kill);
        const captured: string[] = [];
        const drained = captureOutput
          ? Promise.all(
              [child.stdout, child.stderr].map(async (stream) => {
                const decoder = new TextDecoder();
                for await (const chunk of stream as ReadableStream<Uint8Array>)
                  captured.push(decoder.decode(chunk, { stream: true }));
              }),
            ).catch(() => {})
          : undefined;
        const code = await child.exited.finally(() => live.delete(kill));
        if (drained) {
          await Promise.race([drained, Bun.sleep(CAPTURE_DRAIN_MS)]);
          const output = captured.join("").trimEnd();
          if (output.trim())
            console.log(`\n--- ${name}: ${command.join(" ")} ---\n${output}`);
        }
        if (code !== 0) throw new Error(`${name} failed; no success recorded`);
      }),
    );
    if (snapshot(root) !== sha)
      throw new Error("Commit changed during validation; no success recorded");
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
  };

  try {
    // Everything that does not build the artifact runs at once; the artifact
    // builders run in order beside them. A single machine has been running
    // these one after another on one core of many.
    const concurrent = names.filter((name) => !EXCLUSIVE.has(name));
    const parallel = concurrent.filter((name) => !SHARED_ARTIFACT.has(name));
    const serial = concurrent.filter((name) => SHARED_ARTIFACT.has(name));
    // Every task is settled before the exclusive pass begins, and before the
    // `finally` below removes the registry and the lock, so no child outlives
    // what it reads.
    await settle([
      ...parallel.map((name) => runCategory(name).catch(stop)),
      (async () => {
        for (const name of serial) await runCategory(name).catch(stop);
      })(),
    ]);
    for (const name of names.filter((name) => EXCLUSIVE.has(name)))
      await runCategory(name).catch(stop);
    if (failure !== undefined) throw failure;
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

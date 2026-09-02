#!/usr/bin/env bun
//
// One-time bootstrap for npm trusted publishing.
//
// Trusted publishing is a chicken-and-egg: npm will only attach a trusted
// publisher to a package that already exists, and `release.yml` carries no
// registry token, so it cannot create one. This script breaks the loop by
// publishing a placeholder version under every workspace name from a human's
// own npm session, then naming this repository and `release.yml` as each
// package's trusted publisher. After it runs once, every later release
// publishes through OIDC with no long-lived credential anywhere.
//
// It is idempotent: a package that already exists is not republished, and a
// package that already has a trusted publisher is left alone. It defaults to
// a dry run because the publish half is irreversible.
//
//   bun scripts/bootstrap-npm-trust.ts            # show the plan, change nothing
//   bun scripts/bootstrap-npm-trust.ts --confirm  # do it
//
// Two-factor authentication makes the publish half awkward, because npm asks
// for confirmation on every write. Set NPM_BOOTSTRAP_TOKEN to a granular
// access token with "bypass two-factor authentication" enabled and the
// placeholders publish unattended; the token is used here and nowhere else,
// never reaches CI, and should be revoked afterwards. Without it each publish
// waits on an interactive confirmation, sixty times over.
//
// Configuring the trusted publishers always uses the interactive session:
// `npm trust` rejects tokens by design, so that half needs `npm login`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export const REPOSITORY = "timoconnellaus/frockbot";
export const WORKFLOW_FILE = "release.yml";
// The placeholder exists only so a trusted publisher has something to attach
// to. It is deprecated on the way out so nobody installs it by accident, and
// the first real release supersedes it as `latest`.
export const PLACEHOLDER_VERSION = "0.0.0";
export const TOKEN_VARIABLE = "NPM_BOOTSTRAP_TOKEN";

export type WorkspacePackage = {
  readonly name: string;
  readonly directory: string;
};

/** Every publishable workspace under `packages/`, in a stable order. */
export function readWorkspacePackages(root: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const entry of readdirSync(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const directory = join("packages", entry.name);
    const manifestPath = join(root, directory, "package.json");
    let manifest: { name?: string };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.name) continue;
    packages.push({ name: manifest.name, directory });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The `npm trust` invocation that names this workflow as the publisher of one
 * package. No `--environment`: the `publish` job deliberately runs outside the
 * `production` environment, and a mismatched environment claim is rejected.
 */
export function trustArguments(packageName: string): string[] {
  return [
    "trust",
    "github",
    packageName,
    "--file",
    WORKFLOW_FILE,
    "--repo",
    REPOSITORY,
    "--allow-publish",
    "--yes",
  ];
}

/**
 * Publishing writes, so it needs whichever credential the run was given. With
 * a token that means a throwaway config file; without one it means handing npm
 * the terminal so its interactive confirmation can complete.
 */
export function publishArguments(userconfig?: string): string[] {
  const args = ["publish", "--access", "public"];
  if (userconfig) args.push("--userconfig", userconfig);
  return args;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; interactive?: boolean },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (command, args, options) => {
  if (options?.interactive) {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    return { exitCode: await child.exited, stdout: "", stderr: "" };
  }
  const child = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
};

/** The npm that introduced `npm trust`. Older ones do not have the command. */
export const MINIMUM_TRUST_NPM = "11.15.0";

export function supportsTrust(version: string) {
  const parse = (value: string) =>
    value
      .trim()
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const [major, minor, patch] = parse(version);
  const [wantMajor, wantMinor, wantPatch] = parse(MINIMUM_TRUST_NPM);
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}

/**
 * An npm without `trust` does not fail loudly — it prints "Unknown command"
 * and can still exit zero, which would record sixty packages as trusted when
 * none of them are. Refuse to start the phase instead.
 */
async function assertTrustSupported(run: CommandRunner) {
  const result = await run("npm", ["--version"]);
  const version = result.stdout.trim().split("\n").pop() ?? "";
  if (!supportsTrust(version)) {
    throw new Error(
      `npm ${version || "(unknown)"} has no \`trust\` command; ${MINIMUM_TRUST_NPM} or later is required. ` +
        "Check which npm is on PATH — a version manager may be pointing at an older one.",
    );
  }
}

async function packageExists(name: string, run: CommandRunner) {
  const result = await run("npm", ["view", name, "version"]);
  return result.exitCode === 0;
}

async function hasTrustedPublisher(name: string, run: CommandRunner) {
  const result = await run("npm", ["trust", "list", name]);
  if (result.exitCode !== 0) return false;
  return /github/i.test(result.stdout);
}

/** Publishes the placeholder that gives `npm trust` something to attach to. */
async function publishPlaceholder(
  entry: WorkspacePackage,
  run: CommandRunner,
  userconfig?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "frockbot-bootstrap-"));
  try {
    const manifest = {
      name: entry.name,
      version: PLACEHOLDER_VERSION,
      description:
        "Placeholder reserving this name for trusted publishing. Superseded by the first release.",
      license: "UNLICENSED",
      repository: {
        type: "git",
        url: `git+https://github.com/${REPOSITORY}.git`,
        directory: entry.directory,
      },
      publishConfig: { access: "public" },
    };
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(
      join(directory, "README.md"),
      `# ${entry.name}\n\nPlaceholder reserving this name. See https://github.com/${REPOSITORY}.\n`,
    );
    const published = await run("npm", publishArguments(userconfig), {
      cwd: directory,
      interactive: !userconfig,
    });
    if (published.exitCode !== 0) {
      const reason = published.stderr.trim() || "see the output above";
      throw new Error(`could not publish ${entry.name}: ${reason}`);
    }
    // Best effort: a placeholder that stays undeprecated is only untidy.
    const deprecate = [
      "deprecate",
      `${entry.name}@${PLACEHOLDER_VERSION}`,
      "Placeholder release; install a published version instead.",
    ];
    if (userconfig) deprecate.push("--userconfig", userconfig);
    await run("npm", deprecate, { interactive: !userconfig });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A config file holding only the bootstrap token, so ~/.npmrc is untouched. */
async function writeTokenConfig(token: string) {
  const directory = await mkdtemp(join(tmpdir(), "frockbot-npmrc-"));
  const file = join(directory, ".npmrc");
  await writeFile(
    file,
    `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`,
    { mode: 0o600 },
  );
  return { file, directory };
}

/**
 * The two halves need different credentials, so they can be run apart. A
 * token publishes unattended but `npm trust` refuses it, and the interactive
 * session that `npm trust` needs cannot be driven from a script. Running
 * `publish` first and `trust` second lets each half have the terminal, or
 * not, as it requires.
 */
export type Phase = "publish" | "trust" | "both";

export async function bootstrap(options: {
  root: string;
  confirm: boolean;
  token?: string;
  phase?: Phase;
  run?: CommandRunner;
  log?: (line: string) => void;
}) {
  const phase = options.phase ?? "both";
  const run = options.run ?? runCommand;
  const log = options.log ?? ((line: string) => console.log(line));
  const packages = readWorkspacePackages(options.root);

  log(`${packages.length} workspace packages under packages/`);
  if (!options.confirm) {
    log("");
    log("Dry run. Re-run with --confirm to publish placeholders and");
    log("configure trusted publishers. Planned work:");
  } else if (!options.token) {
    log("");
    log(`No ${TOKEN_VARIABLE} set: npm will ask you to confirm every publish.`);
    log("Ctrl-C and set a bypass-2FA token instead if that is not what you");
    log("want. Configuring the publishers always uses your login either way.");
    log("");
  }

  const config = options.token ? await writeTokenConfig(options.token) : null;

  let publishedCount = 0;
  let trustedCount = 0;

  const publishing = phase === "publish" || phase === "both";
  const trusting = phase === "trust" || phase === "both";

  if (trusting && options.confirm) await assertTrustSupported(run);

  try {
    for (const entry of packages) {
      const exists = await packageExists(entry.name, run);
      const trusted =
        exists && trusting && (await hasTrustedPublisher(entry.name, run));

      if ((exists || !publishing) && (trusted || !trusting)) {
        log(`  ${entry.name}: nothing to do`);
        continue;
      }

      if (!options.confirm) {
        if (!exists && publishing)
          log(
            `  ${entry.name}: publish placeholder${trusting ? ", then trust" : ""}`,
          );
        else log(`  ${entry.name}: trust`);
        continue;
      }

      if (!exists && publishing) {
        log(`  ${entry.name}: publishing placeholder`);
        await publishPlaceholder(entry, run, config?.file);
        publishedCount += 1;
      }

      if (!trusting) continue;

      if (!exists && !publishing) {
        throw new Error(
          `${entry.name} is not published yet, so it cannot be trusted; run the publish phase first`,
        );
      }

      log(`  ${entry.name}: configuring trusted publisher`);
      // Never the token: `npm trust` requires the interactive 2FA session, so
      // it also gets the terminal — a second factor it cannot ask for is a
      // second factor nobody can answer.
      const result = await run("npm", trustArguments(entry.name), {
        interactive: true,
      });
      if (result.exitCode !== 0) {
        const reason = result.stderr.trim() || "see the output above";
        throw new Error(
          `could not configure trusted publishing for ${entry.name}: ${reason}`,
        );
      }
      trustedCount += 1;
    }
  } finally {
    if (config) {
      await rm(config.directory, { recursive: true, force: true });
    }
  }

  if (options.confirm) {
    log("");
    log(
      `Published ${publishedCount} placeholders, configured ${trustedCount} trusted publishers.`,
    );
    log("release.yml can now publish through OIDC with no NPM_TOKEN.");
    if (options.token) {
      log(`Revoke the ${TOKEN_VARIABLE} token now; nothing needs it again.`);
    }
  }

  return { packages: packages.length, publishedCount, trustedCount };
}

if (import.meta.main) {
  const confirm = process.argv.includes("--confirm");
  const phase: Phase = process.argv.includes("--publish-only")
    ? "publish"
    : process.argv.includes("--trust-only")
      ? "trust"
      : "both";
  const root = fileURLToPath(new URL("..", import.meta.url));
  await bootstrap({
    root,
    confirm,
    phase,
    token: process.env[TOKEN_VARIABLE],
  });
}

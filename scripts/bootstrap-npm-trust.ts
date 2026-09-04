#!/usr/bin/env bun
//
// One-time bootstrap for npm trusted publishing.
//
// Trusted publishing is a chicken-and-egg: npm will only attach a trusted
// publisher to a package that already exists, and `release.yml` carries no
// registry token, so it cannot create one. This script breaks the loop by
// publishing a placeholder version under a name the registry does not have
// yet, from a human's own npm session, then naming this repository and
// `release.yml` as that package's trusted publisher. Every release after
// that publishes it through OIDC with no long-lived credential anywhere.
//
// It touches only the packages npm is missing. That is what keeps a run
// short, and a run has to be short: every authenticated npm call demands its
// own one-time password, answered in a browser, against a session that
// expires in minutes. Sixty packages' worth of prompts outlives the session
// long before it reaches the two packages that needed anything.
//
// It defaults to a dry run because the publish half is irreversible.
//
//   bun scripts/bootstrap-npm-trust.ts            # show the plan, change nothing
//   bun scripts/bootstrap-npm-trust.ts --confirm  # do it
//
// Naming packages narrows it further, and is the way back from a run that
// published a placeholder but failed before trusting it:
//
//   bun scripts/bootstrap-npm-trust.ts @frockbot/plugin-applets --confirm

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export const REPOSITORY = "timoconnellaus/frockbot";
export const WORKFLOW_FILE = "release.yml";
// The placeholder exists only so a trusted publisher has something to attach
// to. It is deprecated on the way out so nobody installs it by accident, and
// the first real release supersedes it as `latest`.
export const PLACEHOLDER_VERSION = "0.0.0";

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

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; interactive?: boolean },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (command, args, options) => {
  // Every operation that changes something on the registry needs a one-time
  // password, and npm asks for it by printing an authentication URL and
  // waiting for a browser to confirm it. Capturing that output hides the
  // question: npm waits on a prompt nobody was shown, and the failure that
  // eventually arrives reads as EOTP with the URL redacted. So a mutating
  // call is given the terminal, and only the read-only probes whose output
  // this script has to parse are captured. npm answers the password once per
  // operation, not once per session, so this is not something a single
  // sign-in up front can satisfy.
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

// Reading a version is public, so this is the one probe that costs no
// password and no waiting. Whether a package already has a trusted publisher
// is deliberately not asked: `npm trust list` is an authenticated call that
// demands its own one-time password, and asking it about sixty packages
// spends the whole session answering prompts about packages that need
// nothing. A package the registry already has was published by the release
// workflow, which means it is already trusted.
async function packageExists(name: string, run: CommandRunner) {
  const result = await run("npm", ["view", name, "version"]);
  return result.exitCode === 0;
}

/** Publishes the placeholder that gives `npm trust` something to attach to. */
async function publishPlaceholder(
  entry: WorkspacePackage,
  root: string,
  run: CommandRunner,
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
    const published = await run("npm", ["publish", "--access", "public"], {
      cwd: directory,
      interactive: true,
    });
    if (published.exitCode !== 0) {
      throw new Error(
        `could not publish ${entry.name}; npm's output is above this message`,
      );
    }
    // Best effort: a placeholder that stays undeprecated is only untidy.
    await run(
      "npm",
      [
        "deprecate",
        `${entry.name}@${PLACEHOLDER_VERSION}`,
        "Placeholder release; install a published version instead.",
      ],
      { interactive: true },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function bootstrap(options: {
  root: string;
  confirm: boolean;
  /**
   * Package names to bootstrap regardless of whether npm already has them.
   * Empty means the usual case: whatever the registry is missing. This is
   * the way back from a run that published a placeholder and then failed
   * before trusting it, which leaves a package that exists and still cannot
   * be published by the workflow.
   */
  only?: readonly string[];
  run?: CommandRunner;
  log?: (line: string) => void;
}) {
  const run = options.run ?? runCommand;
  const log = options.log ?? ((line: string) => console.log(line));
  const packages = readWorkspacePackages(options.root);
  const only = new Set(options.only ?? []);

  for (const name of only) {
    if (!packages.some((entry) => entry.name === name)) {
      throw new Error(`no workspace under packages/ is named ${name}`);
    }
  }

  // Every authenticated npm call needs its own one-time password, and the
  // session behind them expires in minutes, so the work is narrowed before
  // any of it starts rather than as it goes.
  const work: WorkspacePackage[] = [];
  const onRegistry = new Set<string>();
  for (const entry of packages) {
    if (only.size > 0 && !only.has(entry.name)) continue;
    if (await packageExists(entry.name, run)) {
      // Named explicitly, so it is here to be trusted rather than published.
      if (only.size === 0) continue;
      onRegistry.add(entry.name);
    }
    work.push(entry);
  }

  log(`${packages.length} workspace packages under packages/`);
  if (work.length === 0) {
    log("npm has every one of them; nothing to bootstrap.");
    return { packages: packages.length, publishedCount: 0, trustedCount: 0 };
  }

  log(`${work.length} to bootstrap:`);
  for (const entry of work) {
    log(
      onRegistry.has(entry.name)
        ? `  ${entry.name}: trust (npm already has it)`
        : `  ${entry.name}: publish placeholder, then trust`,
    );
  }

  if (!options.confirm) {
    log("");
    log("Dry run. Re-run with --confirm to publish placeholders and");
    log("configure trusted publishers.");
    return { packages: packages.length, publishedCount: 0, trustedCount: 0 };
  }

  let publishedCount = 0;
  let trustedCount = 0;

  log("");
  for (const entry of work) {
    if (!onRegistry.has(entry.name)) {
      log(`  ${entry.name}: publishing placeholder`);
      await publishPlaceholder(entry, options.root, run);
      publishedCount += 1;
    }

    log(`  ${entry.name}: configuring trusted publisher`);
    const result = await run("npm", trustArguments(entry.name), {
      interactive: true,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `could not configure trusted publishing for ${entry.name}; npm's output is above this message.\n` +
          `The placeholder is published, so finish it with:\n` +
          `  bun run bootstrap:npm-trust ${entry.name}`,
      );
    }
    trustedCount += 1;
  }

  log("");
  log(
    `Published ${publishedCount} placeholders, configured ${trustedCount} trusted publishers.`,
  );
  log("release.yml can now publish through OIDC with no NPM_TOKEN.");

  return { packages: packages.length, publishedCount, trustedCount };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const only = args.filter((argument) => !argument.startsWith("--"));
  const root = new URL("..", import.meta.url).pathname;
  await bootstrap({ root, confirm, only });
}

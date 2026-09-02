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
  options?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (command, args, options) => {
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
    });
    if (published.exitCode !== 0) {
      throw new Error(
        `could not publish ${entry.name}: ${published.stderr.trim()}`,
      );
    }
    // Best effort: a placeholder that stays undeprecated is only untidy.
    await run("npm", [
      "deprecate",
      `${entry.name}@${PLACEHOLDER_VERSION}`,
      "Placeholder release; install a published version instead.",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function bootstrap(options: {
  root: string;
  confirm: boolean;
  run?: CommandRunner;
  log?: (line: string) => void;
}) {
  const run = options.run ?? runCommand;
  const log = options.log ?? ((line: string) => console.log(line));
  const packages = readWorkspacePackages(options.root);

  log(`${packages.length} workspace packages under packages/`);
  if (!options.confirm) {
    log("");
    log("Dry run. Re-run with --confirm to publish placeholders and");
    log("configure trusted publishers. Planned work:");
  }

  let publishedCount = 0;
  let trustedCount = 0;

  for (const entry of packages) {
    const exists = await packageExists(entry.name, run);
    const trusted = exists && (await hasTrustedPublisher(entry.name, run));

    if (exists && trusted) {
      log(`  ${entry.name}: already published and trusted`);
      continue;
    }

    if (!options.confirm) {
      if (!exists) log(`  ${entry.name}: publish placeholder, then trust`);
      else log(`  ${entry.name}: trust`);
      continue;
    }

    if (!exists) {
      log(`  ${entry.name}: publishing placeholder`);
      await publishPlaceholder(entry, options.root, run);
      publishedCount += 1;
    }

    log(`  ${entry.name}: configuring trusted publisher`);
    const result = await run("npm", trustArguments(entry.name));
    if (result.exitCode !== 0) {
      throw new Error(
        `could not configure trusted publishing for ${entry.name}: ${result.stderr.trim()}`,
      );
    }
    trustedCount += 1;
  }

  if (options.confirm) {
    log("");
    log(
      `Published ${publishedCount} placeholders, configured ${trustedCount} trusted publishers.`,
    );
    log("release.yml can now publish through OIDC with no NPM_TOKEN.");
  }

  return { packages: packages.length, publishedCount, trustedCount };
}

if (import.meta.main) {
  const confirm = process.argv.includes("--confirm");
  const root = new URL("..", import.meta.url).pathname;
  await bootstrap({ root, confirm });
}

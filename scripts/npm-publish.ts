#!/usr/bin/env bun
/**
 * Which workspaces a release publishes to npm, and what publishing does to
 * their manifests.
 *
 * The Plugin SDK, and every workspace the Worker's graph reaches: a
 * white-label builds FrockBot from these at a release version, pinning an
 * exact version of each ([ADR 0038](../docs/adr/0038-white-label-deployments.md)
 * §5). One list, read by `release.yml`'s `publish-npm` job, by
 * `bootstrap-npm-trust.ts` and by the white-label fixture that proves the
 * packed tarballs deploy, so the three cannot disagree about what ships.
 *
 *   bun scripts/npm-publish.ts directories          # one per line
 *   bun scripts/npm-publish.ts set-versions <version>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLISHED_WORKSPACES_V1 = [
  "applets/sdk",
  "core",
  "app",
  "providers",
  "computer",
  "frock-compose",
  "applets",
  "apps/cloudflare",
] as const;

const DEPENDENCY_SECTIONS_V1 = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export type PackageManifestV1 = {
  name?: string;
  version?: string;
  private?: boolean;
  frockbot?: { npm?: boolean };
} & Partial<
  Record<(typeof DEPENDENCY_SECTIONS_V1)[number], Record<string, string>>
>;

/**
 * The manifest as it is published: the release's version, public, and every
 * `workspace:` range rewritten to that same version. Versions move in lockstep
 * with the tag, so `workspace:*` becomes the exact version and a consumer's
 * pins of every `@frockbot/*` package agree.
 */
export function publishedManifestV1(
  manifest: PackageManifestV1,
  version: string,
): PackageManifestV1 {
  const published = structuredClone(manifest);
  published.version = version;
  published.private = false;
  for (const section of DEPENDENCY_SECTIONS_V1) {
    const ranges = published[section];
    if (!ranges) continue;
    for (const [name, range] of Object.entries(ranges)) {
      if (range === "workspace:*") ranges[name] = version;
      if (range === "workspace:^") ranges[name] = `^${version}`;
      if (range === "workspace:~") ranges[name] = `~${version}`;
    }
  }
  return published;
}

export function readManifestV1(
  root: string,
  directory: string,
): PackageManifestV1 {
  return JSON.parse(
    readFileSync(join(root, directory, "package.json"), "utf8"),
  ) as PackageManifestV1;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const [command, version] = process.argv.slice(2);
  if (command === "directories") {
    for (const directory of PUBLISHED_WORKSPACES_V1) console.log(directory);
  } else if (command === "set-versions" && version) {
    for (const directory of PUBLISHED_WORKSPACES_V1) {
      const manifest = readManifestV1(root, directory);
      // The flag is the manifest's own say-so; a listed workspace without it
      // is a mistake to stop on, not one to publish around.
      if (manifest.frockbot?.npm !== true) {
        throw new Error(`${directory}/package.json does not set frockbot.npm`);
      }
      writeFileSync(
        join(root, directory, "package.json"),
        `${JSON.stringify(publishedManifestV1(manifest, version), null, 2)}\n`,
      );
    }
  } else {
    console.error("usage: npm-publish.ts directories | set-versions <version>");
    process.exit(2);
  }
}

#!/usr/bin/env bun
/**
 * The equivalence gate between two releases' deploy bundles: whether an install
 * of the previous one survives the next being deployed over it — same Worker
 * names, same buckets and index, same container applications, a migration
 * history that only grows at its end ([docs/deploy-bundles.md](../docs/deploy-bundles.md)).
 *
 *   bun scripts/check-deploy-bundle.ts <next manifest> [<previous manifest>]
 *
 * `release.yml` runs it before a bundle is attached, with the manifest of the
 * last release that published one. With no previous manifest there is nothing
 * to succeed, and the check says so and passes.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  bundleSuccessionProblemsV1,
  decodeBundleManifestV1,
} from "../apps/cloudflare/deployment-config/bundle.ts";

const [nextFile, previousFile] = process.argv.slice(2);
if (!nextFile) {
  console.error(
    "usage: bun scripts/check-deploy-bundle.ts <next manifest> [<previous manifest>]",
  );
  process.exit(2);
}
const read = (file: string) =>
  decodeBundleManifestV1(JSON.parse(readFileSync(file, "utf8")));
const next = read(nextFile);
if (!previousFile || !existsSync(previousFile)) {
  console.log(
    `No previous deploy bundle to succeed; ${next.version} is the first. Nothing to compare.`,
  );
  process.exit(0);
}
const previous = read(previousFile);
const problems = bundleSuccessionProblemsV1(previous, next);
if (problems.length > 0) {
  console.error(
    `An install of ${previous.version} would lose data if ${next.version} were deployed over it:`,
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `${next.version} deploys over an install of ${previous.version} onto the same namespaces.`,
);

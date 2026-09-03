import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  foundationBackendContributions,
  assertFoundationBackendContributionsResolvable,
} from "@frockbot/application-foundation/contributions";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";

/**
 * `AGENTS.md`, Package composition:
 *
 * > Every Contribution kind is resolved from the manifest and an artifact,
 * > never from a switch over Package identity.
 *
 * The application resolves a Contribution by looking the specifier its
 * manifest declares up in one table. These checks hold the rule mechanically:
 * no application or kernel module may compare a specifier against a Package's
 * name, and every Contribution the application declares must reach the table
 * (or an artifact, which loads through the isolate host instead).
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

/** The modules that own the table, and are therefore allowed to name Packages. */
const tableModules = new Set([
  "applications/foundation/src/contributions.ts",
  "applications/foundation/src/client-contributions.ts",
]);

function resolutionModules(): string[] {
  const files: string[] = ["apps/cloudflare/src/bot-state.ts"];
  for (const entry of new Bun.Glob("applications/foundation/src/*.ts").scanSync(
    repoRoot,
  )) {
    const path = entry.replaceAll("\\", "/");
    const full = `applications/foundation/src/${path.split("/").pop()}`;
    if (tableModules.has(full)) continue;
    if (full.endsWith(".test.ts")) continue;
    files.push(full);
  }
  return files.sort();
}

describe("Contribution resolution is manifest-driven", () => {
  test("no application or Bot Durable Object module switches on a Package specifier", () => {
    const offenders: string[] = [];
    for (const file of resolutionModules()) {
      const source = read(file);
      for (const [index, line] of source.split("\n").entries()) {
        const at = `${file}:${index + 1}`;
        // A comparison against a Package's own name is the switch this rule
        // exists to forbid, in whichever shape it is written.
        if (/\bspecifier\s*[=!]==?\s*["'`]@frockbot\//.test(line)) {
          offenders.push(`${at}: compares a specifier against a Package name`);
        }
        if (/^\s*case\s+["'`]@frockbot\//.test(line)) {
          offenders.push(`${at}: switches over a Package specifier`);
        }
        if (/\bswitch\s*\(\s*specifier\s*\)/.test(line)) {
          offenders.push(`${at}: switches over a Contribution specifier`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the kernel resolves a Contribution without naming a Package", () => {
    const descriptors = read("packages/kernel-contracts/src/contributions.ts");
    expect(descriptors).not.toContain("@frockbot/plugin-");
    expect(descriptors).toContain("defineBackendContribution");
    expect(descriptors).toContain("defineClientContribution");
  });

  test("every backend Contribution the application declares resolves through the table", async () => {
    const plan = await compileFoundationApplication();
    const table = foundationBackendContributions();
    const declared: string[] = [];
    for (const pkg of plan.packages) {
      for (const backend of pkg.manifest.contributions.backend ?? []) {
        const specifier = `${pkg.specifier}${backend.entry.slice(1)}`;
        declared.push(specifier);
        // An artifact-backed member loads through the isolate host; every
        // other member is first-party in-process and must be in the table.
        if (pkg.artifact) {
          expect(table.has(specifier)).toBe(false);
          continue;
        }
        expect(table.get(specifier)?.host).toBe(backend.host);
      }
    }
    expect(declared.length).toBeGreaterThan(0);
    // And the compile-time assertion agrees.
    expect(() =>
      assertFoundationBackendContributionsResolvable(plan),
    ).not.toThrow();
  });

  test("a declared Contribution that is neither in the table nor artifact-backed fails to compile", async () => {
    const plan = await compileFoundationApplication();
    const broken = {
      ...plan,
      packages: plan.packages.map((pkg) =>
        pkg.id === "admin"
          ? {
              ...pkg,
              specifier: "@frockbot/plugin-not-in-the-table",
            }
          : pkg,
      ),
    };
    expect(() =>
      assertFoundationBackendContributionsResolvable(broken),
    ).toThrow(
      /neither in the application's Contribution table nor artifact-backed/,
    );
  });

  test("every client Contribution the application declares exports a descriptor the table imports", async () => {
    const plan = await compileFoundationApplication();
    const table = read("applications/foundation/src/client-contributions.ts");
    let checked = 0;
    for (const pkg of plan.packages) {
      const client = pkg.manifest.contributions.client;
      if (!client || !("entry" in client)) continue;
      const specifier = `${pkg.specifier}${client.entry.slice(1)}`;
      const entryPath = packageEntryPath(pkg.specifier, client.entry);
      const source = read(entryPath);
      expect(
        source.includes(`defineClientContribution`) &&
          source.includes(JSON.stringify(specifier)),
      ).toBe(true);
      // The table imports the descriptor: by specifier, or (for the Computer
      // Package, whose client entry the application reaches by path) by file.
      expect(
        table.includes(`"${specifier}"`) ||
          table.includes(entryPath.replace("packages/", "").replace(".ts", "")),
      ).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/** Where a Package's export subpath resolves on disk. */
function packageEntryPath(specifier: string, entry: string): string {
  const name = specifier.split("/").slice(0, 2).join("/");
  const directory = `packages/${name.split("/")[1]}`;
  const manifest = JSON.parse(read(`${directory}/package.json`)) as {
    exports?: Record<string, string>;
  };
  const target = manifest.exports?.[entry];
  if (!target) throw new Error(`${name} does not export "${entry}"`);
  return `${directory}/${target.replace("./", "")}`;
}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ADR 0004's "the SDK is loaded in exactly one place" rule, enforced
// mechanically. `@fly/sprites` speaks a HTTP exec protocol that depends on
// response chunk boundaries workerd does not preserve, so it may exist only in
// the Node container app; every other package reaches the Computer through the
// `COMPUTER_HOST` service binding and `packages/computer-host-protocol`.
//
// Two facts are checked: no source file outside the host imports the SDK, and
// no manifest outside the host declares it as a dependency (a manifest entry is
// how the SDK creeps back into a workerd bundle's resolution graph).

const repoRoot = resolve(import.meta.dirname, "..");
const forbiddenPackage = "@fly/sprites";
const hostRoot = "apps/computer-host/";

const failures: string[] = [];

function isHostOwned(path: string): boolean {
  return path === hostRoot.slice(0, -1) || path.startsWith(hostRoot);
}

function scan(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true })]
    .filter((path) => !path.includes("node_modules/"))
    .filter((path) => !path.includes("dist/"))
    .sort();
}

// `from "x"`, `import "x"`, `import("x")`, `require("x")` — the four ways a
// specifier reaches a bundler, static and dynamic alike.
const specifierPattern =
  /(?:from|import|require)\s*\(?\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function specifiersOf(
  source: string,
): Array<{ specifier: string; line: number }> {
  const found: Array<{ specifier: string; line: number }> = [];
  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ specifier, line });
  }
  return found;
}

function isForbidden(specifier: string): boolean {
  return (
    specifier === forbiddenPackage ||
    specifier.startsWith(`${forbiddenPackage}/`)
  );
}

let filesChecked = 0;
for (const path of scan(
  "{apps,applications,packages,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,vue}",
)) {
  if (isHostOwned(path)) continue;
  filesChecked += 1;
  const source = readFileSync(resolve(repoRoot, path), "utf8");
  if (!source.includes(forbiddenPackage)) continue;
  for (const { specifier, line } of specifiersOf(source)) {
    if (!isForbidden(specifier)) continue;
    failures.push(
      `${path}:${line}: imports "${specifier}"; the Fly Sprites SDK lives only in ${hostRoot}** (ADR 0004) — reach the Computer through the COMPUTER_HOST service binding instead`,
    );
  }
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

let manifestsChecked = 0;
for (const path of scan("**/package.json")) {
  if (isHostOwned(dirname(path))) continue;
  manifestsChecked += 1;
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, path), "utf8"),
  ) as Record<string, unknown>;
  for (const field of dependencyFields) {
    const declared = manifest[field];
    if (!declared || typeof declared !== "object") continue;
    if (forbiddenPackage in (declared as Record<string, unknown>)) {
      failures.push(
        `${path}: declares "${forbiddenPackage}" in ${field}; only ${hostRoot}** may depend on the Fly Sprites SDK (ADR 0004)`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Computer host import contract passed (${filesChecked} files, ${manifestsChecked} manifests checked)\n`,
);

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ADR 0004's "the SDK is loaded in exactly one place" rule, enforced
// mechanically. `@fly/sprites` speaks a HTTP exec protocol that depends on
// response chunk boundaries workerd does not preserve, so it may exist only in
// the Node container app; every other package reaches the Computer through the
// `COMPUTER_HOST` service binding and `computer/host-protocol`.
//
// Two facts are checked: no source file outside the host imports the SDK, and
// no manifest outside the host declares it as a dependency (a manifest entry is
// how the SDK creeps back into a workerd bundle's resolution graph).
//
// Rule 2 is the narrowing this step is for. Fly is one implementation of
// `ComputerHostV1` and lives entirely in `computer/fly`; a file that imports it
// has bound itself to Fly, so only the implementation, the host app, and the
// two places that register the host may. Everything else reaches the Computer
// through `@frockbot/computer/core/host` and the tools above it.

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
  "{app,applets,apps,computer,core,providers,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
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

// The Fly implementation's own module, and the only files admitted to it.
const flyModule = "@frockbot/computer/fly";
const flyImporters = [
  "computer/fly/",
  "apps/computer-host/",
  // The two registration sites. Cut 3 hands the host in from the shell and
  // takes both off this list.
  "app/runtime.ts",
  "apps/cloudflare/src/bot-state.ts",
  // The workerd rig that proves this implementation runs where the Bot runs.
  // Cut 3 rebuilds it on the in-memory host and takes this entry off too.
  "apps/cloudflare/test/",
];

function mayImportFly(path: string): boolean {
  return flyImporters.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
  );
}

function isFlyModule(specifier: string): boolean {
  return specifier === flyModule || specifier.startsWith(`${flyModule}/`);
}

for (const path of scan(
  "{app,applets,apps,computer,core,providers,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
)) {
  if (mayImportFly(path)) continue;
  const source = readFileSync(resolve(repoRoot, path), "utf8");
  if (!source.includes(flyModule)) continue;
  for (const { specifier, line } of specifiersOf(source)) {
    if (!isFlyModule(specifier)) continue;
    failures.push(
      `${path}:${line}: imports "${specifier}"; Fly is one implementation of ComputerHostV1 and is importable only from computer/fly/**, apps/computer-host/** and the two registration sites — depend on @frockbot/computer/core/host instead`,
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

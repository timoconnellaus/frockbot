import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ADR 0028's "sign-in is a build-time Package" rule, enforced mechanically,
// the way `check-computer-host-imports.ts` polices the Computer host.
//
// Four rules:
//
// 1. `better-auth` is one implementation of `AuthPackageV1` and lives entirely
//    in `app/auth/better-auth/**`. Only it and the better-auth chooser may
//    name the dependency; everything else depends on the interface in
//    `core/contracts/auth-package.ts`. A simple deployment builds the Access
//    Package, and better-auth must not be in that bundle at all.
//    `app/package.json` is the one manifest that may declare it: a manifest
//    entry elsewhere is how a dependency creeps back into a bundle's
//    resolution graph even with no import naming it.
// 2. `app/auth/access/**` imports the contract and its own files. It is the
//    second implementation of the same interface, not a second front for the
//    first, so it reaches neither better-auth nor the code above sign-in.
// 3. Each chooser names exactly one implementation as a value, and never the
//    other chooser. There is one chooser per build, the Worker reaches whichever
//    one `#auth-package` resolves to, and a chooser that imported two Packages —
//    or its twin — would put both in one bundle.

const repoRoot = resolve(import.meta.dirname, "..");
const dependency = "better-auth";
const betterAuthRoot = "app/auth/better-auth/";
const accessRoot = "app/auth/access/";
/** One per build; the first is the tracked default `#auth-package` resolves to. */
const choosers = [
  "apps/cloudflare/src/auth-package.ts",
  "apps/cloudflare/src/auth-package.access.ts",
];
/** The chooser allowed to name `better-auth`, which is the build that uses it. */
const betterAuthChooser = choosers[0]!;

const failures: string[] = [];

function scan(pattern: string): string[] {
  return (
    [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true })]
      .filter((path) => !path.includes("node_modules/"))
      .filter((path) => !path.includes("dist/"))
      // `wrangler dev` leaves whole bundles here; they are build output.
      .filter((path) => !path.includes(".wrangler/"))
      .sort()
  );
}

/**
 * The source with its comments removed.
 *
 * The one place both implementations are written down — the choosing file —
 * documents the line a deployer flips in a comment. A commented import is
 * prose, not an import, and counting one made this rule fail on its own
 * documentation.
 */
function withoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

// `from "x"`, `import "x"`, `import("x")`, `require("x")` — the four ways a
// specifier reaches a bundler, static and dynamic alike.
const specifierPattern =
  /(?:from|import|require)\s*\(?\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function specifiersOf(
  source: string,
): Array<{ specifier: string; line: number; typeOnly: boolean }> {
  const found: Array<{ specifier: string; line: number; typeOnly: boolean }> =
    [];
  const scanned = withoutComments(source);
  for (const match of scanned.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const before = scanned.slice(0, match.index);
    const line = before.split("\n").length;
    const statement = before.slice(before.lastIndexOf("\n") + 1);
    found.push({
      specifier,
      line,
      typeOnly: /\bimport\s+type\b/.test(statement),
    });
  }
  return found;
}

function isDependency(specifier: string): boolean {
  return specifier === dependency || specifier.startsWith(`${dependency}/`);
}

const sources = scan(
  "{app,applets,apps,computer,core,frock-compose,providers,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
);

let filesChecked = 0;
for (const path of sources) {
  if (path.startsWith(betterAuthRoot) || path === betterAuthChooser) continue;
  // This file states the rule, so it has to be able to write the name down.
  if (path === "scripts/check-auth-package-imports.ts") continue;
  filesChecked += 1;
  const source = readFileSync(resolve(repoRoot, path), "utf8");
  if (!source.includes(dependency)) continue;
  for (const { specifier, line } of specifiersOf(source)) {
    if (!isDependency(specifier)) continue;
    failures.push(
      `${path}:${line}: imports "${specifier}"; better-auth is one implementation of AuthPackageV1 and is importable only from ${betterAuthRoot}** and its own chooser (${betterAuthChooser}) — depend on @frockbot/core/contracts instead (ADR 0028)`,
    );
  }
}

// Rule 2: what the Access Package may reach. Its own files, the contract, and
// the auth Package's shared responses. Nothing else: a Package that reached up
// into the app it serves would stop being substitutable.
const accessAdmits = [
  "@frockbot/core/contracts",
  "@frockbot/app/auth/shared",
  "node:",
];
for (const path of scan(`${accessRoot}**/*.{ts,tsx,mts,cts}`)) {
  // A Package's own tests drive it directly; only shipped code is gated.
  if (path.endsWith(".test.ts")) continue;
  const source = readFileSync(resolve(repoRoot, path), "utf8");
  for (const { specifier, line } of specifiersOf(source)) {
    if (specifier.startsWith(".")) continue;
    if (accessAdmits.some((allowed) => specifier.startsWith(allowed))) continue;
    failures.push(
      `${path}:${line}: imports "${specifier}"; ${accessRoot}** may import the contract and @frockbot/app/auth/shared only — the Access Package stores nothing and depends on nothing the hosted build brings in (ADR 0028)`,
    );
  }
}

// Rule 1, the manifest half: `app/package.json` owns the dependency, because
// that is the workspace the implementation lives in.
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
let manifestsChecked = 0;
for (const path of scan("**/package.json")) {
  if (path === "app/package.json") continue;
  manifestsChecked += 1;
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, path), "utf8"),
  ) as Record<string, unknown>;
  for (const field of dependencyFields) {
    const declared = manifest[field];
    if (!declared || typeof declared !== "object") continue;
    if (dependency in (declared as Record<string, unknown>)) {
      failures.push(
        `${path}: declares "${dependency}" in ${field}; only app/package.json may depend on it, since ${betterAuthRoot}** is the only code that imports it (ADR 0028)`,
      );
    }
  }
}

// Rule 3: each chooser names exactly one implementation as a value, and neither
// reaches the other. `#auth-package` resolves to one of them, and a generated
// config's `alias` decides which — so what is in the bundle is exactly what the
// resolved chooser imports.
const builds: string[] = [];
for (const chooser of choosers) {
  const specifiers = specifiersOf(
    readFileSync(resolve(repoRoot, chooser), "utf8"),
  )
    .filter(({ typeOnly }) => !typeOnly)
    .map(({ specifier }) => specifier);
  const chosen = specifiers.filter((specifier) =>
    specifier.startsWith("@frockbot/app/auth/"),
  );
  if (chosen.length !== 1) {
    failures.push(
      `${chooser}: imports ${chosen.length} auth Packages (${chosen.join(", ") || "none"}); a build names exactly one, and the build is this one import line (ADR 0028)`,
    );
  }
  for (const specifier of specifiers) {
    if (!specifier.includes("auth-package")) continue;
    failures.push(
      `${chooser}: imports "${specifier}"; the choosers are alternatives, and one that reached the other would put both Packages in one bundle (ADR 0028)`,
    );
  }
  builds.push(`${chooser.replace(/^.*\//, "")} → ${chosen[0] ?? "none"}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Auth Package contract passed (${filesChecked} files, ${manifestsChecked} manifests checked; ${builds.join(", ")})\n`,
);

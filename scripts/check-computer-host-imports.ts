import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ADR 0004's "the SDK is loaded in exactly one place" rule, enforced
// mechanically. `@fly/sprites` speaks a HTTP exec protocol that depends on
// response chunk boundaries workerd does not preserve, so it may exist only in
// the Node container app; every other package reaches the Computer through the
// `COMPUTER_HOST` service binding and `computer/host-protocol`.
//
// Four rules, in the order they were added:
//
// 1. No source file outside the host imports `@fly/sprites`, and no manifest
//    outside the host declares it as a dependency (a manifest entry is how the
//    SDK creeps back into a workerd bundle's resolution graph).
// 2. Fly is one implementation of `ComputerHostV1` and lives entirely in
//    `computer/fly`; a file that imports it has bound itself to Fly, so only
//    the implementation, the host app, the one deployment chooser, and the two
//    rigs that prove the implementation may. Everything else reaches the
//    Computer through `@frockbot/computer/core/host` and the tools above it.
// 3. No source outside the implementation and the host app may *name* a Fly
//    Sprite or its desktop stack, in code or in prose. An import gate stops
//    the dependency; this stops the vocabulary, which is what teaches the next
//    reader that Fly is the model. `SPRITES_TOKEN` is the one exception: it is
//    the production secret name and renaming it would rotate a live
//    deployment's credential for a word.
// 4. `computer/fake/**` imports `computer/core` only. A second host that
//    reached into the first would be that host's double, not a substitution.

const repoRoot = resolve(import.meta.dirname, "..");
const forbiddenPackage = "@fly/sprites";
const hostRoot = "apps/computer-host/";

const failures: string[] = [];

function isHostOwned(path: string): boolean {
  return path === hostRoot.slice(0, -1) || path.startsWith(hostRoot);
}

function scan(pattern: string): string[] {
  return (
    [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true })]
      .filter((path) => !path.includes("node_modules/"))
      .filter((path) => !path.includes("dist/"))
      // `wrangler dev` leaves whole bundles here; they are build output, and a
      // bundle contains every word its inputs did.
      .filter((path) => !path.includes(".wrangler/"))
      .sort()
  );
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
  // The one place this deployment chooses its Computer host. Substituting a
  // k8s host is this file and nothing else.
  "apps/cloudflare/src/computer-host.ts",
  // The two rigs that prove the implementation. Both name Fly because Fly is
  // their subject: the shared contract suite runs the interface's own cases
  // against this implementation beside the in-memory one, and the workerd
  // project drives it over the real v1 wire on a service binding — the only
  // place both halves of that pair are exercised where the Bot runs.
  "computer/host-contract.test.ts",
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
      `${path}:${line}: imports "${specifier}"; Fly is one implementation of ComputerHostV1 and is importable only from computer/fly/**, apps/computer-host/**, the deployment chooser and the two rigs that prove it — depend on @frockbot/computer/core/host instead`,
    );
  }
}

// Rule 3: the vocabulary. A Sprite, its desktop stack and its viewer origin
// are Fly's, and naming one outside the implementation — in an identifier, a
// string, or a comment — is how the next reader learns that Fly is the model.
// `SPRITES_TOKEN` is admitted exactly: it is the production secret name, and
// renaming it would rotate a live deployment's credential for a word.
const flyVocabulary =
  /sprite|sprites\.app|novnc|x11vnc|xvfb|fluxbox|websockify/i;
const SECRET_NAME = "SPRITES_TOKEN";
const vocabularyOwners = [
  "computer/fly/",
  "apps/computer-host/",
  // This file states the rule, so it has to be able to write it down.
  "scripts/check-computer-host-imports.ts",
  // The marketing site is the other direction entirely: its privacy policy and
  // terms have to name the real sub-processor by its real name, and its own
  // "sprite" is an SVG sprite sheet, which is a different word that happens to
  // be spelled the same.
  "apps/marketing/",
];

function ownsVocabulary(path: string): boolean {
  return vocabularyOwners.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
  );
}

let vocabularyChecked = 0;
for (const path of scan(
  "{app,applets,apps,computer,core,frock-compose,providers,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,dart}",
)) {
  if (ownsVocabulary(path)) continue;
  vocabularyChecked += 1;
  const source = readFileSync(resolve(repoRoot, path), "utf8");
  if (!flyVocabulary.test(source)) continue;
  source.split("\n").forEach((line, index) => {
    // The secret name is the one admitted occurrence, so it is removed before
    // the line is judged rather than exempting the whole line.
    const remainder = line.replaceAll(SECRET_NAME, "");
    if (!flyVocabulary.test(remainder)) return;
    failures.push(
      `${path}:${index + 1}: names a Fly Sprite or its desktop stack ("${
        flyVocabulary.exec(remainder)?.[0] ?? ""
      }"); that vocabulary lives only in computer/fly/** and apps/computer-host/** — say "Computer" or "host" instead (${SECRET_NAME} is the one exception)`,
    );
  });
}

// Rule 4: the in-memory host depends on the interface and on nothing else in
// this Package. A fake that reached into `computer/fly`, or up into the tools
// it is a fixture for, would be a double of one implementation rather than a
// second host, and would stop proving anything about substitution.
const fakeRoot = "computer/fake/";
const fakeAdmits = ["@frockbot/computer/core", "@frockbot/computer/core/host"];

for (const path of scan(`${fakeRoot}**/*.{ts,tsx,mts,cts}`)) {
  const source = readFileSync(resolve(repoRoot, path), "utf8");
  for (const { specifier, line } of specifiersOf(source)) {
    if (!specifier.startsWith("@frockbot/computer")) continue;
    if (fakeAdmits.includes(specifier)) continue;
    failures.push(
      `${path}:${line}: imports "${specifier}"; ${fakeRoot}** may import @frockbot/computer/core and @frockbot/computer/core/host only — the in-memory host is a second implementation of the interface, not a double of the first`,
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
  `Computer host contract passed (${filesChecked} import files, ${vocabularyChecked} vocabulary files, ${manifestsChecked} manifests checked)\n`,
);

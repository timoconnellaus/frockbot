import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// "core imports nothing above it", enforced mechanically. Walks the import graph
// of every non-test source file under core/ and fails on any specifier that
// reaches a Package, an application, or an app.

const repoRoot = resolve(import.meta.dirname, "..");
const coreRoot = join(repoRoot, "core");
const failures: string[] = [];

interface WorkspacePackage {
  name: string;
  dir: string;
  exports: Record<string, string>;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function exportMap(manifest: Record<string, unknown>): Record<string, string> {
  const declared = manifest.exports;
  if (typeof declared === "string") return { ".": declared };
  if (!declared || typeof declared !== "object")
    return { ".": "./src/index.ts" };
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (typeof value === "string") map[key] = value;
  }
  return map;
}

const workspace = new Map<string, WorkspacePackage>();
const manifestPaths = ["core/package.json"];
for (const group of ["packages", "apps", "applications"]) {
  manifestPaths.push(
    ...new Bun.Glob(`${group}/*/package.json`).scanSync({
      cwd: repoRoot,
      onlyFiles: true,
    }),
  );
}
for (const manifestPath of manifestPaths) {
  const manifest = readJson(join(repoRoot, manifestPath));
  const name = manifest.name;
  if (typeof name !== "string") continue;
  workspace.set(name, {
    name,
    dir: join(repoRoot, dirname(manifestPath)),
    exports: exportMap(manifest),
  });
}

function isForbiddenSpecifier(specifier: string): string | undefined {
  if (
    specifier.startsWith("apps/") ||
    specifier.startsWith("applications/") ||
    specifier.includes("/apps/") ||
    specifier.includes("/applications/")
  ) {
    return "an app or application";
  }
  if (!specifier.startsWith("@frockbot/")) return undefined;
  if (
    specifier === "@frockbot/core" ||
    specifier.startsWith("@frockbot/core/") ||
    specifier.startsWith("@frockbot/compose-")
  ) {
    return undefined;
  }
  return "a Package";
}

function resolveFile(candidate: string): string | undefined {
  const attempts = [
    candidate,
    candidate.replace(/\.js$/, ".ts"),
    `${candidate}.ts`,
    join(candidate, "index.ts"),
  ];
  for (const attempt of attempts) {
    if (existsSync(attempt) && statSync(attempt).isFile()) return attempt;
  }
  return undefined;
}

function packageOf(specifier: string): WorkspacePackage | undefined {
  const segments = specifier.split("/");
  const name = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  return workspace.get(name);
}

function resolveWorkspaceEntry(specifier: string): string | undefined {
  const pkg = packageOf(specifier);
  if (!pkg) return undefined;
  const subpath = `.${specifier.slice(pkg.name.length)}` || ".";
  const target = pkg.exports[subpath === "." ? "." : subpath];
  if (!target) return undefined;
  return resolveFile(join(pkg.dir, target));
}

const specifierPattern =
  /(?:from|import)\s*\(?\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) found.push(specifier);
  }
  return found;
}

interface Visit {
  file: string;
  root: string;
  via: string[];
}

const seen = new Set<string>();
const queue: Visit[] = [];

for (const entry of new Bun.Glob("core/**/*.ts").scanSync({
  cwd: repoRoot,
  onlyFiles: true,
})) {
  // Core tests mount concrete Packages on purpose; only shipped code is gated.
  if (entry.endsWith(".test.ts")) continue;
  queue.push({ file: join(repoRoot, entry), root: coreRoot, via: [] });
}

while (queue.length > 0) {
  const { file, root, via } = queue.pop()!;
  if (seen.has(file)) continue;
  seen.add(file);
  const trail = [...via, relative(repoRoot, file)];
  for (const specifier of specifiersOf(file)) {
    const reason = isForbiddenSpecifier(specifier);
    if (reason) {
      failures.push(`${trail.join(" -> ")}: imports ${reason}: "${specifier}"`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = resolveFile(resolve(dirname(file), specifier));
      if (!resolved) continue;
      if (relative(root, resolved).startsWith("..")) {
        failures.push(
          `${trail.join(" -> ")}: leaves ${relative(repoRoot, root)}: "${specifier}"`,
        );
        continue;
      }
      queue.push({ file: resolved, root, via: trail });
      continue;
    }
    const entry = resolveWorkspaceEntry(specifier);
    if (entry) {
      queue.push({ file: entry, root: packageOf(specifier)!.dir, via: trail });
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Core import contract passed (${seen.size} files checked)\n`,
);

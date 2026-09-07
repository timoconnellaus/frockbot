import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// "a module imports nothing above it", enforced mechanically. Walks the import
// graph of every non-test source file under each module root and fails on any
// specifier that reaches a Package or an app the module's row below does not
// allow.

const repoRoot = resolve(import.meta.dirname, "..");
const failures: string[] = [];

interface Module {
  dir: string;
  allowed: string[];
  /** Subtrees of `dir` that belong to another workspace, relative to it. */
  skip?: string[];
}

const coreAllowed = ["@frockbot/core/", "@frockbot/compose-"];

const modules: Module[] = [
  { dir: "core", allowed: coreAllowed },
  {
    dir: "applets",
    allowed: [...coreAllowed, "@frockbot/applets/", "@frockbot/applet-sdk/"],
    // `applets/sdk` is its own published workspace, not part of this module.
    skip: ["sdk/"],
  },
  {
    dir: "computer",
    allowed: [
      ...coreAllowed,
      "@frockbot/computer/",
      // Temporary: the Vue client and the backend contribution reach the app
      // and the client libraries until step 9 deletes them. `app/subagents/
      // shared` is reached only through the shell's own shared module, for one
      // view type.
      "@frockbot/app/shell/",
      "@frockbot/app/subagents/shared",
      "@frockbot/client-core",
      "@frockbot/client-ui",
    ],
  },
  {
    dir: "providers",
    allowed: [
      ...coreAllowed,
      "@frockbot/providers/",
      // Temporary: the app cut's follow-up moves these three seams into core.
      "@frockbot/app/credentials/user",
      "@frockbot/app/settings/user",
      "@frockbot/app/web/contract",
    ],
  },
  {
    dir: "app",
    allowed: [
      ...coreAllowed,
      "@frockbot/app/",
      "@frockbot/applets/",
      "@frockbot/client-core",
      "@frockbot/client-ui",
      "@frockbot/computer/",
      "@frockbot/providers/",
    ],
  },
];

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
const manifestPaths = [
  "app/package.json",
  "applets/package.json",
  "computer/package.json",
  "core/package.json",
  "providers/package.json",
];
for (const group of ["packages", "apps"]) {
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

function isForbiddenSpecifier(
  module: Module,
  specifier: string,
): string | undefined {
  if (specifier.startsWith("apps/") || specifier.includes("/apps/")) {
    return "an app";
  }
  if (!specifier.startsWith("@frockbot/")) return undefined;
  for (const allowed of module.allowed) {
    const bare = allowed.replace(/\/$/, "");
    if (specifier === bare || specifier.startsWith(allowed)) return undefined;
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

for (const module of modules) {
  const moduleRoot = join(repoRoot, module.dir);
  const queue: Visit[] = [];
  for (const entry of new Bun.Glob(`${module.dir}/**/*.ts`).scanSync({
    cwd: repoRoot,
    onlyFiles: true,
  })) {
    // Module tests mount concrete Packages on purpose; only shipped code is gated.
    if (entry.endsWith(".test.ts")) continue;
    const within = relative(module.dir, entry);
    if (module.skip?.some((prefix) => within.startsWith(prefix))) continue;
    queue.push({ file: join(repoRoot, entry), root: moduleRoot, via: [] });
  }

  while (queue.length > 0) {
    const { file, root, via } = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const trail = [...via, relative(repoRoot, file)];
    for (const specifier of specifiersOf(file)) {
      const reason = isForbiddenSpecifier(module, specifier);
      if (reason) {
        failures.push(
          `${trail.join(" -> ")}: imports ${reason}: "${specifier}"`,
        );
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
        queue.push({
          file: entry,
          root: packageOf(specifier)!.dir,
          via: trail,
        });
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Layer import contract passed (${seen.size} files checked)\n`,
);

import { readFileSync } from "node:fs";

const failures: string[] = [];
const themePackage = "packages/plugin-ui-theme/";
const featureStyles = [
  ...new Bun.Glob("packages/*/src/client/**/*.{css,vue}").scanSync({
    cwd: ".",
    onlyFiles: true,
  }),
  ...new Bun.Glob("packages/client-ui/src/**/*.{css,vue}").scanSync({
    cwd: ".",
    onlyFiles: true,
  }),
];
const literalColor = /#[\da-f]{3,8}\b|rgba?\([^)]*\)/giu;
const globalThemeSelector = /^\s*(?::root|html\b|body\b)/gmu;

for (const path of featureStyles) {
  if (path.startsWith(themePackage)) continue;
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(literalColor)) {
    const line = source.slice(0, match.index).split("\n").length;
    failures.push(
      `${path}:${line} literal color ${JSON.stringify(match[0])}; use a semantic --frock-* alias`,
    );
  }
  for (const match of source.matchAll(globalThemeSelector)) {
    const line = source.slice(0, match.index).split("\n").length;
    failures.push(
      `${path}:${line} feature styles cannot own a global theme selector`,
    );
  }
  if (
    path.endsWith(".vue") &&
    /<style(?![^>]*\bscoped\b)[^>]*>/u.test(source)
  ) {
    failures.push(`${path}: Vue feature styles must be scoped`);
  }
}

const manifests = new Bun.Glob("packages/*/frockbot.json").scanSync({
  cwd: ".",
  onlyFiles: true,
});
for (const path of manifests) {
  let manifest: {
    id?: string;
    dependencies?: Record<string, string>;
    contributions?: { client?: unknown; web?: unknown };
  };
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as typeof manifest;
  } catch (error) {
    failures.push(
      `${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }
  if (
    manifest.id === "ui-theme" ||
    (!manifest.contributions?.client && !manifest.contributions?.web)
  ) {
    continue;
  }
  if (!manifest.dependencies?.["ui-theme"]) {
    failures.push(`${path}: client contribution must depend on ui-theme`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("UI style contract passed\n");

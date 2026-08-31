import { readFileSync } from "node:fs";
import { parse as parseVue } from "@vue/compiler-sfc";
import {
  generate,
  lexer,
  parse as parseCss,
  walk,
  type CssNode,
  type Declaration,
} from "css-tree";

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
const customProperties = new Map<string, string>();
const colorFunctions = new Set([
  "color",
  "color-mix",
  "device-cmyk",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "light-dark",
  "oklab",
  "oklch",
  "rgb",
  "rgba",
]);

function location(path: string, lineOffset: number, node: CssNode): string {
  const line = lineOffset + (node.loc?.start.line ?? 1);
  return `${path}:${line}`;
}

function containsLiteralColor(declaration: Declaration): boolean {
  let found = false;
  walk(declaration.value, (node) => {
    if (
      node.type === "Hash" ||
      (node.type === "Function" &&
        colorFunctions.has(node.name.toLowerCase())) ||
      (node.type === "Identifier" &&
        node.name !== "transparent" &&
        node.name.toLowerCase() !== "currentcolor" &&
        lexer.matchType("color", node).error === null)
    ) {
      found = true;
    }
  });
  return found;
}

const fontSizeProperties = new Set(["font", "font-size"]);

/**
 * Feature styles size text through the theme's type scale so every plugin
 * shares one hierarchy. Any absolute or font-relative length written directly
 * into `font-size` (or the `font` shorthand) bypasses that scale.
 */
function containsLiteralFontSize(declaration: Declaration): boolean {
  if (!fontSizeProperties.has(declaration.property.toLowerCase())) return false;
  let found = false;
  walk(declaration.value, (node) => {
    if (node.type === "Dimension") found = true;
  });
  return found;
}

function collectCustomProperties(ast: CssNode): void {
  walk(ast, (node) => {
    if (node.type === "Declaration" && node.property.startsWith("--")) {
      customProperties.set(node.property, generate(node.value));
    }
  });
}

function resolveVariables(value: string): {
  resolved: string;
  unresolved: string[];
} {
  const unresolved = new Set<string>();
  let resolved = value;
  for (let depth = 0; depth < 20 && resolved.includes("var("); depth += 1) {
    let replaced = false;
    resolved = resolved.replace(
      /var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\s*\)/gu,
      (match, name: string, fallback: string | undefined) => {
        const replacement = customProperties.get(name) ?? fallback;
        if (replacement === undefined) {
          unresolved.add(name);
          return match;
        }
        replaced = true;
        return replacement;
      },
    );
    if (!replaced) break;
  }
  return { resolved, unresolved: [...unresolved] };
}

function parseStylesheet(
  path: string,
  source: string,
  lineOffset: number,
): CssNode | undefined {
  let ast: CssNode;
  try {
    ast = parseCss(source, { positions: true });
  } catch (error) {
    failures.push(
      `${path}:${lineOffset + 1} invalid CSS: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  return ast;
}

function checkCss(path: string, ast: CssNode, lineOffset = 0): void {
  walk(ast, (node) => {
    if (
      (node.type === "TypeSelector" &&
        (node.name === "html" || node.name === "body")) ||
      (node.type === "PseudoClassSelector" && node.name === "root")
    ) {
      failures.push(
        `${location(path, lineOffset, node)} feature styles cannot own a global theme selector`,
      );
    }

    if (node.type !== "Declaration") return;

    if (containsLiteralColor(node)) {
      failures.push(
        `${location(path, lineOffset, node)} literal color in ${node.property}; use a semantic --frock-* alias`,
      );
    }

    if (node.property.startsWith("--")) return;

    if (containsLiteralFontSize(node)) {
      failures.push(
        `${location(path, lineOffset, node)} literal font size in ${node.property}; use a --frock-text-* alias`,
      );
    }

    const { resolved, unresolved } = resolveVariables(generate(node.value));
    for (const name of unresolved.filter((value) =>
      value.startsWith("--frock-"),
    )) {
      failures.push(
        `${location(path, lineOffset, node)} unknown semantic token ${name}`,
      );
    }
    if (unresolved.length > 0) return;

    const match = lexer.matchProperty(node.property, resolved);
    if (match.error && !match.error.message.startsWith("Unknown property")) {
      failures.push(
        `${location(path, lineOffset, node)} invalid ${node.property} declaration: ${match.error.message}`,
      );
    }
  });
}

const themePath = `${themePackage}src/client/theme.css`;
const themeAst = parseStylesheet(themePath, readFileSync(themePath, "utf8"), 0);
if (themeAst) collectCustomProperties(themeAst);

for (const path of featureStyles) {
  if (path.startsWith(themePackage)) continue;
  const source = readFileSync(path, "utf8");
  if (path.endsWith(".css")) {
    const ast = parseStylesheet(path, source, 0);
    if (ast) {
      collectCustomProperties(ast);
      checkCss(path, ast);
    }
    continue;
  }

  const { descriptor, errors } = parseVue(source, { filename: path });
  for (const error of errors) {
    failures.push(
      `${path}: invalid Vue component: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const style of descriptor.styles) {
    if (!style.scoped) {
      failures.push(
        `${path}:${style.loc.start.line}: Vue feature styles must be scoped`,
      );
    }
    const ast = parseStylesheet(path, style.content, style.loc.start.line - 1);
    if (ast) {
      collectCustomProperties(ast);
      checkCss(path, ast, style.loc.start.line - 1);
    }
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

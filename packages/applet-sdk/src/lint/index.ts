/**
 * `@frockbot/applet-sdk/lint` — the flat config, the rules, and the one call
 * `applet check` makes.
 *
 * A diagnostic is the SDK's whole answer to "what did I do wrong": the CLI
 * prints `path:line:col message` and nothing else, so what a Bot must remember
 * is the message, not a manual.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { ESLint, type Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";

import { appletRules } from "./rules.js";

export * from "./rules.js";

export interface AppletDiagnostic {
  /** Path relative to the Applet's directory. */
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

/** The one line the CLI prints per diagnostic. */
export function formatDiagnostic(diagnostic: AppletDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
}

export const appletPlugin = {
  rules: appletRules as unknown as Record<string, Rule.RuleModule>,
};

/** The flat config an Applet is linted with. */
export function appletLintConfig(): Linter.Config[] {
  return [
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: {
        parser: tseslint.parser as unknown as Linter.Parser,
        parserOptions: {
          ecmaVersion: 2023,
          sourceType: "module",
          ecmaFeatures: { jsx: true },
        },
      },
      plugins: { applet: appletPlugin },
      rules: {
        "applet/no-raw-colors": "error",
        "applet/no-network": "error",
        "applet/allowed-imports": "error",
        "applet/tables-via-table": "error",
        "applet/tools-via-this-tool": "error",
      },
    },
  ];
}

const CSS_COLOR =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\([^)]*\)|\bhsla?\s*\([^)]*\)|\bcolor-mix\s*\(/g;

/**
 * ESLint does not see `.css`, and a stylesheet is the easiest place to smuggle
 * a colour past the theme, so the same rule is applied here by hand.
 */
export function lintCssText(text: string, file: string): AppletDiagnostic[] {
  const diagnostics: AppletDiagnostic[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("/*")) return;
    for (const match of line.matchAll(CSS_COLOR)) {
      const before = line.slice(0, match.index);
      // Allowed only as the fallback inside a --frockbot-* token reference.
      if (/var\(\s*--frockbot-[a-z-]+\s*,[^)]*$/.test(before)) continue;
      diagnostics.push({
        file,
        line: index + 1,
        column: match.index + 1,
        message:
          `"${match[0]}" is a raw colour; use a --frockbot-* theme token ` +
          "(or a var(--frockbot-…, fallback)).",
        severity: "error",
      });
    }
  });
  return diagnostics;
}

async function sourceFiles(
  directory: string,
  extensions: string[],
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(path);
      }
    }
  };
  await walk(directory);
  return found;
}

/** Lint one Applet directory. Returns diagnostics; never throws on a finding. */
export async function lintApplet(
  directory: string,
): Promise<AppletDiagnostic[]> {
  const root = resolve(directory);
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: appletLintConfig(),
    errorOnUnmatchedPattern: false,
  });
  const results = await eslint.lintFiles(
    await sourceFiles(root, [".ts", ".tsx"]),
  );
  const diagnostics: AppletDiagnostic[] = [];
  for (const result of results) {
    for (const message of result.messages) {
      diagnostics.push({
        file: relative(root, result.filePath),
        line: message.line ?? 1,
        column: message.column ?? 1,
        message: `${message.message}${message.ruleId ? ` (${message.ruleId})` : ""}`,
        severity: message.severity === 2 ? "error" : "warning",
      });
    }
  }
  for (const path of await sourceFiles(root, [".css"])) {
    diagnostics.push(
      ...lintCssText(await readFile(path, "utf8"), relative(root, path)),
    );
  }
  return diagnostics;
}

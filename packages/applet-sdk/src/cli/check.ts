/**
 * `applet check` — the type checker and the linter, one diagnostic list.
 *
 * The Applet has no `node_modules`: it is source at a durable root. So the
 * compiler options are built here from `paths.ts` rather than from a tsconfig
 * the Bot would have to maintain, and every diagnostic comes back in the one
 * shape the CLI prints.
 */

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

import { lintApplet, type AppletDiagnostic } from "../lint/index.js";
import { readDescriptor } from "./manifest.js";
import { SDK_WORKERS_TYPES, typeCheckerPaths } from "./paths.js";

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  forceConsistentCasingInFileNames: true,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
};

async function appletSources(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
    }
  };
  await walk(directory);
  return found;
}

/** Type-check the Applet against the SDK's declarations. */
export async function typeCheckApplet(
  directory: string,
): Promise<AppletDiagnostic[]> {
  const root = resolve(directory);
  const files = await appletSources(root);
  if (files.length === 0) {
    return [
      {
        file: "applet.json",
        line: 1,
        column: 1,
        message:
          "No TypeScript sources found; an Applet needs server.ts and ui.tsx.",
        severity: "error",
      },
    ];
  }
  const program = ts.createProgram([...files, SDK_WORKERS_TYPES], {
    ...COMPILER_OPTIONS,
    baseUrl: root,
    paths: typeCheckerPaths(),
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        !diagnostic.file || diagnostic.file.fileName.startsWith(root),
    )
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " ",
      );
      if (!diagnostic.file || diagnostic.start === undefined) {
        return {
          file: "applet.json",
          line: 1,
          column: 1,
          message,
          severity: "error" as const,
        };
      }
      const position = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      return {
        file: relative(root, diagnostic.file.fileName),
        line: position.line + 1,
        column: position.character + 1,
        message: `${message} (TS${diagnostic.code})`,
        severity:
          diagnostic.category === ts.DiagnosticCategory.Error
            ? ("error" as const)
            : ("warning" as const),
      };
    });
}

/** Everything `applet check` reports, in source order. */
export async function checkApplet(
  directory: string,
): Promise<AppletDiagnostic[]> {
  const root = resolve(directory);
  const diagnostics: AppletDiagnostic[] = [];
  try {
    await readDescriptor(root);
  } catch (error) {
    diagnostics.push({
      file: "applet.json",
      line: 1,
      column: 1,
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    });
    return diagnostics;
  }
  diagnostics.push(...(await typeCheckApplet(root)));
  diagnostics.push(...(await lintApplet(root)));
  return diagnostics.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

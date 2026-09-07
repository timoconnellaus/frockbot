/**
 * `applet build` — three immutable artifacts from two source files.
 *
 * `dist/server.js`  one ESM file whose only import is `cloudflare:workers`,
 *                   exporting `Applet`, which is the name the kernel mounts.
 * `dist/ui.html`    one self-contained page: React, TanStack DB, the kit, and
 *                   the app inlined. No external URL, because the artifact
 *                   origin serves it into a sandbox with no network of its own.
 * `dist/manifest.json` `{ contract, tools, hashes }`.
 *
 * The tool declarations come from mounting the built server in Miniflare and
 * calling `health()`, not from reading the source. Static analysis would be a
 * second implementation of `this.tool(...)` that could disagree with the one
 * the kernel actually asks — and the kernel admits a generation by comparing
 * the manifest to the facet's own `health()`, so any disagreement is a failed
 * publish. Running the code is the only derivation that cannot drift.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build as esbuild } from "esbuild";

import type { AppletDescriptionV1 } from "../server/applet.js";
import { readDescriptor, type AppletBuildManifestV1 } from "./manifest.js";
import { bundlerNodePaths, SDK_ENTRIES } from "./paths.js";
import { startAppletRuntime } from "./runtime.js";

export interface AppletBuildResult {
  directory: string;
  serverPath: string;
  uiPath: string;
  manifestPath: string;
  manifest: AppletBuildManifestV1;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function alias(): Record<string, string> {
  return { ...SDK_ENTRIES };
}

async function bundle(options: {
  stdin: string;
  resolveDir: string;
  platform: "neutral" | "browser";
  format: "esm" | "iife";
  external: string[];
  minify: boolean;
  loaderName: string;
}): Promise<string> {
  const result = await esbuild({
    stdin: {
      contents: options.stdin,
      resolveDir: options.resolveDir,
      sourcefile: options.loaderName,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: options.format,
    platform: options.platform,
    target: "es2022",
    jsx: "automatic",
    minify: options.minify,
    legalComments: "none",
    external: options.external,
    alias: alias(),
    nodePaths: bundlerNodePaths(),
    conditions: ["import", "module", "browser", "default"],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) throw new Error("The bundler produced no output");
  return file.text;
}

function page(title: string, script: string): string {
  // Nothing is fetched: the CSP on the artifact origin blocks every external
  // request, so React, the kit, and the app are all in this one <script>.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title.replaceAll("<", "&lt;")}</title>`,
    // The root gets a definite height so the kit's own root (min-height: 100%)
    // fills the page; without it an Applet ends where its content ends.
    "<style>html,body,#applet-root{margin:0;height:100%;background:var(--frockbot-surface,#ffffff)}</style>",
    "</head>",
    "<body>",
    '<div id="applet-root"></div>',
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** Ask the built module what it declares, by running it. */
export async function readDescription(
  serverCode: string,
  appletId: string,
): Promise<AppletDescriptionV1> {
  const runtime = await startAppletRuntime({
    serverCode,
    appletId,
    token: randomUUID(),
  });
  try {
    // `health()` first: it is what the kernel calls, so a server that cannot
    // mount fails here the way it would fail a publish.
    const health = await runtime.fetch("/health");
    if (!health.ok) {
      throw new Error(`The Applet failed to mount: ${await health.text()}`);
    }
    const response = await runtime.fetch("/describe");
    if (!response.ok) {
      throw new Error(
        `The Applet could not describe its tools: ${await response.text()}`,
      );
    }
    return (await response.json()) as AppletDescriptionV1;
  } finally {
    await runtime.dispose();
  }
}

export async function buildApplet(
  directory: string,
): Promise<AppletBuildResult> {
  const descriptor = await readDescriptor(directory);

  const serverCode = await bundle({
    // `Applet` is the export name the kernel's facet mount looks up; the author
    // writes an ordinary default export and never learns that name.
    stdin:
      'import AppletClass from "./server";\nexport { AppletClass as Applet };\n',
    resolveDir: directory,
    platform: "neutral",
    format: "esm",
    external: ["cloudflare:workers"],
    minify: false,
    loaderName: "applet-server-entry.ts",
  });

  const uiScript = await bundle({
    stdin: 'import "./ui";\n',
    resolveDir: directory,
    platform: "browser",
    format: "iife",
    external: [],
    minify: true,
    loaderName: "applet-ui-entry.tsx",
  });
  const html = page(descriptor.displayName, uiScript);

  const description = await readDescription(serverCode, descriptor.id);
  const manifest: AppletBuildManifestV1 = {
    contract: 1,
    tools: description.tools,
    hashes: { server: sha256(serverCode), ui: sha256(html) },
  };

  const dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  const serverPath = join(dist, "server.js");
  const uiPath = join(dist, "ui.html");
  const manifestPath = join(dist, "manifest.json");
  await writeFile(serverPath, serverCode, "utf8");
  await writeFile(uiPath, html, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { directory, serverPath, uiPath, manifestPath, manifest };
}

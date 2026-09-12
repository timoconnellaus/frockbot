/**
 * Three immutable artifacts from two source files.
 *
 * `server.js`      one ESM file whose only import is `cloudflare:workers`,
 *                  exporting `Applet`, which is the name the kernel mounts.
 * `ui.html`        one self-contained page: React, TanStack DB, the kit, and
 *                  the app inlined. No external URL, because the artifact
 *                  origin serves it into a sandbox with no network of its own.
 * `manifest.json`  `{ contract, tools, hashes }`.
 *
 * The tool declarations come from mounting the built server in Miniflare and
 * calling `health()`, not from reading the source. Static analysis would be a
 * second implementation of `this.tool(...)` that could disagree with the one
 * the kernel actually asks — and the kernel admits a generation by comparing
 * the manifest to the facet's own `health()`, so any disagreement is a failed
 * publish. Running the code is the only derivation that cannot drift.
 *
 * Nothing here touches a filesystem beyond the source it is given: the build
 * service returns these three strings over its contract, and the app stores
 * them under their content hashes.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import { build as esbuild, type Metafile } from "esbuild";

import type { AppletDescriptionV1 } from "../server/applet.js";
import { readDescriptor, type AppletBuildManifestV1 } from "./manifest.js";
import { bundlerNodePaths, SDK_ENTRIES, SDK_ROOT } from "./paths.js";
import { withOneMoreBoot } from "./boot.js";
import { startAppletRuntime } from "./runtime.js";

export interface AppletArtifactsV1 {
  manifest: AppletBuildManifestV1;
  server: string;
  ui: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** esbuild reports real paths; a temp directory is often a symlink to one. */
function real(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Where a bundled module came from, said the same way everywhere.
 *
 * An Applet's directory, the SDK's directory and the working directory are all
 * different on an author's machine and in the build container — and esbuild
 * writes each module's path into the unminified output as a comment. Left
 * alone, identical source bundled in two places produces two different files
 * and therefore two different content hashes, which would give R2 a new object
 * on every publish of unchanged code.
 */
function moduleLabel(absolute: string, appletRoot: string): string {
  for (const [root, prefix] of [
    [appletRoot, ""],
    [real(SDK_ROOT), "applet-sdk/"],
  ] as const) {
    const inside = relative(root, absolute);
    if (!inside.startsWith("..") && inside !== "") return prefix + inside;
  }
  const dependency = absolute.lastIndexOf("node_modules/");
  return dependency === -1 ? absolute : absolute.slice(dependency);
}

/**
 * Rewrites esbuild's module comments to those stable labels.
 *
 * The paths come from the metafile rather than from a pattern over the output,
 * so only lines esbuild actually wrote are touched and a comment in someone's
 * own source is left alone.
 */
function stableModulePaths(
  text: string,
  metafile: Metafile,
  appletRoot: string,
): string {
  const root = real(appletRoot);
  const labels = new Map(
    Object.keys(metafile.inputs).map((input) => [
      input,
      moduleLabel(real(input), root),
    ]),
  );
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("// ")) return line;
      const label = labels.get(line.slice(3));
      return label === undefined ? line : `// ${label}`;
    })
    .join("\n");
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
    alias: { ...SDK_ENTRIES },
    nodePaths: bundlerNodePaths(),
    conditions: ["import", "module", "browser", "default"],
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) throw new Error("The bundler produced no output");
  return stableModulePaths(file.text, result.metafile, options.resolveDir);
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

/**
 * Ask the built module what it declares, by running it. A boot that never
 * reports ready is tried once more (`boot.ts`) before the build gives up.
 */
export function readDescription(
  serverCode: string,
  appletId: string,
): Promise<AppletDescriptionV1> {
  return withOneMoreBoot(() => describeInRuntime(serverCode, appletId));
}

async function describeInRuntime(
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

/** The two bundles, in the order that lets a bundle failure precede a boot. */
export async function bundleAppletArtifacts(
  directory: string,
): Promise<{ descriptorId: string; server: string; ui: string }> {
  const descriptor = await readDescriptor(directory);
  const server = await bundle({
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
  return {
    descriptorId: descriptor.id,
    server,
    ui: page(descriptor.displayName, uiScript),
  };
}

/** The manifest for artifacts whose declarations have been read. */
export function appletManifest(
  tools: AppletDescriptionV1["tools"],
  artifacts: { server: string; ui: string },
): AppletBuildManifestV1 {
  return {
    contract: 1,
    tools,
    hashes: { server: sha256(artifacts.server), ui: sha256(artifacts.ui) },
  };
}

/** Bundle, boot, describe. The whole artifact derivation, with no output. */
export async function buildAppletArtifacts(
  directory: string,
): Promise<AppletArtifactsV1> {
  const { descriptorId, server, ui } = await bundleAppletArtifacts(directory);
  const description = await readDescription(server, descriptorId);
  return {
    manifest: appletManifest(description.tools, { server, ui }),
    server,
    ui,
  };
}

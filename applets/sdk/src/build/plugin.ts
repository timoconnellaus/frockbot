/**
 * The Plugin build (ADR 0026): four named stages over one directory, sharing
 * the Applet build's type checker, bundler and Miniflare boot.
 *
 *  1. `descriptor` — `plugin.json` parses and names the Plugin the caller
 *     asked for. Nothing more is decided here: the app Worker holds the full
 *     descriptor decoder and compares the manifest with it before it stores
 *     anything.
 *  2. `typecheck` — `plugin.ts` and its siblings against
 *     `@frockbot/applet-sdk/plugin`, strict.
 *  3. `bundle` — one ESM module. No import survives: the module is loaded by
 *     a Worker with no bindings but the kernel's loopback, so a specifier the
 *     bundler could not inline is a build failure, not a mount surprise.
 *  4. `describe` — the bundle runs in Miniflare, with no outbound network,
 *     and reports what it exports. That is the manifest: the truth about the
 *     module, read by running it, exactly as the kernel's index will.
 *
 * `check` stops after the type checker. There is no lint stage: a Plugin's
 * network access is a grant the descriptor declares and the kernel enforces
 * at the egress, not a rule a linter could state.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";

import { build as esbuild } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import ts from "typescript";

import type { AppletDiagnostic } from "../lint/index.js";
import { bootedWithin, withOneMoreBoot } from "./boot.js";
import { APPLET_COMPATIBILITY_DATE } from "./runtime.js";
import { SDK_PLUGIN_TYPES } from "./paths.js";

export type PluginBuildStage =
  "descriptor" | "typecheck" | "bundle" | "describe";

/** The Plugin's `plugin.json`, as far as the build reads it. */
export interface PluginBuildDescriptorV1 {
  id: string;
}

/** What the built module exports, read by running it. */
export interface PluginDescriptionV1 {
  tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  hooks: string[];
  services: string[];
  triggers: string[];
}

export interface PluginBuildManifestV1 extends PluginDescriptionV1 {
  contract: 1;
  hashes: { module: string };
}

export type PluginBuildOutcome =
  | { status: "checked" }
  | { status: "built"; manifest: PluginBuildManifestV1; module: string }
  | {
      status: "failed";
      stage: PluginBuildStage;
      diagnostics: AppletDiagnostic[];
    };

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TOOLS = 64;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  // ES2022 for the language; the DOM lib for `fetch`, `Request` and
  // `Response`, which the Workers runtime provides under the same names.
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: [],
};

function thrown(error: unknown, file = "plugin.json"): AppletDiagnostic[] {
  return [
    {
      file,
      line: 1,
      column: 1,
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    },
  ];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function readPluginDescriptor(
  directory: string,
): Promise<PluginBuildDescriptorV1> {
  let text: string;
  try {
    text = await readFile(join(directory, "plugin.json"), "utf8");
  } catch {
    throw new Error(`No plugin.json in the Plugin's source`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `plugin.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plugin.json must be an object");
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || !PLUGIN_ID.test(id)) {
    throw new Error('plugin.json "id" must match /^[a-z][a-z0-9-]{0,63}$/');
  }
  return { id };
}

async function pluginSources(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(path);
      }
    }
  };
  await walk(directory);
  return found;
}

/** Type-check the Plugin against the SDK's Plugin declarations. */
export async function typeCheckPlugin(
  directory: string,
): Promise<AppletDiagnostic[]> {
  const root = resolve(directory);
  const files = await pluginSources(root);
  if (!files.some((file) => relative(root, file) === "plugin.ts")) {
    return [
      {
        file: "plugin.ts",
        line: 1,
        column: 1,
        message: "No plugin.ts found; a Plugin's module is plugin.ts.",
        severity: "error",
      },
    ];
  }
  const program = ts.createProgram(files, {
    ...COMPILER_OPTIONS,
    paths: { "@frockbot/applet-sdk/plugin": [SDK_PLUGIN_TYPES] },
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
          file: "plugin.ts",
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

/**
 * One ESM module, every import inlined. `@frockbot/applet-sdk/plugin` is
 * types only, so a value import of it is the one specifier that can never
 * resolve — the message says so rather than reporting a missing package.
 */
export async function bundlePlugin(directory: string): Promise<string> {
  const result = await esbuild({
    entryPoints: [join(directory, "plugin.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: false,
    legalComments: "none",
    external: [],
    plugins: [
      {
        name: "plugin-sdk-is-types-only",
        setup(build) {
          build.onResolve(
            { filter: /^@frockbot\/applet-sdk\/plugin$/ },
            () => ({
              errors: [
                {
                  text: '"@frockbot/applet-sdk/plugin" is types only; import it with `import type`.',
                },
              ],
            }),
          );
        },
      },
    ],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) throw new Error("The bundler produced no output");
  // The bundle's module comments carry the temp directory; keep the artifact a
  // function of the source alone, as the Applet build does.
  return file.text
    .split("\n")
    .map((line) =>
      line.startsWith("// ") && line.includes(directory)
        ? `// ${relative(directory, line.slice(3))}`
        : line,
    )
    .join("\n");
}

/**
 * The describing Worker. It imports the built module and answers `/describe`
 * with what the module exports, in the shape the manifest carries. Anything
 * the module does at import time runs here, inside workerd, with no outbound
 * network and no bindings — never in this process.
 */
const DESCRIBE_WORKER = `
import * as plugin from "./plugin.js";

var TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function names(value, label) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('"' + label + '" must be an object');
  }
  return Object.keys(value).map(function (name) {
    if (typeof value[name] !== "function" && label !== "services") {
      throw new Error('"' + label + '"."' + name + '" must be a function');
    }
    return name;
  });
}

function describe() {
  if (!Array.isArray(plugin.tools)) {
    throw new Error('the module must export a "tools" array');
  }
  if (typeof plugin.execute !== "function") {
    throw new Error('the module must export an "execute" function');
  }
  var tools = plugin.tools.map(function (tool) {
    if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
      throw new Error("a tool has an invalid name");
    }
    if (typeof tool.description !== "string" || tool.description.length === 0) {
      throw new Error('tool "' + tool.name + '" needs a description');
    }
    var schema =
      tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : { type: "object" };
    return { name: tool.name, description: tool.description, inputSchema: schema };
  });
  return {
    tools: tools,
    hooks: names(plugin.hooks, "hooks"),
    services: names(plugin.services, "services"),
    triggers: names(plugin.triggers, "triggers"),
  };
}

export default {
  async fetch(request) {
    try {
      return Response.json({ ok: true, description: describe() });
    } catch (error) {
      return Response.json(
        { ok: false, error: String((error && error.message) || error) },
        { status: 500 },
      );
    }
  },
};
`;

/**
 * Ask the built module what it exports, by running it. The boot is bounded
 * and tried once more (`boot.ts`), so a build answers rather than hanging on
 * a runtime that never came up.
 */
export function describePlugin(
  moduleCode: string,
): Promise<PluginDescriptionV1> {
  return withOneMoreBoot(() => describeInWorkerd(moduleCode));
}

async function describeInWorkerd(
  moduleCode: string,
): Promise<PluginDescriptionV1> {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        { type: "ESModule", path: "/index.mjs", contents: DESCRIBE_WORKER },
        { type: "ESModule", path: "/plugin.js", contents: moduleCode },
      ],
      modulesRoot: "/",
      compatibilityDate: APPLET_COMPATIBILITY_DATE,
      // Import-time code runs with no way out: every fetch is answered here.
      outboundService: async () =>
        new Response("the build describes a Plugin without a network", {
          status: 403,
        }),
      host: "127.0.0.1",
      port: 0,
    }),
  );
  let started = false;
  try {
    const url = await bootedWithin(miniflare.ready);
    started = true;
    const response = (await miniflare.dispatchFetch(
      new URL(`/describe?${randomUUID()}`, url).toString(),
    )) as unknown as Response;
    const body = (await response.json()) as
      | { ok: true; description: PluginDescriptionV1 }
      | { ok: false; error: string };
    if (!body.ok) {
      throw new Error(`The Plugin could not describe itself: ${body.error}`);
    }
    return validateDescription(body.description);
  } finally {
    // A runtime that never started is let go of rather than waited on.
    if (started) await miniflare.dispose();
    else void miniflare.dispose().catch(() => {});
  }
}

function validateDescription(input: PluginDescriptionV1): PluginDescriptionV1 {
  if (!Array.isArray(input.tools) || input.tools.length > MAX_TOOLS) {
    throw new Error(`The Plugin declares more than ${MAX_TOOLS} tools`);
  }
  const seen = new Set<string>();
  for (const tool of input.tools) {
    if (seen.has(tool.name)) {
      throw new Error(`The Plugin declares "${tool.name}" twice`);
    }
    seen.add(tool.name);
  }
  return {
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as Record<
        string,
        unknown
      >,
    })),
    hooks: [...input.hooks],
    services: [...input.services],
    triggers: [...input.triggers],
  };
}

export interface PluginBuildPipelineOptions {
  /** `check` stops after the type checker; `build` goes on to the module. */
  mode: "check" | "build";
  /** The id the caller asked for; `plugin.json` must agree. */
  id?: string;
}

export async function runPluginBuildV1(
  directory: string,
  options: PluginBuildPipelineOptions,
): Promise<PluginBuildOutcome> {
  let descriptor: PluginBuildDescriptorV1;
  try {
    descriptor = await readPluginDescriptor(directory);
    if (options.id !== undefined && descriptor.id !== options.id) {
      throw new Error(
        `plugin.json names "${descriptor.id}" but this build is for "${options.id}"`,
      );
    }
  } catch (error) {
    return {
      status: "failed",
      stage: "descriptor",
      diagnostics: thrown(error),
    };
  }

  const types = await typeCheckPlugin(directory);
  if (types.some((diagnostic) => diagnostic.severity === "error")) {
    return { status: "failed", stage: "typecheck", diagnostics: types };
  }
  if (options.mode === "check") return { status: "checked" };

  let moduleCode: string;
  try {
    moduleCode = await bundlePlugin(directory);
  } catch (error) {
    return {
      status: "failed",
      stage: "bundle",
      diagnostics: thrown(error, "plugin.ts"),
    };
  }

  let description: PluginDescriptionV1;
  try {
    description = await describePlugin(moduleCode);
  } catch (error) {
    return {
      status: "failed",
      stage: "describe",
      diagnostics: thrown(error, "plugin.ts"),
    };
  }
  return {
    status: "built",
    manifest: {
      contract: 1,
      ...description,
      hashes: { module: sha256(moduleCode) },
    },
    module: moduleCode,
  };
}

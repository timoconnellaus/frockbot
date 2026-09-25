/**
 * One Plugin build, from a decoded request to a decoded response.
 *
 * The posted files are written into a fresh temporary directory and
 * `runPluginBuildV1` runs against it exactly as it runs against any other
 * directory — same type checker, same esbuild pass, same Miniflare boot — so
 * the module a publish stores is byte-identical to the one the same source
 * builds to anywhere else.
 *
 * `effectId` is carried, not journalled. A build is pure, so a retry under the
 * same key re-derives the same bytes and the caller's own record is the only
 * one that needs to exist.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runPluginBuildV1 } from "@frockbot/applet-sdk/build/plugin";
import {
  PLUGIN_BUILD_LIMITS,
  decodePluginBuildManifestV1,
  type PluginBuildManifestV1,
  type PluginBuildRequestV1,
  type PluginBuildResponseV1,
} from "@frockbot/applets/build-contract";

async function materialize(request: PluginBuildRequestV1): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "plugin-build-"));
  for (const file of request.files) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text, "utf8");
  }
  return directory;
}

/**
 * The manifest came out of the built module run in Miniflare, so it is
 * decoded here before it is believed, and both artifacts are held to the
 * ceilings a publish stores.
 */
async function buildPlugin(
  directory: string,
  request: PluginBuildRequestV1,
): Promise<PluginBuildResponseV1> {
  const outcome = await runPluginBuildV1(directory, {
    mode: request.mode,
    id: request.id,
  });
  if (outcome.status === "failed") {
    return {
      status: "failed",
      stage: outcome.stage,
      diagnostics: outcome.diagnostics.slice(
        0,
        PLUGIN_BUILD_LIMITS.diagnostics,
      ),
    };
  }
  if (outcome.status === "checked") return { status: "built" };
  let manifest: PluginBuildManifestV1;
  try {
    manifest = decodePluginBuildManifestV1(
      JSON.parse(JSON.stringify(outcome.manifest)),
    );
  } catch (error) {
    return {
      status: "failed",
      stage: "describe",
      diagnostics: [
        {
          file: "plugin.ts",
          line: 1,
          column: 1,
          message: `The Plugin declared exports this contract refuses: ${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
        },
      ],
    };
  }
  const checks: [string, number, number][] = [
    ["module.js", outcome.module.length, PLUGIN_BUILD_LIMITS.moduleBytes],
    ...outcome.modules.map((module): [string, number, number] => [
      `modules/${module.id}.js`,
      module.code.length,
      PLUGIN_BUILD_LIMITS.moduleBytes,
    ]),
    [
      "manifest.json",
      JSON.stringify(manifest).length,
      PLUGIN_BUILD_LIMITS.manifestBytes,
    ],
  ];
  const diagnostics = checks
    .filter(([, size, limit]) => size > limit)
    .map(([name, size, limit]) => ({
      file: "plugin.ts",
      line: 1,
      column: 1,
      message: `dist/${name} is ${size} bytes, over the ${limit}-byte ceiling a publish will store.`,
      severity: "error" as const,
    }));
  if (diagnostics.length > 0) {
    return { status: "failed", stage: "bundle", diagnostics };
  }
  return {
    status: "built",
    manifest,
    module: outcome.module,
    modules: outcome.modules,
  };
}

export async function buildPluginRequestV1(
  request: PluginBuildRequestV1,
): Promise<PluginBuildResponseV1> {
  const directory = await materialize(request);
  try {
    return await buildPlugin(directory, request);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

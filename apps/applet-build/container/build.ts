/**
 * One build, from a decoded request to a decoded response.
 *
 * The posted files are written into a fresh temporary directory and the SDK's
 * pipeline runs against it exactly as it runs against an author's own
 * directory — same type checker, same rules, same two esbuild passes, same
 * Miniflare boot. That is the whole point of the service: the artifact a
 * publish stores is byte-identical to the one `applet build` writes.
 *
 * `effectId` is carried, not journalled. A build is pure, so a retry under the
 * same key re-derives the same bytes and the caller's own record is the only
 * one that needs to exist.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runAppletBuildV1 } from "@frockbot/applet-sdk/build";
import { runPluginBuildV1 } from "@frockbot/applet-sdk/build/plugin";
import {
  APPLET_BUILD_LIMITS,
  decodeAppletBuildManifestV1,
  decodePluginBuildManifestV1,
  type AppletBuildDiagnosticV1,
  type AppletBuildManifestV1,
  type AppletBuildRequestV1,
  type AppletBuildResponseV1,
  type PluginBuildManifestV1,
} from "@frockbot/applets/build-contract";

async function materialize(request: AppletBuildRequestV1): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "applet-build-"));
  for (const file of request.files) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text, "utf8");
  }
  return directory;
}

/**
 * The artifact ceilings, as diagnostics.
 *
 * They are enforced here rather than by the caller so an oversize Applet is
 * told what is oversize while the build is still in hand, instead of being
 * refused after the bytes have crossed the wire.
 */
function oversize(artifacts: {
  manifest: AppletBuildManifestV1;
  server: string;
  ui: string;
}): AppletBuildDiagnosticV1[] {
  const manifestBytes = `${JSON.stringify(artifacts.manifest, null, 2)}\n`
    .length;
  const checks: [string, number, number][] = [
    ["server.js", artifacts.server.length, APPLET_BUILD_LIMITS.serverBytes],
    ["ui.html", artifacts.ui.length, APPLET_BUILD_LIMITS.uiBytes],
    ["manifest.json", manifestBytes, APPLET_BUILD_LIMITS.manifestBytes],
  ];
  return checks
    .filter(([, size, limit]) => size > limit)
    .map(([name, size, limit]) => ({
      file: "applet.json",
      line: 1,
      column: 1,
      message: `dist/${name} is ${size} bytes, over the ${limit}-byte ceiling a publish will store.`,
      severity: "error" as const,
    }));
}

/**
 * A Plugin build: the same seam, a different pipeline. The manifest came out
 * of the built module run in Miniflare, so it is decoded here before it is
 * believed, and both artifacts are held to the ceilings a publish stores.
 */
async function buildPlugin(
  directory: string,
  request: AppletBuildRequestV1,
): Promise<AppletBuildResponseV1> {
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
        APPLET_BUILD_LIMITS.diagnostics,
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
    ["module.js", outcome.module.length, APPLET_BUILD_LIMITS.moduleBytes],
    [
      "manifest.json",
      JSON.stringify(manifest).length,
      APPLET_BUILD_LIMITS.manifestBytes,
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
  return { status: "built", manifest, module: outcome.module };
}

export async function buildAppletRequestV1(
  request: AppletBuildRequestV1,
): Promise<AppletBuildResponseV1> {
  const directory = await materialize(request);
  try {
    if (request.kind === "plugin") return await buildPlugin(directory, request);
    const outcome = await runAppletBuildV1(directory, { mode: request.mode });
    if (outcome.status === "failed") {
      return {
        status: "failed",
        stage: outcome.stage,
        diagnostics: outcome.diagnostics.slice(
          0,
          APPLET_BUILD_LIMITS.diagnostics,
        ),
      };
    }
    if (outcome.status === "checked") return { status: "built" };

    // The declarations came out of the Applet's own code, run in Miniflare.
    // That is inbound value from untrusted source, so it is decoded at this
    // seam rather than trusted because the SDK produced the object.
    let manifest: AppletBuildManifestV1;
    try {
      manifest = decodeAppletBuildManifestV1(
        JSON.parse(JSON.stringify(outcome.manifest)),
      );
    } catch (error) {
      return {
        status: "failed",
        stage: "describe",
        diagnostics: [
          {
            file: "applet.json",
            line: 1,
            column: 1,
            message: `The Applet declared tools this contract refuses: ${error instanceof Error ? error.message : String(error)}`,
            severity: "error",
          },
        ],
      };
    }

    const artifacts = { manifest, server: outcome.server, ui: outcome.ui };
    const diagnostics = oversize(artifacts);
    if (diagnostics.length > 0) {
      return { status: "failed", stage: "bundle", diagnostics };
    }
    return { status: "built", ...artifacts };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

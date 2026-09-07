/**
 * `applet build` — the artifacts, on disk.
 *
 * The derivation lives in `../build/artifacts.ts`, which the cloud build
 * service runs too. This command is the local face of it: it writes
 * `dist/{server.js,ui.html,manifest.json}` and reports where they went.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildAppletArtifacts } from "../build/artifacts.js";
import type { AppletBuildManifestV1 } from "../build/manifest.js";

export interface AppletBuildResult {
  directory: string;
  serverPath: string;
  uiPath: string;
  manifestPath: string;
  manifest: AppletBuildManifestV1;
}

export async function buildApplet(
  directory: string,
): Promise<AppletBuildResult> {
  const { manifest, server, ui } = await buildAppletArtifacts(directory);

  const dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  const serverPath = join(dist, "server.js");
  const uiPath = join(dist, "ui.html");
  const manifestPath = join(dist, "manifest.json");
  await writeFile(serverPath, server, "utf8");
  await writeFile(uiPath, ui, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { directory, serverPath, uiPath, manifestPath, manifest };
}

/** `applet.json`: the three facts the SDK needs before it reads any code. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { APPLET_CONTRACT_VERSION } from "../protocol/index.js";
import type { AppletToolDeclarationV1 } from "../server/applet.js";

export interface AppletDescriptorV1 {
  /** `/^[a-z][a-z0-9-]{0,31}$/`; the directory name `applet new` creates. */
  id: string;
  displayName: string;
  contract: 1;
}

export interface AppletBuildManifestV1 {
  contract: 1;
  tools: AppletToolDeclarationV1[];
  hashes: { server: string; ui: string };
}

export function decodeDescriptor(input: unknown): AppletDescriptorV1 {
  if (!input || typeof input !== "object")
    throw new Error("applet.json must be an object");
  const value = input as Record<string, unknown>;
  const id = value.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    throw new Error('applet.json "id" must match /^[a-z][a-z0-9-]{0,31}$/');
  }
  if (
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    value.displayName.length > 64
  ) {
    throw new Error('applet.json "displayName" must be 1-64 characters');
  }
  if (value.contract !== APPLET_CONTRACT_VERSION) {
    throw new Error(
      `applet.json "contract" must be ${APPLET_CONTRACT_VERSION}`,
    );
  }
  return { id, displayName: value.displayName, contract: 1 };
}

export async function readDescriptor(
  directory: string,
): Promise<AppletDescriptorV1> {
  const path = join(directory, "applet.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No applet.json in ${directory}; run \`applet new <name>\` first`,
    );
  }
  return decodeDescriptor(JSON.parse(text));
}

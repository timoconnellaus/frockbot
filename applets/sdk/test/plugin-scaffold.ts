/**
 * The Plugin template on disk, filled in, as a directory a build can run
 * against — the Plugin counterpart of `scaffold.ts`.
 */

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_ROOT = fileURLToPath(
  new URL("../plugin/template/", import.meta.url),
);

export interface ScaffoldedPlugin {
  id: string;
  directory: string;
  files: { path: string; text: string }[];
}

/** A temporary directory holding the filled-in Plugin template. */
export async function scaffoldPluginTemplateV1(
  options: { id?: string; displayName?: string; prefix?: string } = {},
): Promise<ScaffoldedPlugin> {
  const id = options.id ?? "notes";
  const displayName = options.displayName ?? "Notes";
  const directory = await mkdtemp(
    join(tmpdir(), options.prefix ?? "plugin-template-"),
  );
  const files: { path: string; text: string }[] = [];
  for (const entry of await readdir(TEMPLATE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = (await readFile(join(TEMPLATE_ROOT, entry.name), "utf8"))
      .replaceAll("__PLUGIN_ID__", id)
      .replaceAll("__PLUGIN_NAME__", displayName);
    await writeFile(join(directory, entry.name), text, "utf8");
    files.push({ path: entry.name, text });
  }
  return { id, directory, files };
}

/**
 * The template on disk, filled in, as a directory a build can run against.
 *
 * `applet_create` writes the same files through the Workspace from
 * `applets/template.generated.ts`, which `scripts/build-applets-assets.ts`
 * generates from this directory. A test that scaffolds from the source of that
 * generator builds exactly what a new Applet starts as.
 */

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_ROOT = fileURLToPath(new URL("../template/", import.meta.url));

export interface ScaffoldedApplet {
  id: string;
  directory: string;
  files: { path: string; text: string }[];
}

/** A temporary directory holding the filled-in template. */
export async function scaffoldTemplateV1(
  options: { id?: string; displayName?: string; prefix?: string } = {},
): Promise<ScaffoldedApplet> {
  const id = options.id ?? "weekly-todos";
  const displayName = options.displayName ?? "Weekly Todos";
  const directory = await mkdtemp(
    join(tmpdir(), options.prefix ?? "applet-template-"),
  );
  const files: { path: string; text: string }[] = [];
  for (const entry of await readdir(TEMPLATE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = (await readFile(join(TEMPLATE_ROOT, entry.name), "utf8"))
      .replaceAll("__APPLET_ID__", id)
      .replaceAll("__APPLET_NAME__", displayName);
    await writeFile(join(directory, entry.name), text, "utf8");
    files.push({ path: entry.name, text });
  }
  return { id, directory, files };
}

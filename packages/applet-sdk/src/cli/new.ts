/** `applet new` — the template, with the name filled in. */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SDK_ROOT } from "./paths.js";

const TEMPLATE_ROOT = join(SDK_ROOT, "template");

/** `Weekly Plan` -> `weekly-plan`. */
export function appletIdFrom(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    throw new Error(`"${name}" does not yield a usable Applet id`);
  }
  return id;
}

function fill(text: string, id: string, displayName: string): string {
  return text
    .replaceAll("__APPLET_ID__", id)
    .replaceAll("__APPLET_NAME__", displayName);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface NewAppletResult {
  id: string;
  displayName: string;
  directory: string;
  files: string[];
}

export async function newApplet(options: {
  name: string;
  /** Where the Applet directory is created; the durable root in production. */
  parent: string;
}): Promise<NewAppletResult> {
  const id = appletIdFrom(options.name);
  const directory = join(options.parent, id);
  if (await exists(directory)) {
    throw new Error(`${directory} already exists`);
  }
  const files: string[] = [];
  const copy = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        await copy(source, target);
        continue;
      }
      const text = await readFile(source, "utf8");
      await writeFile(target, fill(text, id, options.name), "utf8");
      files.push(entry.name);
    }
  };
  await copy(TEMPLATE_ROOT, directory);
  return { id, displayName: options.name, directory, files };
}

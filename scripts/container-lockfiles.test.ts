/// <reference types="bun" />
/*
 * The containers install with `npm ci` from their own `package-lock.json`,
 * which `bun install` and Dependabot's bun ecosystem never touch. A manifest
 * bump without a regenerated lock passes every fast check and only fails
 * when the browser suite builds the image after the merge, because `npm ci`
 * refuses a lock whose root no longer matches the manifest.
 *
 * Regenerate with `npm install --package-lock-only` in the container
 * directory.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONTAINERS = [
  "apps/applet-build/container",
  "apps/computer-host/container",
];

type Manifest = { dependencies?: Record<string, string> };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;
}

describe("container npm lockfiles", () => {
  for (const container of CONTAINERS) {
    test(`${container} lock root matches its package.json`, () => {
      const manifest = readJson<Manifest>(`${container}/package.json`);
      const lock = readJson<{ packages: Record<string, Manifest> }>(
        `${container}/package-lock.json`,
      );

      expect(lock.packages[""]?.dependencies ?? {}).toEqual(
        manifest.dependencies ?? {},
      );
    });
  }
});

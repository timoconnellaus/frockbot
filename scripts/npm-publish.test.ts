import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLISHED_WORKSPACES_V1,
  publishedManifestV1,
  readManifestV1,
} from "./npm-publish.ts";

const root = join(import.meta.dirname, "..");

/** Every workspace name, to the directory it lives in. */
function workspaceDirectories(): Map<string, string> {
  const directories = new Map<string, string>();
  const patterns = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces: string[];
    }
  ).workspaces;
  for (const pattern of patterns) {
    for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({
      cwd: root,
    })) {
      const directory = manifest.slice(0, -"/package.json".length);
      const name = readManifestV1(root, directory).name;
      if (name) directories.set(name, directory);
    }
  }
  return directories;
}

describe("the published workspaces", () => {
  test("each says so in its own manifest", () => {
    for (const directory of PUBLISHED_WORKSPACES_V1) {
      expect(readManifestV1(root, directory).frockbot?.npm).toBe(true);
    }
  });

  test("include every workspace a published one depends on", () => {
    // A published package naming an unpublished `@frockbot/*` one installs
    // nowhere: the version it pins does not exist on npm.
    const directories = workspaceDirectories();
    const listed = new Set<string>(PUBLISHED_WORKSPACES_V1);
    for (const directory of PUBLISHED_WORKSPACES_V1) {
      const manifest = readManifestV1(root, directory);
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (!range.startsWith("workspace:")) continue;
        expect(listed.has(directories.get(name) ?? name)).toBe(true);
      }
    }
  });

  test("the Worker is one of them, as @frockbot/cloudflare", () => {
    expect(readManifestV1(root, "apps/cloudflare").name).toBe(
      "@frockbot/cloudflare",
    );
  });
});

describe("a published manifest", () => {
  test("takes the release version everywhere a workspace range was", () => {
    const published = publishedManifestV1(
      {
        name: "@frockbot/example",
        version: "0.0.1",
        private: true,
        dependencies: {
          "@frockbot/core": "workspace:*",
          "@frockbot/app": "workspace:^",
          ai: "^7.0.0",
        },
        devDependencies: { "@frockbot/providers": "workspace:~" },
      },
      "1.2.3",
    );
    expect(published).toMatchObject({
      version: "1.2.3",
      private: false,
      dependencies: {
        "@frockbot/core": "1.2.3",
        "@frockbot/app": "^1.2.3",
        ai: "^7.0.0",
      },
      devDependencies: { "@frockbot/providers": "~1.2.3" },
    });
  });
});

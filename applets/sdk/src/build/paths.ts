/**
 * Where the SDK is on disk, so the Plugin build can resolve
 * `@frockbot/applet-sdk/plugin` to its declarations.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Found by walking up to this package's own `package.json`, not by counting
 * directories.
 *
 * The same module runs from two depths: `src/build/paths.ts` under Bun, and
 * the build service's own bundle, which is emitted into `dist/` for exactly
 * this reason. A fixed `../../` is right for one and silently wrong for the
 * other — it would resolve the Plugin declarations to a file that does not
 * exist and every Plugin import would fail to type-check with no explanation.
 */
function findSdkRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (manifest.name === "@frockbot/applet-sdk") return `${directory}/`;
    } catch {
      // Not this directory; keep walking.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    "the Plugin SDK cannot find its own package root; reinstall @frockbot/applet-sdk",
  );
}

/** The installed `@frockbot/applet-sdk` directory. */
export const SDK_ROOT = findSdkRoot();

/** The Plugin declarations (`@frockbot/applet-sdk/plugin`), types only. */
export const SDK_PLUGIN_TYPES = join(SDK_ROOT, "plugin/index.d.ts");

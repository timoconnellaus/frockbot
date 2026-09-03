/**
 * Where the SDK is on disk, and how an Applet's imports resolve to it.
 *
 * An Applet lives at a durable root with no `node_modules` of its own — it is
 * synchronised source, not an npm project — so every specifier it may write is
 * mapped here, once, and the same map feeds the type checker and the bundler.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The installed `@frockbot/applet-sdk` directory. */
export const SDK_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const SDK_ENTRIES = {
  "@frockbot/applet-sdk/server": join(SDK_ROOT, "src/server/index.ts"),
  "@frockbot/applet-sdk/client": join(SDK_ROOT, "src/client/index.ts"),
  "@frockbot/applet-sdk/kit": join(SDK_ROOT, "src/kit/index.tsx"),
  "@frockbot/applet-sdk/protocol": join(SDK_ROOT, "src/protocol/index.ts"),
} as const;

/** The ambient declaration of the one Cloudflare module the SDK names. */
export const SDK_WORKERS_TYPES = join(
  SDK_ROOT,
  "types/cloudflare-workers.d.ts",
);

function packageDirectory(specifier: string): string {
  return dirname(require.resolve(`${specifier}/package.json`));
}

/** Node module directories the bundler searches for React and TanStack DB. */
export function bundlerNodePaths(): string[] {
  const paths = new Set<string>([join(SDK_ROOT, "node_modules")]);
  for (const specifier of [
    "react",
    "react-dom",
    "@tanstack/db",
    "@tanstack/react-db",
  ]) {
    try {
      paths.add(join(packageDirectory(specifier), "..", ".."));
    } catch {
      // Resolved through the SDK's own node_modules instead.
    }
  }
  return [...paths];
}

/** `paths` for the type checker: the SDK's entries plus React's declarations. */
export function typeCheckerPaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const [specifier, file] of Object.entries(SDK_ENTRIES))
    paths[specifier] = [file];
  try {
    const types = packageDirectory("@types/react");
    paths.react = [join(types, "index.d.ts")];
    paths["react/jsx-runtime"] = [join(types, "jsx-runtime.d.ts")];
    paths["react/*"] = [join(types, "*")];
  } catch {
    // No React declarations available; `applet check` reports the import.
  }
  return paths;
}

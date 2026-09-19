import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Metafile } from "esbuild";

export interface StableModuleRoot {
  directory: string;
  prefix: string;
}

/** esbuild reports real paths; a temp directory is often a symlink to one. */
function real(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function portable(path: string): string {
  return path.split(sep).join("/").replaceAll("\\", "/");
}

function moduleLabel(absolute: string, roots: readonly StableModuleRoot[]) {
  for (const { directory, prefix } of roots) {
    const inside = relative(directory, absolute);
    const outside =
      inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    if (!outside && inside !== "") return prefix + portable(inside);
  }
  const path = portable(absolute);
  const dependency = path.lastIndexOf("node_modules/");
  return dependency === -1 ? path : path.slice(dependency);
}

/**
 * Rewrites esbuild's module comments to location-independent labels.
 *
 * The paths come from the metafile rather than from a pattern over the output,
 * so only lines esbuild actually wrote are touched and a comment in authored
 * source is left alone. Callers name any additional source roots that belong
 * to their artifact; dependencies under `node_modules` are stable by package
 * path automatically.
 */
export function stableModulePaths(
  text: string,
  metafile: Metafile,
  sourceRoot: string,
  additionalRoots: readonly StableModuleRoot[] = [],
): string {
  const roots = [
    { directory: real(sourceRoot), prefix: "" },
    ...additionalRoots.map(({ directory, prefix }) => ({
      directory: real(directory),
      prefix,
    })),
  ];
  const labels = new Map(
    Object.keys(metafile.inputs).map((input) => [
      input,
      moduleLabel(real(input), roots),
    ]),
  );
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("// ")) return line;
      const label = labels.get(line.slice(3));
      return label === undefined ? line : `// ${label}`;
    })
    .join("\n");
}

import type ts from "typescript";

/** The compiler namespace returned by TypeScript's CommonJS package. */
export type TypeScript = typeof ts;

let loaded: Promise<TypeScript> | undefined;

/**
 * Load TypeScript lazily, and as a browser-like host: TypeScript picks its
 * Node `sys` when `process.nextTick` exists, `process.browser` is falsy and
 * `require` exists — all true under Workers' `nodejs_compat`, where the Node
 * path then reads `__filename`, `os.platform()` and the file system at import
 * time and fails. The checker never uses `ts.sys` (its program runs over an
 * in-memory host), so it asks for no system at all.
 */
export function loadTypeScript(): Promise<TypeScript> {
  if (loaded) return loaded;

  const process = (globalThis as { process?: { browser?: unknown } }).process;
  const markBrowser = process !== undefined && process.browser === undefined;
  if (markBrowser) process.browser = true;

  loaded = import("typescript")
    .then((module) => module.default)
    .finally(() => {
      if (markBrowser) Reflect.deleteProperty(process, "browser");
    });
  return loaded;
}

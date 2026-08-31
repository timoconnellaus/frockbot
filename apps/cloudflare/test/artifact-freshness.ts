// A loud failure when the built user application is older than the code it
// bundles.
//
// `test:integration` runs `artifact:build` first, so the artifact it hands the
// suite is always the tree's. Running `vitest run --config
// vitest.integration.config.ts` by hand skips that step, and then every test
// exercises whatever `dist/artifacts/foundation-v1.mjs` was left over from the
// last build — the tests still pass, or fail, against bytes nobody wrote. That
// has already cost two debugging sessions, so the config asks this module for
// the bytes and this module refuses to hand over stale ones.
//
// What "the sources it bundles" means, exactly: `build-artifact.ts` emits an
// external source map beside the artifact, and that map's `sources` is the
// bundler's own list of every file that went in. Workspace files are checked
// against the artifact's own mtime; `node_modules` is not, because installing a
// dependency touches thousands of files that a build does not have to follow.
// The Vue client is bundled by a separate `vite build` and inlined as a string,
// so it never appears in that map: `src/client` is walked as well.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** How many stale files the message names before it stops listing. */
const NAMED_LIMIT = 5;

function newestMtime(paths: Iterable<string>): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const path of paths) {
    try {
      mtimes.set(path, statSync(path).mtimeMs);
    } catch {
      // A source the bundler saw and the tree no longer has is a file that was
      // deleted, which the next build will notice. It cannot be stale.
    }
  }
  return mtimes;
}

function* walk(directory: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function bundledSources(artifactPath: string): string[] {
  const artifactDirectory = dirname(artifactPath);
  let map: { sources?: unknown };
  try {
    map = JSON.parse(readFileSync(`${artifactPath}.map`, "utf8")) as {
      sources?: unknown;
    };
  } catch {
    // No map, no list. The client walk below still catches the common case,
    // and a missing map is not itself a reason to fail a test run.
    return [];
  }
  const sources = Array.isArray(map.sources) ? map.sources : [];
  return sources
    .filter((source): source is string => typeof source === "string")
    .map((source) => resolve(artifactDirectory, source))
    .filter((source) => !source.includes("node_modules"));
}

/**
 * The built user application, or an error naming what changed since it was
 * built.
 *
 * @param artifactPath `dist/artifacts/foundation-v1.mjs`.
 * @param clientRoot the Vue client's source directory, bundled separately.
 */
export function readBuiltArtifact(
  artifactPath: string,
  clientRoot: string,
): string {
  let builtAt: number;
  try {
    builtAt = statSync(artifactPath).mtimeMs;
  } catch (error) {
    throw new Error(
      `The user application artifact is missing: ${artifactPath}\n` +
        "Run `bun run --filter @frockbot/cloudflare artifact:build`, or use " +
        "`bun run --filter @frockbot/cloudflare test:integration`, which " +
        "builds it first.",
      { cause: error },
    );
  }

  const candidates = [...bundledSources(artifactPath), ...walk(clientRoot)];
  const stale = [...newestMtime(candidates)]
    .filter(([, mtime]) => mtime > builtAt)
    .sort(([, left], [, right]) => right - left)
    .map(([path]) => path);

  if (stale.length > 0) {
    const repositoryRoot = resolve(dirname(artifactPath), "../../../..");
    const named = stale
      .slice(0, NAMED_LIMIT)
      .map((path) => `  - ${relative(repositoryRoot, path)}`)
      .join("\n");
    const rest =
      stale.length > NAMED_LIMIT
        ? `\n  …and ${stale.length - NAMED_LIMIT} more`
        : "";
    throw new Error(
      `The user application artifact is stale: ${stale.length} source file(s) ` +
        `changed after ${new Date(builtAt).toISOString()}, when ` +
        "`dist/artifacts/foundation-v1.mjs` was built. The integration suite " +
        "runs the artifact, not the tree, so every test here would be " +
        "answering about the old bytes.\n" +
        `${named}${rest}\n` +
        "Run `bun run --filter @frockbot/cloudflare test:integration`, which " +
        "builds first, or `bun run --filter @frockbot/cloudflare " +
        "artifact:build` before `vitest run`.",
    );
  }

  return readFileSync(artifactPath, "utf8");
}

/**
 * The Flutter client, built for the browser and staged where the Worker's
 * static assets are uploaded from.
 *
 * `FROCKBOT_ORIGIN` is deliberately left undefined: the browser build talks to
 * the origin it was served from, which is what a deployment, a `wrangler dev`
 * on an arbitrary port and the e2e harness all need. CanvasKit is built local
 * (`--no-web-resources-cdn`) so the app origin's `script-src 'self'` stays
 * true and the engine is never fetched from gstatic.
 *
 * Everything is staged under `_flutter/<buildHash>/`, so every URL the
 * document names is content-addressed and can be served `immutable`. The
 * document itself is rendered by the application artifact, which reads the
 * same hash from `dist/flutter-web.json`.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const nativeRoot = resolve(root, "../native");
const flutterOut = resolve(nativeRoot, "build/web");
const assetsRoot = resolve(root, "dist/web");
const payloadPrefix = "_flutter";

/**
 * What the browser never asks for.
 *
 * The `.symbols` files are the engine's debug symbol maps — 7 MB of them, read
 * by a stack-trace symbolizer nobody runs here. The rest are the pieces of
 * Flutter's own page: this deployment renders its document from the
 * application artifact, so the template index, the PWA manifest and its icons,
 * and the service worker that `--pwa-strategy=none` leaves empty have no
 * reader.
 */
const OMITTED = new Set([
  ".last_build_id",
  "version.json",
  "index.html",
  "manifest.json",
  "flutter_service_worker.js",
  "favicon.png",
]);

async function emittedFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(flutterOut, join(entry.parentPath, entry.name)).replaceAll(
        "\\",
        "/",
      ),
    )
    .filter(
      (path) =>
        !path.endsWith(".symbols") &&
        !path.startsWith("icons/") &&
        !OMITTED.has(path),
    )
    .sort();
}

Bun.spawnSync({
  cmd: [
    "flutter",
    "build",
    "web",
    "--release",
    "--pwa-strategy=none",
    "--no-web-resources-cdn",
  ],
  cwd: nativeRoot,
  stdout: "inherit",
  stderr: "inherit",
});

const files = await emittedFiles(flutterOut);
if (
  !files.includes("flutter_bootstrap.js") ||
  !files.includes("main.dart.js")
) {
  throw new Error("Flutter web build did not emit an entry point");
}

const digest = createHash("sha256");
for (const path of files) {
  digest.update(path);
  digest.update(
    createHash("sha256")
      .update(await readFile(resolve(flutterOut, path)))
      .digest(),
  );
}
const buildHash = digest.digest("hex").slice(0, 32);

await rm(assetsRoot, { recursive: true, force: true });
const payload = resolve(assetsRoot, payloadPrefix, buildHash);
await mkdir(payload, { recursive: true });
for (const path of files) {
  await cp(resolve(flutterOut, path), resolve(payload, path), {
    force: true,
    // `recursive` creates the intermediate directories a nested asset needs.
    recursive: true,
  });
}

// Every URL under the prefix carries the build hash, so a browser may keep it
// for a year: a new build is a new path, not a new body at the same one.
await writeFile(
  resolve(assetsRoot, "_headers"),
  `/${payloadPrefix}/*\n  cache-control: public, max-age=31536000, immutable\n`,
);
await writeFile(
  resolve(root, "dist/flutter-web.json"),
  `${JSON.stringify({ schemaVersion: 1, buildHash, files }, null, 2)}\n`,
);

process.stdout.write(
  `Built the Flutter web client at /${payloadPrefix}/${buildHash}/ (${files.length} files)\n`,
);

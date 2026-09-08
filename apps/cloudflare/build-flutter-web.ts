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
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

const BUILD_FLAGS = [
  "--release",
  "--pwa-strategy=none",
  "--no-web-resources-cdn",
];

/**
 * The Dart sources, the assets, and the page template the build reads.
 *
 * `build/` and `.dart_tool/` are the build's own outputs, and the platform
 * directories belong to the phone builds; nothing under them reaches the web
 * bundle.
 */
const SOURCE_ROOTS = ["lib", "web", "assets", "vendor"];
const SOURCE_FILES = ["pubspec.yaml", "pubspec.lock"];

async function sourceFingerprint(): Promise<string> {
  const digest = createHash("sha256");
  // The flags and this script are part of what the output is: a change to
  // either produces a different bundle from the same Dart.
  digest.update(BUILD_FLAGS.join(" "));
  digest.update(await readFile(fileURLToPath(import.meta.url)));
  // The toolchain too — a Flutter upgrade rewrites the engine even though no
  // file in this repository moved.
  const version = Bun.spawnSync({
    cmd: ["flutter", "--version", "--machine"],
    cwd: nativeRoot,
  });
  digest.update(version.stdout);

  const paths: string[] = [];
  for (const directory of SOURCE_ROOTS) {
    const absolute = resolve(nativeRoot, directory);
    const there = await stat(absolute).catch(() => undefined);
    if (!there?.isDirectory()) continue;
    for (const entry of await readdir(absolute, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile()) continue;
      paths.push(join(entry.parentPath, entry.name));
    }
  }
  for (const file of SOURCE_FILES) paths.push(resolve(nativeRoot, file));
  paths.sort();
  for (const path of paths) {
    digest.update(relative(nativeRoot, path).replaceAll("\\", "/"));
    digest.update(await readFile(path).catch(() => Buffer.alloc(0)));
  }
  return digest.digest("hex");
}

/**
 * Whether the staged bundle was built from exactly these sources.
 *
 * `flutter build web --release` is not incremental — dart2js runs whole, for
 * about a minute, whether or not a line changed — and the browser end-to-end
 * harness builds the client before every run. Fingerprinting the inputs turns
 * the second run of an unchanged tree into a no-op. `FROCKBOT_FORCE_CLIENT_BUILD`
 * builds anyway.
 */
async function stagedIsCurrent(fingerprint: string): Promise<boolean> {
  if (process.env.FROCKBOT_FORCE_CLIENT_BUILD) return false;
  const manifest = await readFile(
    resolve(root, "dist/flutter-web.json"),
    "utf8",
  ).catch(() => undefined);
  if (!manifest) return false;
  let parsed: { sourceHash?: unknown; buildHash?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(manifest) as typeof parsed;
  } catch {
    return false;
  }
  if (parsed.sourceHash !== fingerprint) return false;
  if (typeof parsed.buildHash !== "string" || !Array.isArray(parsed.files)) {
    return false;
  }
  // The manifest is only a promise about `dist/web`; a half-deleted staging
  // directory has to rebuild rather than serve a document naming files that
  // are not there.
  const staged = resolve(assetsRoot, payloadPrefix, parsed.buildHash);
  for (const path of parsed.files as string[]) {
    if (!(await stat(resolve(staged, path)).catch(() => undefined))) {
      return false;
    }
  }
  return true;
}

const fingerprint = await sourceFingerprint();
if (await stagedIsCurrent(fingerprint)) {
  process.stdout.write(
    "The Flutter web client is already built from these sources; skipping.\n",
  );
  process.exit(0);
}

Bun.spawnSync({
  cmd: ["flutter", "build", "web", ...BUILD_FLAGS],
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
  `${JSON.stringify({ schemaVersion: 1, buildHash, sourceHash: fingerprint, files }, null, 2)}\n`,
);

process.stdout.write(
  `Built the Flutter web client at /${payloadPrefix}/${buildHash}/ (${files.length} files)\n`,
);

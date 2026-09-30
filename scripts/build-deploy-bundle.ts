#!/usr/bin/env bun
/**
 * Build a release's deploy bundle: every Worker of the simple profile, prebuilt,
 * with the manifest a deployer installs it from through the Cloudflare API
 * alone ([docs/deploy-bundles.md](../docs/deploy-bundles.md)).
 *
 *   bun scripts/build-deploy-bundle.ts --version 0.9.3 --out <directory>
 *
 * Reads what `artifact:build` staged — `apps/cloudflare/dist/web` and
 * `dist/artifacts/foundation-v1.mjs` — and writes, into `--out`:
 *
 *   frockbot-deploy-<version>.tar.gz   the modules, the assets and the artifact
 *   frockbot-deploy-<version>.json     the manifest, naming the archive's sha256
 *
 * The modules are wrangler's own bundle (`wrangler deploy --dry-run --outdir`)
 * of the configs `deployment-config` generates for the profile `bun run setup`
 * writes, under a sentinel install name the manifest turns into `{install}`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { hash as blake3 } from "blake3-wasm";
import {
  BUNDLE_SENTINEL_PREFIX_V1,
  BUNDLE_WORKERS_V1,
  bundleAssetNamesV1,
  bundleWorkerShapeV1,
  INSTALL_NAME_PATTERN_V1,
  INSTALL_TOKEN_V1,
  sha256HexV1,
  workerContentHashV1,
  type BundleAssetFileV1,
  type BundleModuleV1,
  type BundleSecretV1,
  type BundleWorkerKeyV1,
  type BundleWorkerV1,
  type DeployBundleManifestV1,
} from "../apps/cloudflare/deployment-config/bundle.ts";
import {
  DEPLOYABLE_WORKERS_V1,
  generateProfileConfigsV1,
  resourceNamesV1,
  writeGeneratedConfigsV1,
  type GeneratedConfigV1,
} from "../apps/cloudflare/deployment-config/generate.ts";
import {
  validateProfileV1,
  type DeploymentProfileV1,
} from "../apps/cloudflare/deployment-config/profile.ts";
import {
  SUPPORTED_PROTOCOL_MAX,
  SUPPORTED_PROTOCOL_MIN,
} from "../core/protocol-schemas/compatibility.generated.ts";
import { REPO_ROOT_V1 } from "./deployment-config/repository.ts";
import {
  applicationArtifactKeyV1,
  HUMAN_SECRETS_V1,
  MEMORY_INDEX_DIMENSIONS_V1,
  MINTED_SECRETS_V1,
  simpleProfileV1,
  UNISSUED_ACCESS_AUD_V1,
} from "./setup/plan.ts";

/**
 * The profile a bundle is built from: exactly what `bun run setup` writes, for
 * an install named by the sentinel. Every value an install supplies — account,
 * hostname, Access team and audience — is a placeholder the manifest leaves out.
 */
export function bundleProfileV1(version: string): DeploymentProfileV1 {
  const profile = simpleProfileV1({
    prefix: BUNDLE_SENTINEL_PREFIX_V1,
    accountId: "0".repeat(32),
    appHostname: "bundle.invalid",
    // A secret, never config: nothing of it reaches the bundle.
    adminEmails: ["admin@bundle.invalid"],
    accessTeamDomain: "bundle.cloudflareaccess.com",
    accessAud: UNISSUED_ACCESS_AUD_V1,
    imageTag: version,
  });
  validateProfileV1(profile, "the deploy bundle's profile");
  return profile;
}

export function bundleConfigsV1(
  version: string,
  applicationHash: string,
  outputRoot: string,
): GeneratedConfigV1[] {
  return generateProfileConfigsV1({
    profile: bundleProfileV1(version),
    applicationHash,
    profileDirectory: REPO_ROOT_V1,
    outputRoot,
  });
}

/** Which secrets each Worker holds: the installer's own lists, per Worker. */
export function bundleWorkerSecretsV1(
  key: BundleWorkerKeyV1,
): BundleSecretV1[] {
  const secrets: BundleSecretV1[] = [];
  for (const secret of MINTED_SECRETS_V1) {
    if (!(secret.workers as readonly string[]).includes(key)) continue;
    const others = secret.workers.filter((worker) => worker !== key);
    secrets.push({
      name: secret.name,
      required: true,
      mint: secret.shape,
      ...(others.length > 0 ? { sharedWith: others } : {}),
      ...requiredWithV1(key, secret.workers),
    });
  }
  for (const secret of HUMAN_SECRETS_V1) {
    if (!(secret.workers as readonly string[]).includes(key)) continue;
    secrets.push({
      name: secret.name,
      required: secret.required === true,
      ...requiredWithV1(key, secret.workers),
    });
  }
  if (key === "app") {
    secrets.push({ name: "FROCKBOT_ADMIN_EMAILS", required: false });
    secrets.push({ name: "FROCKBOT_ADMIN_USER_IDS", required: false });
  }
  return secrets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A secret the Computer host reads is required of another Worker only when the
 * install runs the host: the host is optional (Your Sprites).
 */
function requiredWithV1(
  key: BundleWorkerKeyV1,
  workers: readonly string[],
): { requiredWith?: BundleWorkerKeyV1 } {
  return key !== "computerHost" && workers.includes("computerHost")
    ? { requiredWith: "computerHost" }
    : {};
}

/**
 * Content types by extension, for the assets upload: the type a file is
 * uploaded with is the type it is served with, so a `.wasm` sent as anything
 * else is a client that never starts.
 */
const CONTENT_TYPES_V1: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  map: "application/json",
  css: "text/css",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain",
  xml: "application/xml",
  webmanifest: "application/manifest+json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  pdf: "application/pdf",
};

export function assetContentTypeV1(path: string): string {
  return (
    CONTENT_TYPES_V1[extname(path).slice(1).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** Wrangler's assets hash, which the upload session is keyed by. */
export function assetHashV1(path: string, bytes: Uint8Array): string {
  const digest = blake3(
    Buffer.from(bytes).toString("base64") + extname(path).slice(1),
  );
  return Buffer.from(digest).toString("hex").slice(0, 32);
}

/** The files wrangler reads as configuration rather than serving. */
const ASSET_CONFIG_FILES_V1 = new Set([
  "_headers",
  "_redirects",
  ".assetsignore",
]);

function walkV1(root: string, directory = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walkV1(root, path));
    else found.push(relative(root, path).split("\\").join("/"));
  }
  return found;
}

function moduleTypeV1(name: string): BundleModuleV1["type"] {
  switch (extname(name)) {
    case ".js":
    case ".mjs":
      return "esm";
    case ".cjs":
      return "commonjs";
    case ".wasm":
      return "compiled-wasm";
    case ".txt":
    case ".html":
      return "text";
    case ".bin":
      return "buffer";
    default:
      throw new Error(
        `wrangler emitted ${name}, whose module type a bundle does not know`,
      );
  }
}

export interface BuildOptionsV1 {
  readonly version: string;
  /** `apps/cloudflare/dist`, where `artifact:build` staged the client and artifact. */
  readonly dist: string;
  readonly out: string;
  /** `wrangler deploy --dry-run -c <config> --outdir <outdir>`, from `cwd`. */
  readonly bundle: (
    config: string,
    cwd: string,
    outdir: string,
  ) => Promise<void>;
}

export async function buildDeployBundleV1(
  options: BuildOptionsV1,
): Promise<DeployBundleManifestV1> {
  const { version, dist } = options;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`"${version}" is not a release version`);
  }
  const artifactFile = join(dist, "artifacts", "foundation-v1.mjs");
  const webDirectory = join(dist, "web");
  for (const path of [artifactFile, webDirectory]) {
    if (!existsSync(path)) {
      throw new Error(
        `${path} is missing; run \`bun run --filter @frockbot/cloudflare artifact:build\` first`,
      );
    }
  }
  const work = mkdtempSync(join(tmpdir(), "frockbot-deploy-bundle-"));
  try {
    const archive = join(work, "archive");
    mkdirSync(archive, { recursive: true });

    const artifactBytes = readFileSync(artifactFile);
    const artifactSha = await sha256HexV1(artifactBytes);
    copyFileSync(artifactFile, join(archive, "application-artifact.mjs"));

    const generated = bundleConfigsV1(
      version,
      artifactSha,
      join(work, "configs"),
    );
    writeGeneratedConfigsV1(generated, "simple");
    const configs = new Map(generated.map((entry) => [entry.worker, entry]));

    const workers = {} as Record<BundleWorkerKeyV1, BundleWorkerV1>;
    for (const key of BUNDLE_WORKERS_V1) {
      const entry = configs.get(key);
      if (!entry) throw new Error(`The simple profile deploys no ${key}`);
      const directory = DEPLOYABLE_WORKERS_V1[key].directory;
      const outdir = join(work, "wrangler", directory);
      await options.bundle(
        entry.file,
        join(REPO_ROOT_V1, "apps", directory),
        outdir,
      );
      const modules: BundleModuleV1[] = [];
      for (const name of walkV1(outdir)) {
        if (name === "README.md" || name.endsWith(".map")) continue;
        const bytes = readFileSync(join(outdir, name));
        const path = `workers/${directory}/${name}`;
        mkdirSync(dirname(join(archive, path)), { recursive: true });
        writeFileSync(join(archive, path), bytes);
        modules.push({
          name,
          type: moduleTypeV1(name),
          path,
          sha256: await sha256HexV1(bytes),
          size: bytes.length,
        });
      }
      const main = modules.find((module) => module.name === "index.js");
      if (!main) throw new Error(`wrangler emitted no index.js for ${key}`);

      const shape = bundleWorkerShapeV1(key, entry.config);
      const assets =
        key === "app"
          ? assetsOfV1(webDirectory, archive, entry.config)
          : undefined;
      const worker: Omit<BundleWorkerV1, "contentHash"> = {
        ...shape,
        mainModule: main.name,
        modules,
        secrets: bundleWorkerSecretsV1(key),
        ...(assets ? { assets } : {}),
      };
      workers[key] = {
        ...worker,
        contentHash: await workerContentHashV1(worker),
      };
    }

    const resources = resourceNamesV1(bundleProfileV1(version));
    const template = (name: string) =>
      name.replaceAll(BUNDLE_SENTINEL_PREFIX_V1, INSTALL_TOKEN_V1);
    const names = bundleAssetNamesV1(version);
    mkdirSync(options.out, { recursive: true });
    const archiveFile = join(options.out, names.archive);
    await tarV1(archive, archiveFile);

    const manifest: DeployBundleManifestV1 = {
      schemaVersion: 1,
      kind: "frockbot-deploy-bundle",
      version,
      profile: "simple",
      protocol: { min: SUPPORTED_PROTOCOL_MIN, max: SUPPORTED_PROTOCOL_MAX },
      archive: {
        file: names.archive,
        sha256: await sha256HexV1(readFileSync(archiveFile)),
      },
      install: { token: INSTALL_TOKEN_V1, pattern: INSTALL_NAME_PATTERN_V1 },
      resources: {
        r2Buckets: [
          template(resources.applicationArtifactsBucket),
          template(resources.memoryFilesBucket),
        ],
        vectorizeIndexes: [
          {
            name: template(resources.memoryIndex),
            dimensions: MEMORY_INDEX_DIMENSIONS_V1,
            metric: "cosine",
          },
        ],
      },
      applicationArtifact: {
        path: "application-artifact.mjs",
        sha256: artifactSha,
        bucket: template(resources.applicationArtifactsBucket),
        key: applicationArtifactKeyV1(artifactSha),
      },
      workers,
    };
    if (JSON.stringify(manifest).includes(BUNDLE_SENTINEL_PREFIX_V1)) {
      throw new Error(
        "The manifest still names the sentinel install somewhere",
      );
    }
    writeFileSync(
      join(options.out, names.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function assetsOfV1(
  webDirectory: string,
  archive: string,
  config: Readonly<Record<string, unknown>>,
): NonNullable<BundleWorkerV1["assets"]> {
  const files: BundleAssetFileV1[] = [];
  let headers: string | undefined;
  let redirects: string | undefined;
  for (const name of walkV1(webDirectory)) {
    const bytes = readFileSync(join(webDirectory, name));
    if (ASSET_CONFIG_FILES_V1.has(name)) {
      if (name === "_headers") headers = new TextDecoder().decode(bytes);
      if (name === "_redirects") redirects = new TextDecoder().decode(bytes);
      continue;
    }
    const archivePath = `assets/app/${name}`;
    mkdirSync(dirname(join(archive, archivePath)), { recursive: true });
    writeFileSync(join(archive, archivePath), bytes);
    files.push({
      path: `/${name}`,
      archivePath,
      hash: assetHashV1(name, bytes),
      size: bytes.length,
      contentType: assetContentTypeV1(name),
    });
  }
  const {
    directory: _directory,
    binding: _binding,
    ...assetConfig
  } = (config.assets ?? {}) as Record<string, unknown>;
  return {
    config: assetConfig,
    ...(headers === undefined ? {} : { headers }),
    ...(redirects === undefined ? {} : { redirects }),
    files,
  };
}

/** A reproducible tarball: sorted, owned by nobody, dated the epoch. */
async function tarV1(directory: string, file: string): Promise<void> {
  const tar = Bun.spawn(
    [
      "tar",
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      "-",
      "-C",
      directory,
      ".",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const bytes = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
  if ((await tar.exited) !== 0) throw new Error("tar failed");
  writeFileSync(file, Bun.gzipSync(bytes));
}

async function wranglerBundleV1(
  config: string,
  cwd: string,
  outdir: string,
): Promise<void> {
  const child = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "deploy",
      "--dry-run",
      "-c",
      config,
      "--outdir",
      outdir,
    ],
    { cwd, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) {
    throw new Error(`wrangler could not bundle ${config}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const version = value("--version");
  const out = value("--out");
  if (!version || !out) {
    console.error(
      "usage: bun scripts/build-deploy-bundle.ts --version <x.y.z> --out <directory> [--dist <apps/cloudflare/dist>]",
    );
    process.exit(2);
  }
  const manifest = await buildDeployBundleV1({
    version,
    dist: value("--dist") ?? join(REPO_ROOT_V1, "apps", "cloudflare", "dist"),
    out,
    bundle: wranglerBundleV1,
  });
  for (const key of BUNDLE_WORKERS_V1) {
    console.log(
      `${key.padEnd(12)} ${manifest.workers[key].contentHash}  ${manifest.workers[key].name}`,
    );
  }
  console.log(
    `archive      ${manifest.archive.sha256}  ${manifest.archive.file}`,
  );
}

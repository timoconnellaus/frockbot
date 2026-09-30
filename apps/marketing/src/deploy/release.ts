/**
 * Which release is newest, and its deploy bundle
 * ([docs/deploy-bundles.md](../../../../docs/deploy-bundles.md)).
 *
 * A bundle's archive is about fifty megabytes compressed and more unpacked,
 * which no Durable Object can hold. So it is staged once per release: streamed
 * from GitHub through gunzip and a tar reader into frockbot.com's own R2, with
 * the archive's digest taken on the way, and marked complete only when that
 * digest is the manifest's. The deployer then reads each file from there as it
 * needs it, and checks every module's own digest again before uploading it.
 */
import {
  bundleAssetNamesV1,
  decodeBundleManifestV1,
  type DeployBundleManifestV1,
} from "../../../cloudflare/deployment-config/bundle.ts";
import type { BundleFilesV1 } from "../../../cloudflare/deployment-config/deploy.ts";
import { isNewerVersionV1 } from "./plan";

export const RELEASE_REPOSITORY_V1 = "timoconnellaus/frockbot";

type Fetch = typeof fetch;

/**
 * Cached at the edge for ten minutes: every visitor to `/deploy` asks which
 * release is newest, and GitHub's unauthenticated limit is per address, which
 * a Worker shares with everyone else on it.
 */
const CACHED: RequestInit = {
  cf: { cacheTtl: 600, cacheEverything: true },
} as RequestInit;

export function releaseAssetUrlV1(version: string, asset: string): string {
  return `https://github.com/${RELEASE_REPOSITORY_V1}/releases/download/v${version}/${encodeURIComponent(asset)}`;
}

interface GitHubReleaseV1 {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

/** The newest published release that carries a deploy bundle. */
export async function latestDeployableVersionV1(
  fetcher: Fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(
    `https://api.github.com/repos/${RELEASE_REPOSITORY_V1}/releases?per_page=20`,
    {
      ...CACHED,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "frockbot-deploy",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} listing releases`);
  }
  const releases = (await response.json()) as GitHubReleaseV1[];
  let newest: string | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = release.tag_name.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const names = bundleAssetNamesV1(version);
    const attached = new Set(release.assets.map((a) => a.name));
    if (!attached.has(names.manifest) || !attached.has(names.archive)) continue;
    if (newest === null || isNewerVersionV1(version, newest)) newest = version;
  }
  return newest;
}

export async function releaseManifestV1(
  version: string,
  fetcher: Fetch = fetch,
): Promise<DeployBundleManifestV1> {
  const response = await fetcher(
    releaseAssetUrlV1(version, bundleAssetNamesV1(version).manifest),
    CACHED,
  );
  if (!response.ok) {
    throw new Error(
      `Release ${version} has no deploy bundle (GitHub answered ${response.status})`,
    );
  }
  const manifest = decodeBundleManifestV1(await response.json());
  if (manifest.version !== version) {
    throw new Error(
      `Release ${version}'s bundle says it is ${manifest.version}`,
    );
  }
  return manifest;
}

/** The slice of an R2 bucket staging needs. */
export interface StagingBucketV1 {
  head(key: string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array | string): Promise<unknown>;
}

/** Takes the archive's digest as it streams past; the Workers runtime has one. */
export interface DigestSinkV1 {
  readonly writable: WritableStream<Uint8Array>;
  readonly digest: Promise<ArrayBuffer>;
}

function stagedKey(version: string, path: string): string {
  return `bundles/${version}/files/${path}`;
}

function completeKey(version: string, sha256: string): string {
  return `bundles/${version}/complete-${sha256}`;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The release's files in `bucket`, streamed there once. A second call finds
 * the completion mark and does nothing; a staging cut short leaves no mark,
 * and the next call streams again over whatever it left.
 */
export async function stageBundleV1(
  bucket: StagingBucketV1,
  manifest: DeployBundleManifestV1,
  options: {
    readonly fetcher?: Fetch;
    readonly digestSink?: () => DigestSinkV1;
  } = {},
): Promise<void> {
  const done = completeKey(manifest.version, manifest.archive.sha256);
  if (await bucket.head(done)) return;
  const response = await (options.fetcher ?? fetch)(
    releaseAssetUrlV1(manifest.version, manifest.archive.file),
  );
  if (!response.ok || !response.body) {
    throw new Error(
      `Couldn't download release ${manifest.version}'s bundle (${response.status})`,
    );
  }
  const sink = (options.digestSink ?? workersDigestSinkV1)();
  const [forDigest, forFiles] = response.body.tee();
  const digesting = forDigest.pipeTo(sink.writable);
  await readTarV1(
    forFiles.pipeThrough(new DecompressionStream("gzip")),
    async (path, bytes) => {
      await bucket.put(stagedKey(manifest.version, path), bytes);
    },
  );
  await digesting;
  const digest = hex(await sink.digest);
  if (digest !== manifest.archive.sha256) {
    throw new Error(
      `Release ${manifest.version}'s bundle doesn't match its manifest`,
    );
  }
  await bucket.put(done, digest);
}

function workersDigestSinkV1(): DigestSinkV1 {
  const stream = new (
    crypto as unknown as {
      DigestStream: new (algorithm: string) => WritableStream<Uint8Array> & {
        digest: Promise<ArrayBuffer>;
      };
    }
  ).DigestStream("SHA-256");
  return { writable: stream, digest: stream.digest };
}

/** The staged release, as the deployer reads it. */
export function stagedFilesV1(
  bucket: StagingBucketV1,
  version: string,
): BundleFilesV1 {
  return {
    async read(path) {
      const object = await bucket.get(stagedKey(version, path));
      if (!object) {
        throw new Error(`Release ${version}'s bundle has no ${path}`);
      }
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

/** Exactly `length` more bytes of a stream, or fewer at its end. */
class ByteReaderV1 {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async read(length: number): Promise<Uint8Array> {
    while (this.buffered < length) {
      const { done, value } = await this.reader.read();
      if (done) break;
      this.chunks.push(value);
      this.buffered += value.length;
    }
    const size = Math.min(length, this.buffered);
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length, size - at);
      out.set(chunk.subarray(0, take), at);
      at += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.buffered -= size;
    return out;
  }
}

function field(block: Uint8Array, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/**
 * Each regular file of a tar stream, in order: ustar names with their prefix,
 * GNU long names and pax `path` records, which is what GNU tar writes for the
 * release. A path that climbs out of the archive is refused.
 */
export async function readTarV1(
  stream: ReadableStream<Uint8Array>,
  onFile: (path: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const reader = new ByteReaderV1(stream);
  let longName: string | undefined;
  for (;;) {
    const header = await reader.read(512);
    if (header.length < 512 || header.every((b) => b === 0)) return;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = await reader.read(size);
    await reader.read((512 - (size % 512)) % 512);
    if (type === "L") {
      longName = field(body, 0, body.length);
      continue;
    }
    if (type === "x") {
      const path = new TextDecoder()
        .decode(body)
        .split("\n")
        .map((record) => record.match(/^\d+ path=(.*)$/)?.[1])
        .find((value) => value !== undefined);
      if (path !== undefined) longName = path;
      continue;
    }
    const prefix = field(header, 345, 155);
    const name =
      longName ??
      (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type !== "0" && type !== "\0") continue;
    const path = name.replace(/^(\.\/)+/, "");
    if (path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`The bundle names an unsafe path: ${name}`);
    }
    await onFile(path, body);
  }
}

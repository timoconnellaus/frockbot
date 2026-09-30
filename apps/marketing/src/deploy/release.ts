/**
 * Which release is newest, and its files, fetched from GitHub and checked
 * against the digests the manifest names.
 */
import {
  RELEASE_REPOSITORY_V1,
  decodeReleaseManifestV1,
  isNewerVersionV1,
  releaseAssetUrlV1,
  releaseManifestAssetV1,
  type BundleFileV1,
  type ReleaseBundleManifestV1,
} from "./manifest";

type Fetch = typeof fetch;

/**
 * Cached at the edge for ten minutes: every visitor to `/deploy` asks which
 * release is newest, and GitHub's unauthenticated limit is per address, which
 * a Worker shares with everyone else on it.
 */
const CACHED: RequestInit = {
  cf: { cacheTtl: 600, cacheEverything: true },
} as RequestInit;

interface GitHubReleaseV1 {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

/** The newest published release that carries a deploy manifest. */
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
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} listing releases`);
  const releases = (await response.json()) as GitHubReleaseV1[];
  let newest: string | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = release.tag_name.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (!release.assets.some((a) => a.name === releaseManifestAssetV1(version)))
      continue;
    if (newest === null || isNewerVersionV1(version, newest)) newest = version;
  }
  return newest;
}

export async function releaseManifestV1(
  version: string,
  fetcher: Fetch = fetch,
): Promise<ReleaseBundleManifestV1> {
  const response = await fetcher(
    releaseAssetUrlV1(version, releaseManifestAssetV1(version)),
    CACHED,
  );
  if (!response.ok) {
    throw new Error(
      `Release ${version} has no deploy manifest (GitHub answered ${response.status})`,
    );
  }
  const manifest = decodeReleaseManifestV1(await response.json());
  if (manifest.version !== version) {
    throw new Error(
      `Release ${version}'s manifest says it is ${manifest.version}`,
    );
  }
  return manifest;
}

export async function sha256HexV1(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** One of the release's files, refused unless it is byte for byte what the manifest names. */
export async function releaseFileV1(
  version: string,
  file: BundleFileV1,
  fetcher: Fetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(
    releaseAssetUrlV1(version, file.asset),
    CACHED,
  );
  if (!response.ok) {
    throw new Error(
      `Couldn't download ${file.asset} from release ${version} (${response.status})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256HexV1(bytes);
  if (digest !== file.sha256) {
    throw new Error(
      `${file.asset} from release ${version} doesn't match its manifest`,
    );
  }
  return bytes;
}

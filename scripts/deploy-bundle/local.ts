/**
 * What a deployer on a machine needs around `deployBundleV1`: the bundle for a
 * release, fetched, verified and unpacked; a Cloudflare token; and a
 * conversation with the installed Bot to prove it answers. `bun run setup` and
 * `scripts/deploy-bundle.ts` share these. The deploy page has its own, in a
 * browser, over the same manifest.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  bundleAssetNamesV1,
  decodeBundleManifestV1,
  sha256HexV1,
  type DeployBundleManifestV1,
} from "../../apps/cloudflare/deployment-config/bundle.ts";
import type { BundleFilesV1 } from "../../apps/cloudflare/deployment-config/deploy.ts";

/** The GitHub repository whose releases carry the bundles. */
export const BUNDLE_RELEASE_REPOSITORY_V1 = "timoconnellaus/frockbot";

export function releaseAssetUrlV1(version: string, asset: string): string {
  return `https://github.com/${BUNDLE_RELEASE_REPOSITORY_V1}/releases/download/v${version}/${asset}`;
}

/**
 * The newest release's version, for a checkout that is on no tag. GitHub
 * answers `/releases/latest` with a redirect to the tag it means.
 */
export async function latestReleaseVersionV1(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(
    `https://github.com/${BUNDLE_RELEASE_REPOSITORY_V1}/releases/latest`,
    { redirect: "manual" },
  );
  const tag = response.headers
    .get("location")
    ?.match(/\/tag\/v(\d+\.\d+\.\d+)$/)?.[1];
  if (!tag) {
    throw new Error(
      "Could not tell which release is the newest; check out a release tag and run this again",
    );
  }
  return tag;
}

export interface LocalBundleV1 {
  readonly manifest: DeployBundleManifestV1;
  readonly directory: string;
  readonly files: BundleFilesV1;
}

/**
 * The bundle a spec names, unpacked under `into`: a release version, which is
 * downloaded from its GitHub release, or the path of a manifest whose archive
 * sits beside it. The archive is refused unless its sha256 is the manifest's.
 */
export async function loadBundleV1(
  spec: string,
  into: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalBundleV1> {
  let manifestBytes: Uint8Array;
  let archiveBytes: Uint8Array;
  if (/^v?\d+\.\d+\.\d+$/.test(spec)) {
    const version = spec.replace(/^v/, "");
    const names = bundleAssetNamesV1(version);
    manifestBytes = await downloadV1(
      fetchImpl,
      releaseAssetUrlV1(version, names.manifest),
    );
    archiveBytes = await downloadV1(
      fetchImpl,
      releaseAssetUrlV1(version, names.archive),
    );
  } else {
    manifestBytes = readFileSync(spec);
    const manifest = decodeBundleManifestV1(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    );
    archiveBytes = readFileSync(join(dirname(spec), manifest.archive.file));
  }
  const manifest = decodeBundleManifestV1(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );
  const actual = await sha256HexV1(archiveBytes);
  if (actual !== manifest.archive.sha256) {
    throw new Error(
      `${manifest.archive.file} hashes to ${actual}, and its manifest says ${manifest.archive.sha256}`,
    );
  }
  const directory = join(into, manifest.version);
  mkdirSync(directory, { recursive: true });
  const archiveFile = join(into, manifest.archive.file);
  writeFileSync(archiveFile, archiveBytes);
  const tar = Bun.spawn(["tar", "-xzf", archiveFile, "-C", directory], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await tar.exited) !== 0) {
    throw new Error(`Could not unpack ${manifest.archive.file}`);
  }
  return { manifest, directory, files: directoryFilesV1(directory) };
}

async function downloadV1(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Reads a manifest path inside an unpacked bundle, and nowhere else. */
export function directoryFilesV1(directory: string): BundleFilesV1 {
  const root = resolve(directory);
  return {
    read: async (path) => {
      const target = resolve(root, normalize(path));
      if (isAbsolute(path) || !target.startsWith(`${root}/`)) {
        throw new Error(`${path} is outside the bundle`);
      }
      if (!existsSync(target)) throw new Error(`The bundle holds no ${path}`);
      return new Uint8Array(readFileSync(target));
    },
  };
}

/**
 * A Cloudflare API token: `CLOUDFLARE_API_TOKEN`, or the one `wrangler login`
 * holds, which `wrangler auth token` prints (refreshing it first). The OAuth one
 * carries only the scopes granted at login; a deploy needs Workers, R2,
 * Vectorize and Containers write.
 */
export async function cloudflareTokenV1(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const child = Bun.spawn(["bunx", "wrangler", "auth", "token"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const token = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0 || token === "" || /\s/.test(token)) {
    throw new Error(
      "No Cloudflare token: set CLOUDFLARE_API_TOKEN, or run `bunx wrangler login` first",
    );
  }
  return token;
}

/* ── A conversation ─────────────────────────────────────────────────────── */

export interface ConversationV1 {
  readonly botId: string;
  readonly runId: string;
  readonly reply: string;
}

/**
 * Say something to the account's General Bot and wait for the reply, as the
 * person the Access token names, through the same `/api` the client uses.
 *
 * An Access deployment stores no identities, so the debug surface cannot
 * speak for anyone: a conversation needs a person's own sign-in. `/api` is
 * bypassed at the edge and authenticated by the Worker from the
 * `CF_Authorization` cookie, which is what a browser sends too.
 */
export async function converseV1(options: {
  readonly url: string;
  readonly accessToken: string;
  readonly text: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}): Promise<ConversationV1> {
  const doFetch = options.fetch ?? fetch;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await doFetch(`${options.url}${path}`, {
      ...init,
      headers: {
        cookie: `CF_Authorization=${options.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      redirect: "manual",
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status >= 300) {
      throw new Error(
        `${init.method ?? "GET"} ${path} answered ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return body as Record<string, unknown>;
  };
  const bootstrap = await call("/api/bots/bootstrap");
  const botId = bootstrap.generalBotId;
  if (typeof botId !== "string") {
    throw new Error("This account has no General Bot to talk to");
  }
  const runId = crypto.randomUUID();
  const admitted = await call(`/api/bots/${encodeURIComponent(botId)}/turns`, {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: runId,
      text: options.text,
    }),
  });
  if (admitted.runId !== runId) {
    throw new Error(
      `The Turn was admitted as ${String(admitted.runId)}, not ${runId}`,
    );
  }
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const run = await readRunV1(call, botId, runId);
    if (run) {
      if (run.status !== "completed") {
        throw new Error(
          `The Turn ended ${run.status}: ${JSON.stringify(run.outcome)}`,
        );
      }
      const reply = run.outcome?.text?.trim() ?? "";
      if (reply === "") throw new Error("The Turn completed with no reply");
      return { botId, runId, reply };
    }
    await Bun.sleep(options.pollMs ?? 3_000);
  }
  throw new Error(`The Turn ${runId} was still running after the timeout`);
}

interface TerminalRunV1 {
  readonly status: string;
  readonly outcome?: { readonly text?: string; readonly message?: string };
}

async function readRunV1(
  call: (path: string) => Promise<Record<string, unknown>>,
  botId: string,
  runId: string,
): Promise<TerminalRunV1 | undefined> {
  const lookup = await call(
    `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}`,
  );
  return lookup.state === "terminal"
    ? (lookup.run as TerminalRunV1)
    : undefined;
}

/**
 * Read back a Turn an earlier conversation left, which is what "the update
 * kept its data" means: the Bot's Durable Object still holds it.
 */
export async function readBackV1(options: {
  readonly url: string;
  readonly accessToken: string;
  readonly conversation: ConversationV1;
  readonly fetch?: typeof fetch;
}): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const { botId, runId, reply } = options.conversation;
  const response = await doFetch(
    `${options.url}/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}`,
    {
      headers: { cookie: `CF_Authorization=${options.accessToken}` },
      redirect: "manual",
    },
  );
  const lookup = (await response.json().catch(() => null)) as {
    state?: string;
    run?: TerminalRunV1;
  } | null;
  if (response.status !== 200 || lookup?.state !== "terminal") {
    throw new Error(
      `The Turn ${runId} is gone after the update (${response.status}, ${JSON.stringify(lookup)})`,
    );
  }
  if ((lookup.run?.outcome?.text?.trim() ?? "") !== reply) {
    throw new Error(`The Turn ${runId} came back with a different reply`);
  }
}

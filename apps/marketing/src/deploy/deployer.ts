/**
 * The deploy's steps, run against the person's account.
 *
 * Every step converges: it finds what a previous run made and keeps it, so a
 * step retried after an eviction, a failure or a closed page does the same
 * thing twice without making anything twice. An update is the same steps over
 * the same install record, which is how the install keeps its data: the same
 * names, the Durable Object migrations that are still due, and the secrets it
 * was minted on its first deploy.
 */
import { CloudflareApiErrorV1, type CloudflareApiV1 } from "./cloudflare-api";
import type { ReleaseBundleManifestV1 } from "./manifest";
import {
  MODULE_CONTENT_TYPES_V1,
  appWorkerV1,
  assetContentTypeV1,
  installHostnameV1,
  installOriginV1,
  mintSecretV1,
  resourceNameV1,
  scriptMetadataV1,
  secretsToMintV1,
  suggestedTeamNameV1,
  type DeployStepIdV1,
} from "./plan";
import { releaseFileV1, sha256HexV1 } from "./release";
import { randomTokenV1 } from "./oauth";
import { readZipV1 } from "./zip";

/** Jev's model on Workers AI, which the install's `AI` binding calls. */
export const JEV_MODEL_V1 = "typesafe/jev";

/** What `/deploy` keeps about an install: names and ids, never a secret. */
export interface InstallRecordV1 {
  readonly name: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly workersSubdomain: string;
  readonly ownerEmail: string;
  /** The release the install runs, once a deploy of it finished. */
  readonly version?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly accessTeamDomain?: string;
  readonly accessAud?: string;
  readonly kvNamespaceIds?: Readonly<Record<string, string>>;
  readonly d1DatabaseIds?: Readonly<Record<string, string>>;
}

export interface DeployContextV1 {
  readonly api: CloudflareApiV1;
  readonly manifest: ReleaseBundleManifestV1;
  readonly fetcher: typeof fetch;
  readonly now: () => Date;
}

/** Thrown by a step that isn't finished yet and should be tried again shortly. */
export class NotYetV1 extends Error {}

export type StepRunnerV1 = (
  context: DeployContextV1,
  install: InstallRecordV1,
) => Promise<InstallRecordV1>;

async function storage(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const { api, manifest } = context;
  const { accountId, name } = install;
  const resources = manifest.resources;
  for (const role of resources.r2Buckets ?? []) {
    await api.ensureR2Bucket(accountId, resourceNameV1(name, role));
  }
  for (const index of resources.vectorizeIndexes ?? []) {
    await api.ensureVectorizeIndex(
      accountId,
      resourceNameV1(name, index.role),
      {
        dimensions: index.dimensions,
        metric: index.metric,
      },
    );
  }
  for (const role of resources.queues ?? []) {
    await api.ensureQueue(accountId, resourceNameV1(name, role));
  }
  const kvNamespaceIds: Record<string, string> = { ...install.kvNamespaceIds };
  for (const role of resources.kvNamespaces ?? []) {
    kvNamespaceIds[role] = await api.ensureKvNamespace(
      accountId,
      resourceNameV1(name, role),
    );
  }
  const d1DatabaseIds: Record<string, string> = { ...install.d1DatabaseIds };
  for (const database of resources.d1Databases ?? []) {
    const id = await api.ensureD1Database(
      accountId,
      resourceNameV1(name, database.role),
    );
    d1DatabaseIds[database.role] = id;
    await applyD1Migrations(context, accountId, id, database.migrations);
  }
  return { ...install, kvNamespaceIds, d1DatabaseIds };
}

/**
 * The release's D1 migrations, each applied once, recorded in the same
 * `d1_migrations` table wrangler keeps, so an install moved to the repository
 * path later sees the same history.
 */
async function applyD1Migrations(
  context: DeployContextV1,
  accountId: string,
  databaseId: string,
  migrations: NonNullable<
    ReleaseBundleManifestV1["resources"]["d1Databases"]
  >[number]["migrations"],
): Promise<void> {
  if (migrations.length === 0) return;
  const { api } = context;
  await api.d1Query(
    accountId,
    databaseId,
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  const applied = new Set(
    (
      await api.d1Query<{ name: string }>(
        accountId,
        databaseId,
        "SELECT name FROM d1_migrations",
      )
    ).map((row) => row.name),
  );
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const sql = new TextDecoder().decode(
      await releaseFileV1(context.manifest.version, migration, context.fetcher),
    );
    await api.d1Query(accountId, databaseId, sql);
    await api.d1Query(
      accountId,
      databaseId,
      "INSERT INTO d1_migrations (name) VALUES (?)",
      [migration.name],
    );
  }
}

/**
 * The Access organization, created when Zero Trust is on but has none, and
 * the install's two applications (ADR 0028): Allow on the hostname for the
 * owner alone, which covers the document, the client and the native sign-in
 * flow; Bypass on `/api`, which reaches the Worker, which authenticates every
 * one of those requests itself.
 */
async function signIn(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const { api } = context;
  const { accountId } = install;
  let organization = await api.accessOrganization(accountId);
  for (let attempt = 0; !organization; attempt += 1) {
    // A team domain is global across Cloudflare, so a taken one gets a suffix.
    const base = suggestedTeamNameV1(install.accountName, accountId);
    const team =
      attempt === 0
        ? base
        : `${base}-${randomTokenV1(3)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")}`;
    try {
      organization = await api.createAccessOrganization(accountId, {
        name: install.accountName || team,
        auth_domain: `${team}.cloudflareaccess.com`,
      });
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof CloudflareApiErrorV1) ||
        error.status >= 500
      )
        throw error;
    }
  }
  const hostname = installHostnameV1(install.name, install.workersSubdomain);
  const existing = await api.accessApplications(accountId);
  const app = await api.putAccessApplication(
    accountId,
    {
      name: `FrockBot ${install.name}`,
      domain: hostname,
      decision: "allow",
      email: install.ownerEmail,
    },
    existing,
  );
  await api.putAccessApplication(
    accountId,
    {
      name: `FrockBot ${install.name} API`,
      domain: `${hostname}/api`,
      decision: "bypass",
    },
    existing,
  );
  return {
    ...install,
    accessTeamDomain: organization.auth_domain,
    accessAud: app.aud,
  };
}

/** The web client as static assets: only the files Cloudflare doesn't already hold are sent. */
async function uploadAssets(
  context: DeployContextV1,
  install: InstallRecordV1,
  archive: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const { api } = context;
  const entries = await readZipV1(archive);
  const byHash = new Map<string, { base64: string; contentType: string }>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const entry of entries) {
    let binary = "";
    for (let i = 0; i < entry.bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...entry.bytes.subarray(i, i + 0x8000));
    }
    const base64 = btoa(binary);
    const extension = entry.path.split(".").pop() ?? "";
    // Any stable 32-hex content key does; this is the content and its extension,
    // so the same bytes served as another type are a different asset.
    const hash = (
      await sha256HexV1(new TextEncoder().encode(base64 + extension))
    ).slice(0, 32);
    manifest[`/${entry.path}`] = { hash, size: entry.bytes.length };
    byHash.set(hash, { base64, contentType: assetContentTypeV1(entry.path) });
  }
  const session = await api.assetsUploadSession(
    install.accountId,
    install.name,
    manifest,
  );
  let completion = session.jwt;
  for (const bucket of session.buckets) {
    const files = bucket.map((hash) => ({ hash, ...byHash.get(hash)! }));
    completion =
      (await api.uploadAssetBucket(install.accountId, session.jwt, files)) ??
      completion;
  }
  return completion;
}

async function release(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const { api, manifest, fetcher } = context;
  if (!install.accessTeamDomain || !install.accessAud) {
    throw new Error(
      "Sign-in wasn't set up before the release, so it wasn't deployed",
    );
  }
  const worker = appWorkerV1(manifest);
  const script = await api.script(install.accountId, install.name);
  const existingSecrets = script
    ? await api.scriptSecretNames(install.accountId, install.name)
    : [];
  const mintedSecrets: Record<string, string> = {};
  for (const secret of secretsToMintV1(worker, existingSecrets)) {
    mintedSecrets[secret.name] = mintSecretV1(secret.shape, context.now());
  }
  const modules = [];
  for (const module of worker.modules) {
    modules.push({
      name: module.name,
      contentType: MODULE_CONTENT_TYPES_V1[module.type],
      body: await releaseFileV1(manifest.version, module, fetcher),
    });
  }
  const assetsJwt = worker.assets
    ? await uploadAssets(
        context,
        install,
        await releaseFileV1(manifest.version, worker.assets, fetcher),
      )
    : undefined;
  for (const object of worker.r2Objects ?? []) {
    await api.putR2Object(
      install.accountId,
      resourceNameV1(install.name, object.bucket),
      object.key,
      await releaseFileV1(manifest.version, object, fetcher),
      object.contentType,
    );
  }
  await api.uploadScript(install.accountId, install.name, {
    metadata: scriptMetadataV1(
      worker,
      {
        installName: install.name,
        origin: installOriginV1(install.name, install.workersSubdomain),
        ownerEmail: install.ownerEmail,
        accessTeamDomain: install.accessTeamDomain,
        accessAud: install.accessAud,
        kvNamespaceIds: install.kvNamespaceIds ?? {},
        d1DatabaseIds: install.d1DatabaseIds ?? {},
      },
      { currentMigrationTag: script?.migration_tag, mintedSecrets, assetsJwt },
    ),
    modules,
  });
  // Only now, with Access in front of it, is the install reachable at all.
  await api.enableWorkersDev(install.accountId, install.name);
  return install;
}

async function workersAi(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  if (!(await context.api.aiModelAvailable(install.accountId, JEV_MODEL_V1))) {
    throw new Error(
      `Jev (${JEV_MODEL_V1}) isn’t in this account’s Workers AI catalog, so your bots can’t start a Turn. Open Workers AI in Cloudflare once, then try again.`,
    );
  }
  return install;
}

/**
 * The install answers, and answers the right way: the page is behind Access,
 * and `/api` reaches the Worker, which refuses a request with no sign-in
 * itself. A new `workers.dev` name can take a minute or two to resolve, so an
 * install that doesn't answer yet is tried again rather than failed.
 */
async function firstCheck(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const origin = installOriginV1(install.name, install.workersSubdomain);
  let page: Response;
  let api: Response;
  try {
    page = await context.fetcher(`${origin}/`, { redirect: "manual" });
    api = await context.fetcher(`${origin}/api/identity`, {
      redirect: "manual",
    });
  } catch {
    throw new NotYetV1("Your install isn’t answering yet.");
  }
  const location = page.headers.get("location") ?? "";
  const guarded =
    (page.status === 302 || page.status === 303) &&
    (/\.cloudflareaccess\.com\//.test(location) ||
      location.includes("/cdn-cgi/access/"));
  if (!guarded) {
    if (page.status === 404 || page.status >= 500) {
      throw new NotYetV1("Your install isn’t answering yet.");
    }
    throw new Error(
      `Your install answered without asking anyone to sign in (${page.status}). Cloudflare Access isn’t in front of it yet.`,
    );
  }
  const isWorker =
    api.status === 401 &&
    (api.headers.get("content-type") ?? "").includes("json");
  if (!isWorker) throw new NotYetV1("Your install’s app isn’t answering yet.");
  return install;
}

/**
 * Sign-in runs before the release on purpose: the Worker is uploaded with the
 * audience Access issued, and `workers.dev` is switched on only once Access
 * stands in front of it, so the install is never reachable unguarded.
 */
export const STEP_RUNNERS_V1: Readonly<Record<DeployStepIdV1, StepRunnerV1>> = {
  storage,
  "sign-in": signIn,
  release,
  "workers-ai": workersAi,
  "first-check": firstCheck,
};

/** A failure worth trying again by itself, rather than showing. */
export function isTransientV1(error: unknown): boolean {
  if (error instanceof NotYetV1) return true;
  if (error instanceof CloudflareApiErrorV1)
    return error.status === 429 || error.status >= 500;
  return false;
}

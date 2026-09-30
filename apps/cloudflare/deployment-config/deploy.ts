/**
 * Install a deploy bundle into a Cloudflare account through the REST API — no
 * wrangler, no build, nothing on the deployer's machine but `fetch`
 * ([docs/deploy-bundles.md](../../../docs/deploy-bundles.md)).
 *
 * The calls are the ones `wrangler deploy` makes (wrangler 4.129), in its
 * order: resources, then each Worker's script upload with its migrations and
 * assets, then its container application, workers.dev setting and custom
 * domains. Every step is idempotent, so a second run converges, and an update
 * is the same call with the next release's bundle.
 *
 * Browser-safe on purpose: the deploy page runs this with the person's own
 * Cloudflare sign-in. `bun run setup` and `scripts/deploy-bundle.ts` run it with
 * a token.
 */
import {
  installNameOfV1,
  installSuccessionProblemsV1,
  installWorkersV1,
  migrationUploadV1,
  missingSecretsV1,
  sha256HexV1,
  checkInstallNameV1,
  workerUploadMetadataV1,
  type BundleWorkerKeyV1,
  type DeployBundleManifestV1,
  type DeployedInstallV1,
  type InstallV1,
} from "./bundle.ts";

export const CLOUDFLARE_API_BASE_V1 = "https://api.cloudflare.com/client/v4";

export interface CloudflareResponseV1 {
  readonly status: number;
  /** The parsed body: the `{success, result, errors}` envelope, usually. */
  readonly body: unknown;
}

export interface CloudflareRequestV1 {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Under the v4 API, e.g. `/accounts/<id>/r2/buckets`. */
  readonly path: string;
  readonly json?: unknown;
  readonly form?: FormData;
  readonly bytes?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  /** A bearer other than the API token: an assets upload session's JWT. */
  readonly bearer?: string;
}

/** The one thing the deployer needs from the outside world. */
export interface CloudflareApiV1 {
  call(request: CloudflareRequestV1): Promise<CloudflareResponseV1>;
}

export function createCloudflareApiV1(options: {
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly base?: string;
}): CloudflareApiV1 {
  const doFetch = options.fetch ?? fetch;
  const base = options.base ?? CLOUDFLARE_API_BASE_V1;
  return {
    async call(request) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${request.bearer ?? options.token}`,
        ...request.headers,
      };
      let body: BodyInit | undefined;
      if (request.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(request.json);
      } else if (request.form) {
        body = request.form;
      } else if (request.bytes) {
        body = request.bytes as Uint8Array<ArrayBuffer>;
      }
      const response = await doFetch(`${base}${request.path}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        // Not JSON: an R2 object answer, or an error page. Kept as text.
      }
      return { status: response.status, body: parsed };
    },
  };
}

/** Where the bytes the manifest names come from: an unpacked archive. */
export interface BundleFilesV1 {
  read(path: string): Promise<Uint8Array>;
}

export interface DeployOptionsV1 {
  readonly api: CloudflareApiV1;
  readonly manifest: DeployBundleManifestV1;
  readonly files: BundleFilesV1;
  readonly install: InstallV1;
  readonly say?: (line: string) => void;
}

export interface DeployOutcomeV1 {
  readonly version: string;
  readonly scripts: Readonly<Partial<Record<BundleWorkerKeyV1, string>>>;
  readonly url: string | undefined;
  /** Whether this was the first deploy of the app Worker in this account. */
  readonly firstInstall: boolean;
}

function resultOf<T>(response: CloudflareResponseV1): T | undefined {
  const body = response.body as { result?: T } | null;
  return typeof body === "object" && body !== null ? body.result : undefined;
}

function failure(what: string, response: CloudflareResponseV1): Error {
  const body = response.body as {
    errors?: { code?: number; message?: string }[];
  } | null;
  const errors =
    typeof body === "object" && body !== null && Array.isArray(body.errors)
      ? body.errors
          .map((error) => `${error.code ?? "?"}: ${error.message ?? ""}`)
          .join("; ")
      : typeof response.body === "string"
        ? response.body.slice(0, 300)
        : "";
  return new Error(
    `Could not ${what}: the API answered ${response.status}${errors ? ` (${errors})` : ""}`,
  );
}

async function expectOk(
  api: CloudflareApiV1,
  request: CloudflareRequestV1,
  what: string,
): Promise<CloudflareResponseV1> {
  const response = await api.call(request);
  if (response.status >= 300) throw failure(what, response);
  return response;
}

/** Read the account's existing scripts and namespaces, for the install gate. */
export async function readDeployedInstallV1(
  api: CloudflareApiV1,
  accountId: string,
  scripts: readonly string[],
): Promise<DeployedInstallV1> {
  const found: Record<string, string | null> = {};
  for (const script of scripts) {
    const response = await api.call({
      method: "GET",
      path: `/accounts/${accountId}/workers/services/${script}`,
    });
    if (response.status === 404) continue;
    if (response.status >= 300) {
      throw failure(`read the deployed script ${script}`, response);
    }
    const service = resultOf<{
      default_environment?: { script?: { migration_tag?: string } };
    }>(response);
    found[script] = service?.default_environment?.script?.migration_tag ?? null;
  }
  const listed = await expectOk(
    api,
    {
      method: "GET",
      path: `/accounts/${accountId}/workers/durable_objects/namespaces?per_page=1000`,
    },
    "list the account's Durable Object namespaces",
  );
  const namespaces = (
    resultOf<{ id?: string; script?: string; class?: string }[]>(listed) ?? []
  )
    .filter((namespace) => namespace.script && namespace.class)
    .map((namespace) => ({
      id: namespace.id ?? "",
      script: namespace.script!,
      class: namespace.class!,
    }));
  return { scripts: found, namespaces };
}

/**
 * Install or update one bundle. Refuses, before it touches anything, when the
 * account holds something the bundle would orphan.
 */
export async function deployBundleV1(
  options: DeployOptionsV1,
): Promise<DeployOutcomeV1> {
  const { api, manifest, files, install } = options;
  const say = options.say ?? (() => {});
  checkInstallNameV1(install.name);
  const account = `/accounts/${install.accountId}`;
  const workers = installWorkersV1(install);
  const scripts = Object.fromEntries(
    workers.map((key) => [
      key,
      installNameOfV1(manifest.workers[key].name, install.name),
    ]),
  ) as Partial<Record<BundleWorkerKeyV1, string>>;

  // The gate first: nothing is created in an account whose install this
  // bundle cannot safely succeed.
  const deployed = await readDeployedInstallV1(
    api,
    install.accountId,
    Object.values(scripts),
  );
  const problems = installSuccessionProblemsV1(
    manifest,
    install.name,
    deployed,
    workers,
  );
  if (problems.length > 0) {
    throw new Error(
      `Refusing to deploy ${manifest.version} over this install: ${problems.join("; ")}`,
    );
  }
  for (const key of workers) {
    if (scripts[key]! in deployed.scripts) continue;
    const missing = missingSecretsV1(manifest, key, install);
    if (missing.length > 0) {
      throw new Error(
        `A first install of ${scripts[key]} needs ${missing.join(", ")}`,
      );
    }
  }
  const app = manifest.workers.app;
  if (app.customDomains && install.hostnames.length === 0) {
    throw new Error("The install names no hostname for the app");
  }

  await ensureResourcesV1(api, account, manifest, install, say);
  await uploadApplicationArtifactV1(
    api,
    account,
    manifest,
    files,
    install,
    say,
  );

  for (const key of workers) {
    await deployWorkerV1(
      { api, account, manifest, files, install, say },
      key,
      scripts[key]!,
      deployed.scripts[scripts[key]!],
      scripts[key]! in deployed.scripts,
    );
  }

  return {
    version: manifest.version,
    scripts,
    url: install.hostnames[0] ? `https://${install.hostnames[0]}` : undefined,
    firstInstall: !(scripts.app! in deployed.scripts),
  };
}

async function ensureResourcesV1(
  api: CloudflareApiV1,
  account: string,
  manifest: DeployBundleManifestV1,
  install: InstallV1,
  say: (line: string) => void,
): Promise<void> {
  for (const template of manifest.resources.r2Buckets) {
    const name = installNameOfV1(template, install.name);
    const present = await api.call({
      method: "GET",
      path: `${account}/r2/buckets/${name}`,
    });
    if (present.status < 300) {
      say(`  bucket     ${name} already exists`);
      continue;
    }
    await expectOk(
      api,
      {
        method: "POST",
        path: `${account}/r2/buckets`,
        json: {
          name,
          ...(install.location ? { locationHint: install.location } : {}),
        },
      },
      `create the R2 bucket ${name}`,
    );
    say(`  bucket     ${name} created`);
  }
  for (const index of manifest.resources.vectorizeIndexes) {
    const name = installNameOfV1(index.name, install.name);
    const present = await api.call({
      method: "GET",
      path: `${account}/vectorize/v2/indexes/${name}`,
    });
    if (present.status < 300) {
      say(`  index      ${name} already exists`);
      continue;
    }
    await expectOk(
      api,
      {
        method: "POST",
        path: `${account}/vectorize/v2/indexes`,
        json: {
          name,
          config: { dimensions: index.dimensions, metric: index.metric },
        },
      },
      `create the Vectorize index ${name}`,
    );
    say(`  index      ${name} created`);
  }
}

async function verifiedV1(
  files: BundleFilesV1,
  path: string,
  sha256: string,
): Promise<Uint8Array> {
  const bytes = await files.read(path);
  const actual = await sha256HexV1(bytes);
  if (actual !== sha256) {
    throw new Error(
      `${path} in the bundle hashes to ${actual}, and the manifest says ${sha256}`,
    );
  }
  return bytes;
}

async function uploadApplicationArtifactV1(
  api: CloudflareApiV1,
  account: string,
  manifest: DeployBundleManifestV1,
  files: BundleFilesV1,
  install: InstallV1,
  say: (line: string) => void,
): Promise<void> {
  const artifact = manifest.applicationArtifact;
  const bucket = installNameOfV1(artifact.bucket, install.name);
  const bytes = await verifiedV1(files, artifact.path, artifact.sha256);
  // Content-addressed, so putting it again is putting the same bytes.
  await expectOk(
    api,
    {
      method: "PUT",
      path: `${account}/r2/buckets/${bucket}/objects/${artifact.key}`,
      bytes,
      headers: { "content-type": "application/javascript" },
    },
    "upload the application artifact",
  );
  say(`  artifact   ${bucket}/${artifact.key}`);
}

interface WorkerContextV1 {
  readonly api: CloudflareApiV1;
  readonly account: string;
  readonly manifest: DeployBundleManifestV1;
  readonly files: BundleFilesV1;
  readonly install: InstallV1;
  readonly say: (line: string) => void;
}

const MODULE_CONTENT_TYPES_V1 = {
  esm: "application/javascript+module",
  commonjs: "application/javascript",
  "compiled-wasm": "application/wasm",
  text: "text/plain",
  buffer: "application/octet-stream",
} as const;

async function deployWorkerV1(
  context: WorkerContextV1,
  key: BundleWorkerKeyV1,
  script: string,
  deployedTag: string | null | undefined,
  exists: boolean,
): Promise<void> {
  const { api, account, manifest, files, install, say } = context;
  const worker = manifest.workers[key];
  const migrations = migrationUploadV1(
    worker.migrations,
    exists ? (deployedTag ?? undefined) : undefined,
  );
  const assetsJwt = worker.assets
    ? await uploadAssetsV1(context, key, script)
    : undefined;
  const metadata = workerUploadMetadataV1(manifest, key, install, {
    ...(migrations ? { migrations } : {}),
    ...(assetsJwt ? { assetsJwt } : {}),
  });

  const form = new FormData();
  // A plain field, as wrangler sends it.
  form.set("metadata", JSON.stringify(metadata));
  for (const module of worker.modules) {
    const bytes = await verifiedV1(files, module.path, module.sha256);
    form.set(
      module.name,
      new File([bytes as Uint8Array<ArrayBuffer>], module.name, {
        type: MODULE_CONTENT_TYPES_V1[module.type],
      }),
    );
  }
  // The PUT path deploys at once, and it is the one wrangler takes whenever
  // there are migrations or containers; taking it always keeps one path.
  await expectOk(
    api,
    {
      method: "PUT",
      path: `${account}/workers/scripts/${script}?excludeScript=true&bindings_inherit=strict`,
      form,
    },
    `upload ${script}`,
  );
  say(
    `  deployed   ${script}${migrations ? ` (migrations → ${migrations.new_tag})` : ""}`,
  );

  for (const container of worker.containers) {
    await ensureContainerV1(context, script, container);
  }

  await expectOk(
    api,
    {
      method: "POST",
      path: `${account}/workers/scripts/${script}/subdomain`,
      json: { enabled: worker.workersDev, previews_enabled: false },
      headers: { "Cloudflare-Workers-Script-Api-Date": "2025-08-01" },
    },
    `set ${script}'s workers.dev route`,
  );

  if (worker.customDomains) {
    await expectOk(
      api,
      {
        method: "PUT",
        path: `${account}/workers/scripts/${script}/domains/records`,
        json: {
          override_scope: true,
          override_existing_origin: true,
          override_existing_dns_record: true,
          origins: install.hostnames.map((hostname) => ({ hostname })),
        },
      },
      `attach ${install.hostnames.join(", ")} to ${script}`,
    );
    say(`  domains    ${install.hostnames.join(", ")}`);
  }
}

/** Whether an upload session's JWT asks for one call per file, as wrangler reads it. */
function singleAssetUploadModeV1(jwt: string): boolean {
  try {
    const payload = (jwt.split(".")[1] ?? "")
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    return (
      (
        JSON.parse(atob(payload)) as {
          wrangler_single_asset_uploads?: unknown;
        }
      ).wrangler_single_asset_uploads === true
    );
  } catch {
    return false;
  }
}

/** Base64 of bytes, in chunks a call stack survives. */
function base64V1(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Upload the Worker's static assets and answer the completion token its script
 * upload carries. Only the files Cloudflare does not already hold are sent.
 */
async function uploadAssetsV1(
  context: WorkerContextV1,
  key: BundleWorkerKeyV1,
  script: string,
): Promise<string> {
  const { api, account, manifest, files, say } = context;
  const assets = manifest.workers[key].assets!;
  const byHash = new Map(assets.files.map((file) => [file.hash, file]));
  const session = await expectOk(
    api,
    {
      method: "POST",
      path: `${account}/workers/scripts/${script}/assets-upload-session`,
      json: {
        manifest: Object.fromEntries(
          assets.files.map((file) => [
            file.path,
            { hash: file.hash, size: file.size },
          ]),
        ),
      },
    },
    `open an assets upload session for ${script}`,
  );
  const opened = resultOf<{ jwt?: string; buckets?: string[][] }>(session);
  if (!opened?.jwt) {
    throw new Error(`The assets upload session for ${script} carried no token`);
  }
  let completion: string | undefined =
    (opened.buckets ?? []).length === 0 ? opened.jwt : undefined;
  let sent = 0;
  const single = singleAssetUploadModeV1(opened.jwt);
  if (single) {
    // What the session asks for instead of the bulk form: each file raw, one
    // call each, typed as it will be served.
    for (const hash of (opened.buckets ?? []).flat()) {
      const file = byHash.get(hash);
      if (!file) {
        throw new Error(
          `The upload session asked for ${hash}, which the bundle does not hold`,
        );
      }
      const uploaded = await expectOk(
        api,
        {
          method: "POST",
          path: `${account}/workers/assets/upload/${hash}`,
          bytes: await files.read(file.archivePath),
          headers: { "content-type": file.contentType },
          bearer: opened.jwt,
        },
        `upload ${script}'s asset ${file.path}`,
      );
      completion = resultOf<{ jwt?: string }>(uploaded)?.jwt ?? completion;
      sent += 1;
    }
  }
  for (const bucket of single ? [] : (opened.buckets ?? [])) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) {
        throw new Error(
          `The upload session asked for ${hash}, which the bundle does not hold`,
        );
      }
      const bytes = await files.read(file.archivePath);
      form.append(
        hash,
        new File([base64V1(bytes)], hash, { type: file.contentType }),
        hash,
      );
      sent += 1;
    }
    const uploaded = await expectOk(
      api,
      {
        method: "POST",
        path: `${account}/workers/assets/upload?base64=true`,
        form,
        bearer: opened.jwt,
      },
      `upload ${script}'s assets`,
    );
    completion = resultOf<{ jwt?: string }>(uploaded)?.jwt ?? completion;
  }
  if (!completion) {
    throw new Error(
      `Uploading ${script}'s assets ended with no completion token`,
    );
  }
  say(`  assets     ${sent} of ${assets.files.length} files sent`);
  return completion;
}

/**
 * The namespace an upload just created for a container class. Wrangler retries
 * its own read of it too: the namespace can lag the upload by a moment.
 */
async function containerNamespaceV1(
  api: CloudflareApiV1,
  account: string,
  script: string,
  className: string,
): Promise<{ id: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
    const listed = await expectOk(
      api,
      {
        method: "GET",
        path: `${account}/workers/durable_objects/namespaces?per_page=1000`,
      },
      "list the account's Durable Object namespaces",
    );
    const found = (
      resultOf<{ id?: string; script?: string; class?: string }[]>(listed) ?? []
    ).find((entry) => entry.script === script && entry.class === className);
    if (found?.id) return { id: found.id };
  }
  throw new Error(
    `${script} was uploaded, and no ${className} namespace exists for its container`,
  );
}

interface ContainerApplicationV1 {
  id: string;
  name: string;
  max_instances?: number;
  configuration?: { image?: string; instance_type?: string };
  durable_objects?: { namespace_id?: string };
}

/**
 * Create the container application behind a Durable Object class, or roll it
 * forward to this release's image. The image is a public registry reference,
 * which Cloudflare pulls itself: nothing is pushed.
 */
async function ensureContainerV1(
  context: WorkerContextV1,
  script: string,
  container: DeployBundleManifestV1["workers"]["app"]["containers"][number],
): Promise<void> {
  const { api, account, install, say } = context;
  const name = installNameOfV1(container.name, install.name);
  const namespace = await containerNamespaceV1(
    api,
    account,
    script,
    container.className,
  );
  const configuration = {
    image: container.image,
    instance_type: container.instanceType,
    observability: { logs: { enabled: true } },
  };
  const listed = await expectOk(
    api,
    { method: "GET", path: `${account}/containers/applications` },
    "list the account's container applications",
  );
  const existing = (resultOf<ContainerApplicationV1[]>(listed) ?? []).find(
    (application) => application.name === name,
  );
  if (!existing) {
    await expectOk(
      api,
      {
        method: "POST",
        path: `${account}/containers/applications`,
        json: {
          name,
          scheduling_policy: "default",
          configuration,
          instances: 0,
          max_instances: container.maxInstances,
          constraints: { tiers: [1, 2] },
          durable_objects: { namespace_id: namespace.id },
          rollout_active_grace_period: 0,
        },
      },
      `create the container application ${name}`,
    );
    say(`  container  ${name} created (${container.image})`);
    return;
  }
  if (existing.durable_objects?.namespace_id !== namespace.id) {
    throw new Error(
      `The container application ${name} serves another Durable Object namespace; it is not this install's`,
    );
  }
  // The API may answer an instance type as its limits rather than its name,
  // so the name is compared only when it is there: a restart for nothing is
  // every running Computer and build cut off.
  const reportedType = existing.configuration?.instance_type;
  if (
    existing.configuration?.image === container.image &&
    (reportedType === undefined || reportedType === container.instanceType) &&
    existing.max_instances === container.maxInstances
  ) {
    say(`  container  ${name} already runs ${container.image}`);
    return;
  }
  await expectOk(
    api,
    {
      method: "PATCH",
      path: `${account}/containers/applications/${existing.id}`,
      json: { configuration, max_instances: container.maxInstances },
    },
    `update the container application ${name}`,
  );
  await expectOk(
    api,
    {
      method: "POST",
      path: `${account}/containers/applications/${existing.id}/rollouts`,
      json: {
        description: `FrockBot ${context.manifest.version}`,
        strategy: "rolling",
        target_configuration: configuration,
        step_percentage: 100,
        kind: "full_auto",
      },
    },
    `roll ${name} out to ${container.image}`,
  );
  say(`  container  ${name} rolled out to ${container.image}`);
}

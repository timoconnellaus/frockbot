/**
 * A Cloudflare account in memory, answering the REST calls the deploy page and
 * the bundle's deployer make, a GitHub release beside it carrying a deploy
 * bundle, and an R2 bucket to stage it in. Enough to run a deploy and an
 * update end to end in `bun test` and read back what they left.
 */
import {
  bundleAssetNamesV1,
  sha256HexV1,
  type BundleWorkerKeyV1,
  type BundleWorkerV1,
  type DeployBundleManifestV1,
} from "../../../cloudflare/deployment-config/bundle.ts";
import { CLOUDFLARE_API_V1 } from "./cloudflare-api";
import { RELEASE_REPOSITORY_V1, type StagingBucketV1 } from "./release";

export interface FakeScriptV1 {
  metadata: Record<string, unknown>;
  secrets: Record<string, string>;
  migrationTag?: string;
  workersDev: boolean;
  uploads: number;
}

type Json = Record<string, any>;

export class FakeCloudflareV1 {
  accountId = "a".repeat(32);
  accountName = "Tim’s Account";
  subdomain: string | null = "tim-oconnell";
  workersPaid = true;
  r2Enabled = true;
  zeroTrust = true;
  organization: { name: string; auth_domain: string } | null = {
    name: "Tim",
    auth_domain: "tim.cloudflareaccess.com",
  };
  aiModels = ["typesafe/jev", "@cf/meta/llama-3.1-8b-instruct"];
  buckets = new Set<string>();
  objects = new Map<string, number>();
  indexes = new Map<string, unknown>();
  accessApps: {
    id: string;
    aud: string;
    name: string;
    domain: string;
    policies: unknown;
  }[] = [];
  scripts = new Map<string, FakeScriptV1>();
  namespaces: { id: string; script: string; class: string }[] = [];
  containers: Json[] = [];
  deletedScripts: string[] = [];
  assetHashes = new Set<string>();
  releases = new Map<string, Record<string, Uint8Array>>();
  /** What `https://<install>/` answers: guarded by Access unless told otherwise. */
  installAnswers: "guarded" | "open" | "down" = "guarded";
  calls: string[] = [];
  downloads: string[] = [];

  private ok(result: unknown, status = 200): Response {
    return Response.json({ success: true, errors: [], result }, { status });
  }

  private error(status: number, code: number, message: string): Response {
    return Response.json(
      { success: false, errors: [{ code, message }], result: null },
      { status },
    );
  }

  publish(version: string, files: Record<string, Uint8Array>) {
    this.releases.set(version, files);
  }

  fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.github.com") return this.github();
    if (url.hostname === "github.com") return this.download(url);
    if (url.hostname.endsWith(".workers.dev")) return this.install(url);
    if (!request.url.startsWith(CLOUDFLARE_API_V1)) {
      throw new Error(`Unexpected fetch ${request.url}`);
    }
    const path = url.pathname.replace("/client/v4", "");
    this.calls.push(`${request.method} ${path}`);
    return this.api(request, path, url);
  };

  private github(): Response {
    return Response.json(
      [...this.releases.entries()].map(([version, files]) => ({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: Object.keys(files).map((name) => ({ name })),
      })),
    );
  }

  private download(url: URL): Response {
    const match = url.pathname.match(
      new RegExp(`^/${RELEASE_REPOSITORY_V1}/releases/download/v([^/]+)/(.+)$`),
    );
    const name = match ? decodeURIComponent(match[2]!) : "";
    const file = match && this.releases.get(match[1]!)?.[name];
    if (file) this.downloads.push(name);
    return file
      ? new Response(file as Uint8Array<ArrayBuffer>)
      : new Response("Not Found", { status: 404 });
  }

  private install(url: URL): Response {
    const name = url.hostname.split(".")[0]!;
    const script = this.scripts.get(name);
    if (this.installAnswers === "down" || !script?.workersDev) {
      return new Response("There is nothing here yet", { status: 404 });
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (this.installAnswers === "open") {
      return new Response("<!doctype html>", { status: 200 });
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: `https://${this.organization?.auth_domain}/cdn-cgi/access/login/${url.hostname}`,
      },
    });
  }

  private async api(
    request: Request,
    path: string,
    url: URL,
  ): Promise<Response> {
    const a = `/accounts/${this.accountId}`;
    const method = request.method;
    const body = async () => (await request.json()) as Json;
    let m: RegExpMatchArray | null;

    if (path === "/user") {
      return this.ok({ id: "user-1", email: "tim@example.com" });
    }
    if (path === "/accounts") {
      return this.ok([{ id: this.accountId, name: this.accountName }]);
    }
    if (path === `${a}/workers/subdomain`) {
      if (method === "PUT") {
        this.subdomain = (await body()).subdomain;
        return this.ok({ subdomain: this.subdomain });
      }
      return this.subdomain
        ? this.ok({ subdomain: this.subdomain })
        : this.error(404, 10007, "This account has no workers.dev subdomain");
    }
    if (path === `${a}/access/organizations`) {
      if (!this.zeroTrust) {
        return this.error(403, 9999, "Zero Trust is not enabled");
      }
      if (method === "POST") {
        const input = await body();
        this.organization = {
          name: input.name,
          auth_domain: input.auth_domain,
        };
        return this.ok(this.organization);
      }
      return this.organization
        ? this.ok(this.organization)
        : this.error(404, 12130, "not found");
    }
    if (path === `${a}/gateway`) {
      return this.zeroTrust
        ? this.ok({ id: "gw" })
        : this.error(400, 2001, "No Zero Trust account");
    }
    if (path === `${a}/access/apps`) {
      if (method === "POST") {
        const input = await body();
        const app = {
          id: `app-${this.accessApps.length + 1}`,
          aud: await sha256HexV1(input.domain),
          name: input.name,
          domain: input.domain,
          policies: input.policies,
        };
        this.accessApps.push(app);
        return this.ok(app);
      }
      return this.ok(this.accessApps);
    }
    if ((m = path.match(new RegExp(`^${a}/access/apps/([^/]+)$`)))) {
      const found = this.accessApps.find((x) => x.id === m![1])!;
      Object.assign(found, await body());
      return this.ok(found);
    }
    if (path === `${a}/r2/buckets`) {
      if (!this.r2Enabled) {
        return this.error(
          403,
          10042,
          "Please enable R2 through the Cloudflare Dashboard.",
        );
      }
      if (method === "POST") {
        this.buckets.add((await body()).name);
        return this.ok({});
      }
      return this.ok({ buckets: [...this.buckets].map((name) => ({ name })) });
    }
    if (
      (m = path.match(new RegExp(`^${a}/r2/buckets/([^/]+)/objects/(.+)$`)))
    ) {
      if (!this.buckets.has(m[1]!)) return this.error(404, 10006, "no bucket");
      this.objects.set(
        `${m[1]}/${decodeURIComponent(m[2]!)}`,
        (await request.arrayBuffer()).byteLength,
      );
      return this.ok({});
    }
    if ((m = path.match(new RegExp(`^${a}/r2/buckets/([^/]+)$`)))) {
      return this.buckets.has(m[1]!)
        ? this.ok({ name: m[1] })
        : this.error(404, 10006, "no bucket");
    }
    if (path === `${a}/vectorize/v2/indexes`) {
      const input = await body();
      this.indexes.set(input.name, input.config);
      return this.ok(input);
    }
    if ((m = path.match(new RegExp(`^${a}/vectorize/v2/indexes/([^/]+)$`)))) {
      return this.indexes.has(m[1]!)
        ? this.ok({ name: m[1] })
        : this.error(404, 3000, "not found");
    }
    if (path === `${a}/workers/scripts`) {
      return this.ok(
        [...this.scripts.entries()].map(([id, s]) => ({
          id,
          ...(s.migrationTag ? { migration_tag: s.migrationTag } : {}),
        })),
      );
    }
    if ((m = path.match(new RegExp(`^${a}/workers/services/([^/]+)$`)))) {
      const script = this.scripts.get(m[1]!);
      return script
        ? this.ok({
            default_environment: {
              script: { migration_tag: script.migrationTag ?? null },
            },
          })
        : this.error(404, 10090, "no such service");
    }
    if (path === `${a}/workers/durable_objects/namespaces`) {
      return this.ok(this.namespaces);
    }
    if (
      (m = path.match(
        new RegExp(`^${a}/workers/scripts/([^/]+)/assets-upload-session$`),
      ))
    ) {
      const manifest = (await body()).manifest as Record<
        string,
        { hash: string }
      >;
      const needed = Object.values(manifest)
        .map((f) => f.hash)
        .filter((h) => !this.assetHashes.has(h));
      return this.ok({
        jwt: needed.length ? "upload-jwt" : "complete-jwt",
        buckets: needed.length ? [needed] : [],
      });
    }
    if (path === `${a}/workers/assets/upload`) {
      const form = await request.formData();
      for (const key of form.keys()) this.assetHashes.add(key);
      return this.ok({ jwt: "complete-jwt" }, 201);
    }
    if (
      (m = path.match(new RegExp(`^${a}/workers/scripts/([^/]+)/secrets$`)))
    ) {
      const script = this.scripts.get(m[1]!);
      if (!script) return this.error(404, 10007, "no such script");
      return this.ok(
        Object.keys(script.secrets).map((name) => ({
          name,
          type: "secret_text",
        })),
      );
    }
    if (
      (m = path.match(new RegExp(`^${a}/workers/scripts/([^/]+)/subdomain$`)))
    ) {
      const script = this.scripts.get(m[1]!);
      if (!script) return this.error(404, 10007, "no such script");
      script.workersDev = (await body()).enabled === true;
      return this.ok({ enabled: script.workersDev });
    }
    if (
      (m = path.match(
        new RegExp(`^${a}/workers/scripts/([^/]+)/domains/records$`),
      ))
    ) {
      return this.error(400, 100117, "this fake install has no zone");
    }
    if ((m = path.match(new RegExp(`^${a}/workers/scripts/([^/]+)$`)))) {
      if (method === "DELETE") {
        this.scripts.delete(m[1]!);
        this.deletedScripts.push(m[1]!);
        return this.ok(null);
      }
      return this.upload(m[1]!, await request.formData());
    }
    if (path === `${a}/containers/applications`) {
      if (method === "POST") {
        this.containers.push({
          ...(await body()),
          id: `c-${this.containers.length}`,
        });
        return this.ok({}, 201);
      }
      return this.ok(this.containers);
    }
    if (
      (m = path.match(new RegExp(`^${a}/containers/applications/([^/]+)$`)))
    ) {
      Object.assign(
        this.containers.find((c) => c.id === m![1])!,
        await body(),
      );
      return this.ok({});
    }
    if (
      path.match(new RegExp(`^${a}/containers/applications/[^/]+/rollouts$`))
    ) {
      return this.ok({}, 201);
    }
    if (path.startsWith(`${a}/ai/models/search`)) {
      const search = url.searchParams.get("search");
      return this.ok(
        this.aiModels
          .filter((m) => !search || m.includes(search))
          .map((name) => ({ name })),
      );
    }
    return this.error(404, 7003, `No route for ${method} ${path}`);
  }

  private async upload(name: string, form: FormData): Promise<Response> {
    const raw = form.get("metadata") as unknown as Blob | string;
    const metadata = JSON.parse(
      typeof raw === "string" ? raw : await raw.text(),
    ) as Json;
    const bindings = metadata.bindings as {
      type: string;
      name: string;
      text?: string;
    }[];
    if (!this.workersPaid && bindings.some((b) => b.type === "worker_loader")) {
      return this.error(
        400,
        10195,
        "Dynamic Workers require a Workers Paid plan subscription",
      );
    }
    const previous = this.scripts.get(name);
    const migrations = metadata.migrations as
      { old_tag?: string; new_tag: string; steps: Json[] } | undefined;
    if (migrations && migrations.old_tag !== previous?.migrationTag) {
      return this.error(400, 10079, "migration old_tag does not match");
    }
    for (const step of migrations?.steps ?? []) {
      for (const className of step.new_sqlite_classes ?? []) {
        this.namespaces.push({
          id: `ns-${name}-${className}`,
          script: name,
          class: className,
        });
      }
    }
    const secrets: Record<string, string> = {};
    for (const binding of bindings) {
      if (binding.type === "secret_text") secrets[binding.name] = binding.text!;
    }
    const kept = (metadata.keep_bindings as string[] | undefined)?.includes(
      "secret_text",
    )
      ? (previous?.secrets ?? {})
      : {};
    this.scripts.set(name, {
      metadata,
      secrets: { ...kept, ...secrets },
      ...(migrations
        ? { migrationTag: migrations.new_tag }
        : previous?.migrationTag
          ? { migrationTag: previous.migrationTag }
          : {}),
      workersDev: previous?.workersDev ?? false,
      uploads: (previous?.uploads ?? 0) + 1,
    });
    return this.ok({ id: name });
  }
}

/** An R2 bucket in memory, as staging uses it. */
export class MemoryBucketV1 implements StagingBucketV1 {
  readonly objects = new Map<string, Uint8Array>();
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes
      ? { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }
      : null;
  }
  async put(key: string, value: Uint8Array | string) {
    this.objects.set(
      key,
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value.slice(),
    );
    return {};
  }
}

/** Bun has no `DigestStream`; this collects the bytes and hashes them at the end. */
export function bufferedDigestSinkV1() {
  const chunks: Uint8Array[] = [];
  let resolve!: (digest: ArrayBuffer) => void;
  const digest = new Promise<ArrayBuffer>((r) => (resolve = r));
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
    async close() {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      resolve(await crypto.subtle.digest("SHA-256", all));
    },
  });
  return { writable, digest };
}

/** A GNU tar of these files, gzipped: a release archive in miniature. */
export async function tarGzV1(
  files: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const header = (name: string, size: number, type: string) => {
    const block = new Uint8Array(512);
    block.set(encoder.encode(name.slice(0, 100)), 0);
    block.set(encoder.encode("0000644\0"), 100);
    block.set(encoder.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    block[156] = type.charCodeAt(0);
    block.set(encoder.encode("ustar  \0"), 257);
    return block;
  };
  const padded = (bytes: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    out.set(bytes);
    return out;
  };
  for (const [path, bytes] of Object.entries(files)) {
    const name = `./${path}`;
    if (name.length > 100) {
      const long = encoder.encode(`${name}\0`);
      blocks.push(header("././@LongLink", long.length, "L"), padded(long));
    }
    blocks.push(header(name, bytes.length, "0"), padded(bytes));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Blob(blocks as Uint8Array<ArrayBuffer>[]);
  return new Uint8Array(
    await new Response(
      tar.stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}

export interface TestBundleOptionsV1 {
  readonly version: string;
  /** The app's Durable Object history, in order. */
  readonly appMigrations: readonly string[];
  readonly client?: Record<string, string>;
  readonly installVars?: readonly string[];
}

/**
 * A deploy bundle shaped as `build-deploy-bundle.ts` writes one: the app with
 * a Durable Object per migration, assets and minted secrets; the build
 * service with its container and the token it shares with the app; and the
 * optional Computer host. Published to the fake's GitHub.
 */
export async function publishTestBundleV1(
  cf: FakeCloudflareV1,
  options: TestBundleOptionsV1,
): Promise<DeployBundleManifestV1> {
  const encoder = new TextEncoder();
  const archive: Record<string, Uint8Array> = {};
  const module = async (key: BundleWorkerKeyV1) => {
    const path = `workers/${key}/index.js`;
    const bytes = encoder.encode(
      `export default {} // ${key} ${options.version}`,
    );
    archive[path] = bytes;
    return {
      name: "index.js",
      type: "esm" as const,
      path,
      sha256: await sha256HexV1(bytes),
      size: bytes.length,
    };
  };
  const client = options.client ?? { "index.html": "<!doctype html>" };
  const assets = [];
  for (const [path, text] of Object.entries(client)) {
    const archivePath = `assets/app/${"deep/".repeat(path === "index.html" ? 0 : 20)}${path}`;
    archive[archivePath] = encoder.encode(text);
    assets.push({
      path: `/${path}`,
      archivePath,
      hash: (await sha256HexV1(text)).slice(0, 32),
      size: text.length,
      contentType: "text/html",
    });
  }
  const artifact = encoder.encode("export const application = 1;");
  archive["application-artifact.mjs"] = artifact;
  const artifactSha = await sha256HexV1(artifact);

  const base = {
    optional: false,
    contentHash: "0".repeat(64),
    mainModule: "index.js",
    compatibilityDate: "2026-08-27",
    compatibilityFlags: ["nodejs_compat"],
    installVars: [] as string[],
    containers: [],
    workersDev: false,
    customDomains: false,
  };
  const classes = options.appMigrations.map(
    (tag) => `Class${tag.toUpperCase()}`,
  );
  const app: BundleWorkerV1 = {
    ...base,
    name: "{install}",
    modules: [await module("app")],
    bindings: [
      { type: "ai", name: "AI" },
      { type: "worker_loader", name: "USER_APPLICATIONS" },
      {
        type: "r2_bucket",
        name: "MEMORY_FILES",
        bucket_name: "{install}-memory-files",
      },
      {
        type: "vectorize",
        name: "MEMORY_INDEX",
        index_name: "{install}-memory",
      },
      {
        type: "service",
        name: "APPLET_BUILD",
        service: "{install}-applet-build",
      },
      {
        type: "service",
        name: "COMPUTER_HOST",
        service: "{install}-computer-host",
      },
      ...classes.map((className) => ({
        type: "durable_object_namespace",
        name: className.toUpperCase(),
        class_name: className,
      })),
    ],
    installVars: [
      ...(options.installVars ?? ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]),
    ],
    secrets: [
      {
        name: "APPLET_BUILD_TOKEN",
        required: true,
        mint: "hex",
        sharedWith: ["appletBuild"],
      },
      {
        name: "COMPUTER_HOST_TOKEN",
        required: true,
        mint: "hex",
        sharedWith: ["computerHost"],
        requiredWith: "computerHost",
      },
      { name: "CREDENTIAL_KEYRING", required: true, mint: "keyring" },
      { name: "FROCKBOT_ADMIN_EMAILS", required: false },
      { name: "SPRITES_TOKEN", required: true, requiredWith: "computerHost" },
      { name: "WEB_PUSH_VAPID_KEYS", required: true, mint: "vapid" },
    ],
    migrations: options.appMigrations.map((tag, i) => ({
      tag,
      new_sqlite_classes: [classes[i]!],
    })),
    assets: {
      config: { html_handling: "none", not_found_handling: "none" },
      files: assets,
    },
    customDomains: true,
  };
  const appletBuild: BundleWorkerV1 = {
    ...base,
    name: "{install}-applet-build",
    modules: [await module("appletBuild")],
    bindings: [
      {
        type: "durable_object_namespace",
        name: "BUILDER",
        class_name: "AppletBuildContainer",
      },
    ],
    secrets: [
      {
        name: "APPLET_BUILD_TOKEN",
        required: true,
        mint: "hex",
        sharedWith: ["app"],
      },
    ],
    migrations: [{ tag: "v1", new_sqlite_classes: ["AppletBuildContainer"] }],
    containers: [
      {
        className: "AppletBuildContainer",
        name: "{install}-applet-build-appletbuildcontainer",
        image: `docker.io/timoconnellaus/frockbot-applet-build:${options.version}`,
        instanceType: "standard",
        maxInstances: 2,
      },
    ],
  };
  const computerHost: BundleWorkerV1 = {
    ...base,
    name: "{install}-computer-host",
    optional: true,
    modules: [await module("computerHost")],
    bindings: [],
    secrets: [],
    migrations: [],
  };
  const names = bundleAssetNamesV1(options.version);
  const tarball = await tarGzV1(archive);
  const manifest: DeployBundleManifestV1 = {
    schemaVersion: 1,
    kind: "frockbot-deploy-bundle",
    version: options.version,
    profile: "simple",
    protocol: { min: 1, max: 1 },
    archive: { file: names.archive, sha256: await sha256HexV1(tarball) },
    install: { token: "{install}", pattern: "^[a-z0-9][a-z0-9-]{0,40}$" },
    resources: {
      r2Buckets: ["{install}-application-artifacts", "{install}-memory-files"],
      vectorizeIndexes: [
        { name: "{install}-memory", dimensions: 768, metric: "cosine" },
      ],
    },
    applicationArtifact: {
      path: "application-artifact.mjs",
      sha256: artifactSha,
      bucket: "{install}-application-artifacts",
      key: `applications/${artifactSha}.mjs`,
    },
    workers: { app, computerHost, appletBuild },
  } as DeployBundleManifestV1;
  cf.publish(options.version, {
    [names.manifest]: encoder.encode(JSON.stringify(manifest)),
    [names.archive]: tarball,
  });
  return manifest;
}

/**
 * A Cloudflare account in memory, answering the REST calls the deploy makes,
 * and a GitHub release beside it. Enough to run a deploy and an update end to
 * end in `bun test` and read back what they left in the account.
 */
import { CLOUDFLARE_API_V1 } from "./cloudflare-api";
import { RELEASE_REPOSITORY_V1, releaseManifestAssetV1 } from "./manifest";
import { sha256HexV1 } from "./release";

export interface FakeScriptV1 {
  metadata: Record<string, unknown>;
  modules: Record<string, string>;
  secrets: Record<string, string>;
  migrationTag?: string;
  workersDev: boolean;
  uploads: number;
}

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
  kv = new Map<string, string>();
  d1 = new Map<
    string,
    { id: string; migrations: string[]; statements: string[] }
  >();
  indexes = new Map<string, unknown>();
  queues = new Set<string>();
  accessApps: {
    id: string;
    aud: string;
    name: string;
    domain: string;
    policies: unknown;
  }[] = [];
  scripts = new Map<string, FakeScriptV1>();
  deletedScripts: string[] = [];
  assetHashes = new Set<string>();
  releases = new Map<string, Record<string, Uint8Array<ArrayBuffer>>>();
  /** What `https://<install>/` answers: guarded by Access unless told otherwise. */
  installAnswers: "guarded" | "open" | "down" = "guarded";
  calls: string[] = [];

  private ok(result: unknown, status = 200): Response {
    return Response.json({ success: true, errors: [], result }, { status });
  }

  private error(status: number, code: number, message: string): Response {
    return Response.json(
      { success: false, errors: [{ code, message }], result: null },
      { status },
    );
  }

  async publish(
    version: string,
    files: Record<string, Uint8Array<ArrayBuffer>>,
    manifest: unknown,
  ) {
    this.releases.set(version, {
      ...files,
      [releaseManifestAssetV1(version)]: new TextEncoder().encode(
        JSON.stringify(manifest),
      ),
    });
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
    if (!request.url.startsWith(CLOUDFLARE_API_V1))
      throw new Error(`Unexpected fetch ${request.url}`);
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
    const file =
      match && this.releases.get(match[1]!)?.[decodeURIComponent(match[2]!)];
    return file
      ? new Response(file)
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
    if (this.installAnswers === "open")
      return new Response("<!doctype html>", { status: 200 });
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
    const body = async () => (await request.json()) as Record<string, any>;

    if (path === "/user")
      return this.ok({ id: "user-1", email: "tim@example.com" });
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
      if (!this.zeroTrust)
        return this.error(
          403,
          9999,
          "Zero Trust is not enabled for this account",
        );
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
          aud: await sha256HexV1(new TextEncoder().encode(input.domain)),
          name: input.name,
          domain: input.domain,
          policies: input.policies,
        };
        this.accessApps.push(app);
        return this.ok(app);
      }
      return this.ok(this.accessApps);
    }
    const app = path.match(new RegExp(`^${a}/access/apps/([^/]+)$`));
    if (app && method === "PUT") {
      const found = this.accessApps.find((x) => x.id === app[1])!;
      Object.assign(found, await body());
      return this.ok(found);
    }
    if (path === `${a}/r2/buckets`) {
      if (!this.r2Enabled)
        return this.error(
          403,
          10042,
          "Please enable R2 through the Cloudflare Dashboard.",
        );
      if (method === "POST") {
        this.buckets.add((await body()).name);
        return this.ok({});
      }
      return this.ok({ buckets: [...this.buckets].map((name) => ({ name })) });
    }
    const object = path.match(
      new RegExp(`^${a}/r2/buckets/([^/]+)/objects/(.+)$`),
    );
    if (object) {
      if (!this.buckets.has(object[1]!))
        return this.error(404, 10006, "no such bucket");
      this.objects.set(
        `${object[1]}/${decodeURIComponent(object[2]!)}`,
        (await request.arrayBuffer()).byteLength,
      );
      return this.ok({});
    }
    const bucket = path.match(new RegExp(`^${a}/r2/buckets/([^/]+)$`));
    if (bucket) {
      return this.buckets.has(bucket[1]!)
        ? this.ok({ name: bucket[1] })
        : this.error(404, 10006, "no such bucket");
    }
    if (path === `${a}/storage/kv/namespaces`) {
      if (method === "POST") {
        const id = `kv-${this.kv.size + 1}`;
        this.kv.set(id, (await body()).title);
        return this.ok({ id });
      }
      return this.ok(
        [...this.kv.entries()].map(([id, title]) => ({ id, title })),
      );
    }
    if (path === `${a}/d1/database`) {
      if (method === "POST") {
        const name = (await body()).name;
        const id = `d1-${this.d1.size + 1}`;
        this.d1.set(name, { id, migrations: [], statements: [] });
        return this.ok({ uuid: id, name });
      }
      const name = url.searchParams.get("name");
      return this.ok(
        [...this.d1.entries()]
          .filter(([n]) => !name || n === name)
          .map(([n, db]) => ({ uuid: db.id, name: n })),
      );
    }
    const query = path.match(new RegExp(`^${a}/d1/database/([^/]+)/query$`));
    if (query) {
      const db = [...this.d1.values()].find((d) => d.id === query[1])!;
      const { sql } = (await body()) as { sql: string };
      db.statements.push(sql);
      if (sql.startsWith("SELECT name FROM d1_migrations")) {
        return this.ok([{ results: db.migrations.map((name) => ({ name })) }]);
      }
      for (const match of sql.matchAll(
        /INSERT INTO d1_migrations \(name\) VALUES \('([^']*)'\)/g,
      )) {
        db.migrations.push(match[1]!);
      }
      return this.ok([{ results: [] }]);
    }
    if (path === `${a}/vectorize/v2/indexes`) {
      const input = await body();
      this.indexes.set(input.name, input.config);
      return this.ok(input);
    }
    const index = path.match(new RegExp(`^${a}/vectorize/v2/indexes/([^/]+)$`));
    if (index) {
      return this.indexes.has(index[1]!)
        ? this.ok({ name: index[1] })
        : this.error(404, 3000, "not found");
    }
    if (path === `${a}/queues`) {
      if (method === "POST") {
        const name = (await body()).queue_name;
        this.queues.add(name);
        return this.ok({ queue_id: `q-${name}` });
      }
      return this.ok(
        [...this.queues].map((q) => ({ queue_id: `q-${q}`, queue_name: q })),
      );
    }
    if (path === `${a}/workers/scripts`) {
      return this.ok(
        [...this.scripts.entries()].map(([id, s]) => ({
          id,
          ...(s.migrationTag ? { migration_tag: s.migrationTag } : {}),
        })),
      );
    }
    const session = path.match(
      new RegExp(`^${a}/workers/scripts/([^/]+)/assets-upload-session$`),
    );
    if (session) {
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
      if (request.headers.get("authorization") !== "Bearer upload-jwt")
        return this.error(401, 10000, "bad jwt");
      const form = await request.formData();
      for (const key of form.keys()) this.assetHashes.add(key);
      return this.ok({ jwt: "complete-jwt" }, 201);
    }
    const secrets = path.match(
      new RegExp(`^${a}/workers/scripts/([^/]+)/secrets$`),
    );
    if (secrets) {
      const script = this.scripts.get(secrets[1]!);
      if (!script) return this.error(404, 10007, "no such script");
      return this.ok(
        Object.keys(script.secrets).map((name) => ({
          name,
          type: "secret_text",
        })),
      );
    }
    const subdomain = path.match(
      new RegExp(`^${a}/workers/scripts/([^/]+)/subdomain$`),
    );
    if (subdomain) {
      const script = this.scripts.get(subdomain[1]!);
      if (!script) return this.error(404, 10007, "no such script");
      script.workersDev = (await body()).enabled === true;
      return this.ok({ enabled: script.workersDev });
    }
    const script = path.match(new RegExp(`^${a}/workers/scripts/([^/]+)$`));
    if (script && method === "DELETE") {
      this.scripts.delete(script[1]!);
      this.deletedScripts.push(script[1]!);
      return this.ok(null);
    }
    if (script && method === "PUT")
      return this.upload(script[1]!, await request.formData());
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
    const metadata = JSON.parse(
      await (form.get("metadata") as File).text(),
    ) as Record<string, any>;
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
      { old_tag?: string; new_tag: string } | undefined;
    if (migrations && migrations.old_tag !== previous?.migrationTag) {
      return this.error(
        400,
        10079,
        "migration old_tag does not match the script's current tag",
      );
    }
    if (
      !migrations &&
      previous === undefined &&
      bindings.some((b) => b.type === "durable_object_namespace")
    ) {
      return this.error(
        400,
        10074,
        "new Durable Object classes need a migration",
      );
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
    const modules: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      // Every part the deployer sends is a file; the types say a string may be too.
      const part = value as unknown as Blob;
      if (key !== "metadata") modules[key] = await part.text();
    }
    this.scripts.set(name, {
      metadata,
      modules,
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

/** A stored (uncompressed) zip of these files: what the web client archive is, in miniature. */
export function storedZipV1(
  files: Record<string, string>,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

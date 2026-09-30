/**
 * Deploy bundles: the manifest a release publishes, the gate that keeps an
 * update on the same namespaces, and the API deploy the deploy page repeats.
 *
 * The bundle's identity — Worker names, resource names, Durable Object classes,
 * migration tags, container applications — is held against
 * `fixtures/bundle/identity.json` the way the hosted configs are held against
 * `fixtures/hosted/`: when it legitimately changes, the fixture changes in the
 * same commit, and `bundleSuccessionProblemsV1` says whether an install of the
 * previous release survives it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_WORKERS_V1,
  bundleSuccessionProblemsV1,
  bundleWorkerShapeV1,
  installIdentityV1,
  installSuccessionProblemsV1,
  liveClassesV1,
  migrationUploadV1,
  missingSecretsV1,
  workerContentHashV1,
  workerUploadMetadataV1,
  type BundleWorkerKeyV1,
  type BundleWorkerV1,
  type DeployBundleManifestV1,
  type InstallV1,
} from "../apps/cloudflare/deployment-config/bundle.ts";
import {
  deployBundleV1,
  type CloudflareApiV1,
  type CloudflareRequestV1,
} from "../apps/cloudflare/deployment-config/deploy.ts";
import {
  generateProfileConfigsV1,
  resourceNamesV1,
} from "../apps/cloudflare/deployment-config/generate.ts";
import {
  assetContentTypeV1,
  assetHashV1,
  bundleConfigsV1,
  bundleWorkerSecretsV1,
} from "./build-deploy-bundle.ts";
import { REPO_ROOT_V1 } from "./deployment-config/repository.ts";
import { converseV1 } from "./deploy-bundle/local.ts";
import { simpleProfileV1 } from "./setup/plan.ts";

const VERSION = "1.2.3";
const ARTIFACT_SHA = "a".repeat(64);

/** A manifest as the build writes one, with stand-in modules and assets. */
async function manifestV1(version = VERSION): Promise<DeployBundleManifestV1> {
  const generated = bundleConfigsV1(
    version,
    ARTIFACT_SHA,
    mkdtempSync(join(tmpdir(), "bundle-test-")),
  );
  const workers = {} as Record<BundleWorkerKeyV1, BundleWorkerV1>;
  for (const entry of generated) {
    const key = entry.worker as BundleWorkerKeyV1;
    const worker: Omit<BundleWorkerV1, "contentHash"> = {
      ...bundleWorkerShapeV1(key, entry.config),
      mainModule: "index.js",
      modules: [
        {
          name: "index.js",
          type: "esm",
          path: `workers/${key}/index.js`,
          sha256: await sha256(`export default {} // ${key}`),
          size: 1,
        },
      ],
      secrets: bundleWorkerSecretsV1(key),
      ...(key === "app"
        ? {
            assets: {
              config: { html_handling: "none", not_found_handling: "none" },
              files: [
                {
                  path: "/index.html",
                  archivePath: "assets/app/index.html",
                  hash: "b".repeat(32),
                  size: 5,
                  contentType: "text/html",
                },
              ],
            },
          }
        : {}),
    };
    workers[key] = {
      ...worker,
      contentHash: await workerContentHashV1(worker),
    };
  }
  const resources = resourceNamesV1(simpleProfileV1(answers("{install}")));
  return {
    schemaVersion: 1,
    kind: "frockbot-deploy-bundle",
    version,
    profile: "simple",
    protocol: { min: 2, max: 4 },
    archive: {
      file: `frockbot-deploy-${version}.tar.gz`,
      sha256: "c".repeat(64),
    },
    install: { token: "{install}", pattern: "^[a-z][a-z0-9-]{0,30}[a-z0-9]$" },
    resources: {
      r2Buckets: [
        resources.applicationArtifactsBucket,
        resources.memoryFilesBucket,
      ],
      vectorizeIndexes: [
        { name: resources.memoryIndex, dimensions: 768, metric: "cosine" },
      ],
    },
    applicationArtifact: {
      path: "application-artifact.mjs",
      sha256: await sha256("artifact"),
      bucket: resources.applicationArtifactsBucket,
      key: `applications/${ARTIFACT_SHA}.mjs`,
    },
    workers,
  };
}

function answers(prefix: string) {
  return {
    prefix,
    accountId: "1".repeat(32),
    appHostname: "bot.example.com",
    adminEmails: ["owner@example.com"],
    accessTeamDomain: "team.cloudflareaccess.com",
    imageTag: VERSION,
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function install(overrides: Partial<InstallV1> = {}): InstallV1 {
  return {
    accountId: "1".repeat(32),
    name: "acme",
    hostnames: ["bot.example.com"],
    computerHost: true,
    vars: {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "d".repeat(64),
    },
    secrets: {
      CREDENTIAL_KEYRING: "{}",
      COMPUTER_HOST_TOKEN: "t",
      APPLET_BUILD_TOKEN: "t",
      ROUTINE_HOOK_SECRET: "t",
      MACHINE_TOKEN_SECRET: "t",
      NATIVE_TOKEN_SECRET: "t",
      WEB_PUSH_VAPID_KEYS: "t",
      SPRITES_TOKEN: "t",
    },
    ...overrides,
  };
}

/** Everything in a manifest that names a namespace an install owns. */
function identityOf(manifest: DeployBundleManifestV1) {
  return Object.fromEntries(
    BUNDLE_WORKERS_V1.map((key) => {
      const worker = manifest.workers[key];
      return [
        key,
        {
          name: worker.name,
          durableObjects: worker.bindings
            .filter((binding) => binding.type === "durable_object_namespace")
            .map((binding) => `${binding.name}:${String(binding.class_name)}`),
          stores: worker.bindings
            .filter((binding) =>
              [
                "r2_bucket",
                "vectorize",
                "analytics_engine",
                "service",
              ].includes(binding.type),
            )
            .map(
              (binding) =>
                `${binding.name}:${String(binding.bucket_name ?? binding.index_name ?? binding.dataset ?? binding.service)}`,
            ),
          migrations: worker.migrations.map((migration) => migration.tag),
          containers: worker.containers.map((container) => container.name),
        },
      ];
    }),
  );
}

describe("the bundle's identity", () => {
  test("is the fixture: a change to it is a change somebody sees", async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "deployment-config/fixtures/bundle/identity.json",
        ),
        "utf8",
      ),
    );
    expect(identityOf(await manifestV1())).toEqual(fixture);
  });

  test("names every install exactly as the generator names that prefix", async () => {
    const manifest = await manifestV1();
    const identity = installIdentityV1(manifest, "acme");
    const generated = generateProfileConfigsV1({
      profile: simpleProfileV1(answers("acme")),
      profileDirectory: REPO_ROOT_V1,
      outputRoot: mkdtempSync(join(tmpdir(), "bundle-test-")),
    });
    for (const entry of generated) {
      expect(identity.workers[entry.worker as BundleWorkerKeyV1]).toBe(
        entry.config.name as string,
      );
    }
    const resources = resourceNamesV1(simpleProfileV1(answers("acme")));
    expect(identity.r2Buckets).toEqual([
      resources.applicationArtifactsBucket,
      resources.memoryFilesBucket,
    ]);
    expect(identity.vectorizeIndexes).toEqual([resources.memoryIndex]);
    // The container applications wrangler would have named for those scripts.
    expect(identity.containers).toEqual([
      "acme-computer-host-flyhostcontainer",
      "acme-applet-build-appletbuildcontainer",
    ]);
  });

  test("every bound class is live after the bundle's own migrations", async () => {
    const manifest = await manifestV1();
    for (const key of BUNDLE_WORKERS_V1) {
      const live = liveClassesV1(manifest.workers[key].migrations);
      for (const binding of manifest.workers[key].bindings) {
        if (binding.type === "durable_object_namespace") {
          expect(live.has(String(binding.class_name))).toBe(true);
        }
      }
    }
  });

  test("the install supplies the Access vars; nothing else in it is install-specific", async () => {
    const manifest = await manifestV1();
    expect(manifest.workers.app.installVars).toEqual([
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_AUD",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("zzfrockbotinstallzz");
    expect(JSON.stringify(manifest)).not.toContain("bundle.invalid");
  });

  test("pulls the release's published images", async () => {
    const manifest = await manifestV1();
    expect(manifest.workers.computerHost.containers[0]!.image).toBe(
      `docker.io/timoconnellaus/frockbot-computer-host:${VERSION}`,
    );
    expect(manifest.workers.appletBuild.containers[0]!.instanceType).toBe(
      "standard-1",
    );
  });

  test("refuses a config key it does not know how to deploy", () => {
    expect(() =>
      bundleWorkerShapeV1("app", { name: "x", kv_namespaces: [] }),
    ).toThrow(/kv_namespaces/);
  });

  test("a content hash changes with anything deployed", async () => {
    const a = await manifestV1("1.2.3");
    const b = await manifestV1("1.2.4");
    // The image tag is the version, so the container Workers differ...
    expect(a.workers.computerHost.contentHash).not.toBe(
      b.workers.computerHost.contentHash,
    );
    // ...and the app, whose modules and bindings are the same, does not.
    expect(a.workers.app.contentHash).toBe(b.workers.app.contentHash);
  });
});

describe("migrations", () => {
  const history = [
    { tag: "v1", new_sqlite_classes: ["A"] },
    { tag: "v2", new_sqlite_classes: ["B"] },
    { tag: "v3", deleted_classes: ["A"] },
  ];

  test("a new script gets the whole history", () => {
    expect(migrationUploadV1(history, undefined)).toEqual({
      new_tag: "v3",
      steps: [
        { new_sqlite_classes: ["A"] },
        { new_sqlite_classes: ["B"] },
        { deleted_classes: ["A"] },
      ],
    });
  });

  test("a deployed script gets what follows its tag, or nothing", () => {
    expect(migrationUploadV1(history, "v1")).toEqual({
      old_tag: "v1",
      new_tag: "v3",
      steps: [{ new_sqlite_classes: ["B"] }, { deleted_classes: ["A"] }],
    });
    expect(migrationUploadV1(history, "v3")).toBeUndefined();
  });

  test("a tag the history lacks is refused, not replayed over", () => {
    expect(() => migrationUploadV1(history, "v9")).toThrow(/does not contain/);
  });

  test("renames move a class's namespace", () => {
    expect([
      ...liveClassesV1([
        { tag: "v1", new_sqlite_classes: ["A"] },
        { tag: "v2", renamed_classes: [{ from: "A", to: "B" }] },
      ]),
    ]).toEqual(["B"]);
  });
});

describe("the equivalence gate between releases", () => {
  test("the same release succeeds itself", async () => {
    const manifest = await manifestV1();
    expect(bundleSuccessionProblemsV1(manifest, manifest)).toEqual([]);
  });

  test("a migration appended at the end is growth", async () => {
    const previous = await manifestV1();
    const next = structuredClone(previous) as DeployBundleManifestV1;
    (next.workers.app.migrations as unknown[]).push({
      tag: "v10",
      new_sqlite_classes: ["Later"],
    });
    expect(bundleSuccessionProblemsV1(previous, next)).toEqual([]);
  });

  test("a renamed Worker, a rewritten history and a moved bucket are each refused", async () => {
    const previous = await manifestV1();
    const next = structuredClone(previous) as {
      -readonly [K in keyof DeployBundleManifestV1]: unknown;
    } & DeployBundleManifestV1;
    const app = next.workers.app as {
      -readonly [K in keyof BundleWorkerV1]: BundleWorkerV1[K];
    };
    app.name = "{install}-app";
    app.migrations = app.migrations.slice(1);
    app.bindings = app.bindings.map((binding) =>
      binding.name === "MEMORY_FILES"
        ? { ...binding, bucket_name: "{install}-memories" }
        : binding,
    );
    const problems = bundleSuccessionProblemsV1(previous, next);
    expect(problems.some((problem) => problem.includes("renamed"))).toBe(true);
    expect(problems.some((problem) => problem.includes("prefix"))).toBe(true);
    expect(problems.some((problem) => problem.includes("MEMORY_FILES"))).toBe(
      true,
    );
  });

  test("a deletion appended to the history is refused unless it is named", async () => {
    const previous = await manifestV1();
    const next = structuredClone(previous) as DeployBundleManifestV1;
    (next.workers.app.migrations as unknown[]).push({
      tag: "v10",
      deleted_classes: ["GroupChat"],
    });
    expect(bundleSuccessionProblemsV1(previous, next)).toEqual([
      "app's GroupChat Durable Objects are deleted with their data; name it with --allow-deleted if that is meant",
    ]);
    expect(bundleSuccessionProblemsV1(previous, next, ["GroupChat"])).toEqual(
      [],
    );
  });

  test("a dropped bucket or a reshaped index is refused", async () => {
    const previous = await manifestV1();
    const next = structuredClone(previous) as DeployBundleManifestV1;
    (next.resources as unknown as { r2Buckets: string[] }).r2Buckets = [];
    (next.resources.vectorizeIndexes[0] as { dimensions: number }).dimensions =
      1024;
    const problems = bundleSuccessionProblemsV1(previous, next);
    expect(problems).toHaveLength(3);
  });
});

describe("the equivalence gate against a live install", () => {
  test("a fresh account and an install of an earlier release pass", async () => {
    const manifest = await manifestV1();
    expect(
      installSuccessionProblemsV1(manifest, "acme", {
        scripts: {},
        namespaces: [],
      }),
    ).toEqual([]);
    expect(
      installSuccessionProblemsV1(manifest, "acme", {
        scripts: { acme: "v7" },
        namespaces: [{ script: "acme", class: "BotState" }],
      }),
    ).toEqual([]);
  });

  test("a script at a tag this history lacks is refused", async () => {
    const problems = installSuccessionProblemsV1(await manifestV1(), "acme", {
      scripts: { acme: "v42" },
      namespaces: [],
    });
    expect(problems[0]).toContain("v42");
  });

  test("a namespace whose class the bundle never names is refused", async () => {
    const problems = installSuccessionProblemsV1(await manifestV1(), "acme", {
      scripts: { acme: "v9" },
      namespaces: [{ script: "acme", class: "SomebodyElses" }],
    });
    expect(problems[0]).toContain("SomebodyElses");
  });

  test("Durable Objects with no migration tag cannot take a history", async () => {
    const problems = installSuccessionProblemsV1(await manifestV1(), "acme", {
      scripts: { acme: null },
      namespaces: [{ script: "acme", class: "BotState" }],
    });
    expect(problems[0]).toContain("no migration tag");
  });
});

describe("one Worker's upload", () => {
  test("resolves names, sets the install's vars and secrets, keeps the rest", async () => {
    const manifest = await manifestV1();
    const metadata = workerUploadMetadataV1(manifest, "app", install(), {
      assetsJwt: "jwt",
    }) as {
      bindings: { type: string; name: string; [key: string]: unknown }[];
      keep_bindings: string[];
      assets: { jwt: string };
    };
    const byName = new Map(
      metadata.bindings.map((binding) => [binding.name, binding]),
    );
    expect(byName.get("MEMORY_FILES")!.bucket_name).toBe("acme-memory-files");
    expect(byName.get("COMPUTER_HOST")!.service).toBe("acme-computer-host");
    expect(byName.get("ACCESS_AUD")).toEqual({
      type: "plain_text",
      name: "ACCESS_AUD",
      text: "d".repeat(64),
    });
    expect(byName.get("SPRITES_TOKEN")!.type).toBe("secret_text");
    expect(byName.has("OPENAI_API_KEY")).toBe(false);
    expect(metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(metadata.assets.jwt).toBe("jwt");
    expect(JSON.stringify(metadata)).not.toContain("{install}");
  });

  test("an install without the Computer binds no host and needs no Fly token", async () => {
    const manifest = await manifestV1();
    const {
      SPRITES_TOKEN: _s,
      COMPUTER_HOST_TOKEN: _c,
      ...secrets
    } = install().secrets;
    const withoutHost = install({ computerHost: false, secrets });
    const metadata = workerUploadMetadataV1(manifest, "app", withoutHost, {
      assetsJwt: "jwt",
    }) as { bindings: { name: string }[] };
    expect(
      metadata.bindings.some((binding) => binding.name === "COMPUTER_HOST"),
    ).toBe(false);
    expect(missingSecretsV1(manifest, "app", withoutHost)).toEqual([]);
    expect(missingSecretsV1(manifest, "app", install({ secrets }))).toEqual([
      "COMPUTER_HOST_TOKEN",
      "SPRITES_TOKEN",
    ]);
  });

  test("assets need a completed upload session", async () => {
    const manifest = await manifestV1();
    expect(() => workerUploadMetadataV1(manifest, "app", install())).toThrow(
      /upload session/,
    );
  });
});

describe("the assets hash", () => {
  test("is 32 hex characters and depends on the extension", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(assetHashV1("a.js", bytes)).toMatch(/^[0-9a-f]{32}$/);
    expect(assetHashV1("a.js", bytes)).not.toBe(assetHashV1("a.css", bytes));
  });

  test("a wasm file is served as wasm", () => {
    expect(assetContentTypeV1("_flutter/x/canvaskit.wasm")).toBe(
      "application/wasm",
    );
    // No Content-Type at all, as wrangler serves an extension it does not know.
    expect(assetContentTypeV1("x.unknown")).toBe("application/null");
    expect(assetContentTypeV1("main.dart.js")).toBe(
      "application/javascript; charset=utf-8",
    );
  });
});

/* ── A Cloudflare account, in memory ────────────────────────────────────── */

function fakeAccountV1() {
  const scripts = new Map<
    string,
    { migrationTag?: string; metadata: Record<string, unknown> }
  >();
  const namespaces: { id: string; script: string; class: string }[] = [];
  const buckets = new Set<string>();
  const indexes = new Set<string>();
  const objects = new Map<string, Uint8Array>();
  const applications: {
    id: string;
    name: string;
    max_instances: number;
    configuration: { image: string; instance_type: string };
    durable_objects: { namespace_id: string };
  }[] = [];
  const calls: string[] = [];
  const ok = (result: unknown, status = 200) => ({
    status,
    body: { success: true, result, errors: [] },
  });
  const notFound = {
    status: 404,
    body: { success: false, errors: [{ code: 10007, message: "not found" }] },
  };

  const api: CloudflareApiV1 = {
    async call(request: CloudflareRequestV1) {
      const path = request.path.replace(/^\/accounts\/[0-9a-f]+/, "");
      calls.push(`${request.method} ${path}`);
      let match: RegExpMatchArray | null;
      if ((match = path.match(/^\/workers\/services\/([^/?]+)$/))) {
        const script = scripts.get(match[1]!);
        return script
          ? ok({
              default_environment: {
                script: { migration_tag: script.migrationTag },
              },
            })
          : notFound;
      }
      if (path.startsWith("/workers/durable_objects/namespaces"))
        return ok(namespaces);
      if ((match = path.match(/^\/r2\/buckets\/([^/]+)$/))) {
        return buckets.has(match[1]!) ? ok({}) : notFound;
      }
      if (path === "/r2/buckets" && request.method === "POST") {
        buckets.add((request.json as { name: string }).name);
        return ok({});
      }
      if ((match = path.match(/^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/))) {
        if (!buckets.has(match[1]!)) return notFound;
        objects.set(`${match[1]}/${match[2]}`, request.bytes!);
        return ok({});
      }
      if ((match = path.match(/^\/vectorize\/v2\/indexes\/([^/]+)$/))) {
        return indexes.has(match[1]!) ? ok({}) : notFound;
      }
      if (path === "/vectorize/v2/indexes") {
        indexes.add((request.json as { name: string }).name);
        return ok({});
      }
      if (
        (match = path.match(
          /^\/workers\/scripts\/([^/]+)\/assets-upload-session$/,
        ))
      ) {
        const files = Object.values(
          (request.json as { manifest: Record<string, { hash: string }> })
            .manifest,
        ).map((file) => file.hash);
        return ok({ jwt: "session", buckets: [files] });
      }
      if (path === "/workers/assets/upload?base64=true") {
        expect(request.bearer).toBe("session");
        return ok({ jwt: "completion" }, 201);
      }
      if (
        (match = path.match(/^\/workers\/scripts\/([^/?]+)\?/)) &&
        request.method === "PUT"
      ) {
        const name = match[1]!;
        const metadata = JSON.parse(
          request.form!.get("metadata") as string,
        ) as {
          migrations?: { old_tag?: string; new_tag: string };
          bindings: { type: string; class_name?: string }[];
        };
        const existing = scripts.get(name);
        if (
          metadata.migrations?.old_tag !== existing?.migrationTag &&
          metadata.migrations
        ) {
          return {
            status: 400,
            body: {
              success: false,
              errors: [{ code: 10079, message: "old_tag mismatch" }],
            },
          };
        }
        scripts.set(name, {
          migrationTag: metadata.migrations?.new_tag ?? existing?.migrationTag,
          metadata,
        });
        for (const binding of metadata.bindings) {
          if (
            binding.type === "durable_object_namespace" &&
            !namespaces.some(
              (entry) =>
                entry.script === name && entry.class === binding.class_name,
            )
          ) {
            namespaces.push({
              id: `ns-${name}-${binding.class_name}`,
              script: name,
              class: binding.class_name!,
            });
          }
        }
        return ok({ id: "version" });
      }
      if (path.match(/^\/workers\/scripts\/[^/]+\/subdomain$/)) return ok({});
      if (path.match(/^\/workers\/scripts\/[^/]+\/domains\/records$/))
        return ok({});
      if (path === "/containers/applications" && request.method === "GET")
        return ok(applications);
      if (path === "/containers/applications" && request.method === "POST") {
        const body = request.json as (typeof applications)[number];
        applications.push({ ...body, id: `app-${applications.length}` });
        return ok({}, 201);
      }
      if (
        (match = path.match(/^\/containers\/applications\/([^/]+)$/)) &&
        request.method === "PATCH"
      ) {
        const application = applications.find(
          (entry) => entry.id === match![1],
        );
        Object.assign(application!, request.json);
        return ok({});
      }
      if (path.match(/^\/containers\/applications\/[^/]+\/rollouts$/))
        return ok({}, 201);
      throw new Error(
        `The fake account does not answer ${request.method} ${path}`,
      );
    },
  };
  return {
    api,
    calls,
    scripts,
    namespaces,
    buckets,
    indexes,
    objects,
    applications,
  };
}

async function filesFor(manifest: DeployBundleManifestV1) {
  const contents = new Map<string, Uint8Array>();
  for (const key of BUNDLE_WORKERS_V1) {
    contents.set(
      manifest.workers[key].modules[0]!.path,
      new TextEncoder().encode(`export default {} // ${key}`),
    );
  }
  contents.set(
    "application-artifact.mjs",
    new TextEncoder().encode("artifact"),
  );
  contents.set("assets/app/index.html", new TextEncoder().encode("hello"));
  return {
    read: async (path: string) => {
      const bytes = contents.get(path);
      if (!bytes) throw new Error(`no ${path}`);
      return bytes;
    },
  };
}

describe("deploying through the API", () => {
  test("a first install creates everything, in dependency order", async () => {
    const account = fakeAccountV1();
    const manifest = await manifestV1();
    const outcome = await deployBundleV1({
      api: account.api,
      manifest,
      files: await filesFor(manifest),
      install: install(),
    });
    expect(outcome.firstInstall).toBe(true);
    expect(outcome.url).toBe("https://bot.example.com");
    expect([...account.buckets].sort()).toEqual([
      "acme-application-artifacts",
      "acme-memory-files",
    ]);
    expect([...account.indexes]).toEqual(["acme-memory"]);
    expect([...account.objects.keys()]).toEqual([
      `acme-application-artifacts/applications/${ARTIFACT_SHA}.mjs`,
    ]);
    const uploads = account.calls.filter((call) =>
      call.includes("?excludeScript"),
    );
    expect(uploads.map((call) => call.split("/")[3]!.split("?")[0])).toEqual([
      "acme-computer-host",
      "acme-applet-build",
      "acme",
    ]);
    expect(account.scripts.get("acme")!.migrationTag).toBe("v9");
    expect(account.applications.map((application) => application.name)).toEqual(
      [
        "acme-computer-host-flyhostcontainer",
        "acme-applet-build-appletbuildcontainer",
      ],
    );
    expect(account.applications[0]!.durable_objects.namespace_id).toBe(
      "ns-acme-computer-host-FlyHostContainer",
    );
    const assets = (
      account.scripts.get("acme")!.metadata.assets as { jwt: string }
    ).jwt;
    expect(assets).toBe("completion");
  });

  test("an install with no hostname answers on workers.dev and attaches no domain", async () => {
    const account = fakeAccountV1();
    const manifest = await manifestV1();
    const workersDev: Record<string, unknown> = {};
    const api = {
      call: (request: Parameters<typeof account.api.call>[0]) => {
        const match = request.path.match(
          /\/workers\/scripts\/([^/]+)\/subdomain$/,
        );
        if (match) {
          workersDev[match[1]!] = (
            request.json as { enabled: boolean }
          ).enabled;
        }
        return account.api.call(request);
      },
    };
    const outcome = await deployBundleV1({
      api,
      manifest,
      files: await filesFor(manifest),
      install: install({ hostnames: [], computerHost: false }),
    });
    expect(workersDev.acme).toBe(true);
    expect(workersDev["acme-applet-build"]).toBe(false);
    expect(
      account.calls.some((call) => call.includes("/domains/records")),
    ).toBe(false);
    expect(outcome.url).toBeUndefined();
  });

  test("the next release updates in place: same scripts, only the new migrations, images rolled", async () => {
    const account = fakeAccountV1();
    const first = await manifestV1("1.2.3");
    await deployBundleV1({
      api: account.api,
      manifest: first,
      files: await filesFor(first),
      install: install(),
    });
    const next = structuredClone(
      await manifestV1("1.2.4"),
    ) as DeployBundleManifestV1;
    (next.workers.app.migrations as unknown[]).push({
      tag: "v10",
      new_sqlite_classes: ["Later"],
    });
    account.calls.length = 0;
    // An update needs no secret again: the deployed ones are kept.
    const outcome = await deployBundleV1({
      api: account.api,
      manifest: next,
      files: await filesFor(next),
      install: install({ secrets: {} }),
    });
    expect(outcome.firstInstall).toBe(false);
    const app = account.scripts.get("acme")!.metadata as {
      migrations: { old_tag: string; new_tag: string; steps: unknown[] };
    };
    expect(app.migrations).toEqual({
      old_tag: "v9",
      new_tag: "v10",
      steps: [{ new_sqlite_classes: ["Later"] }],
    });
    expect(
      account.scripts.get("acme-computer-host")!.metadata.migrations,
    ).toBeUndefined();
    expect(account.calls).not.toContain("POST /r2/buckets");
    expect(account.applications).toHaveLength(2);
    expect(account.applications[0]!.configuration.image).toBe(
      "docker.io/timoconnellaus/frockbot-computer-host:1.2.4",
    );
    expect(
      account.calls.filter((call) => call.endsWith("/rollouts")),
    ).toHaveLength(2);
  });

  test("a session that asks for one call per file gets one call per file", async () => {
    const account = fakeAccountV1();
    const payload = btoa(
      JSON.stringify({ wrangler_single_asset_uploads: true }),
    );
    const inner = account.api.call.bind(account.api);
    const single: string[] = [];
    const api: CloudflareApiV1 = {
      async call(request) {
        if (request.path.endsWith("/assets-upload-session")) {
          return {
            status: 200,
            body: {
              result: { jwt: `h.${payload}.s`, buckets: [["b".repeat(32)]] },
            },
          };
        }
        if (request.path.includes("/workers/assets/upload/")) {
          single.push(request.headers?.["content-type"] ?? "");
          return { status: 201, body: { result: { jwt: "completion" } } };
        }
        return inner(request);
      },
    };
    const manifest = await manifestV1();
    await deployBundleV1({
      api,
      manifest,
      files: await filesFor(manifest),
      install: install(),
    });
    expect(single).toEqual(["text/html"]);
    expect(account.calls).not.toContain(
      "POST /workers/assets/upload?base64=true",
    );
  });

  test("refuses, before touching anything, an install it would orphan", async () => {
    const account = fakeAccountV1();
    account.scripts.set("acme", { migrationTag: "v42", metadata: {} });
    const manifest = await manifestV1();
    await expect(
      deployBundleV1({
        api: account.api,
        manifest,
        files: await filesFor(manifest),
        install: install(),
      }),
    ).rejects.toThrow(/v42/);
    expect(account.calls.every((call) => call.startsWith("GET"))).toBe(true);
  });

  test("a first install without a required secret is refused", async () => {
    const account = fakeAccountV1();
    const manifest = await manifestV1();
    await expect(
      deployBundleV1({
        api: account.api,
        manifest,
        files: await filesFor(manifest),
        install: install({ secrets: {} }),
      }),
    ).rejects.toThrow(/needs/);
  });

  test("a module whose bytes are not the manifest's is refused", async () => {
    const account = fakeAccountV1();
    const manifest = await manifestV1();
    const files = await filesFor(manifest);
    await expect(
      deployBundleV1({
        api: account.api,
        manifest,
        files: {
          read: async (path) =>
            path.endsWith("index.js")
              ? new TextEncoder().encode("tampered")
              : files.read(path),
        },
        install: install(),
      }),
    ).rejects.toThrow(/hashes to/);
  });
});

describe("the conversation a proof holds", () => {
  test("asks the General Bot, and waits for its reply", async () => {
    let polls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("cookie")).toBe(
        "CF_Authorization=jwt",
      );
      if (url.endsWith("/api/bots/bootstrap")) {
        return Response.json({ schemaVersion: 1, generalBotId: "general-1" });
      }
      if (url.endsWith("/api/bots/general-1/turns")) {
        const body = JSON.parse(String(init!.body)) as { commandId: string };
        return Response.json(
          { schemaVersion: 1, runId: body.commandId },
          { status: 202 },
        );
      }
      polls += 1;
      return Response.json(
        polls < 2
          ? { schemaVersion: 1, state: "running" }
          : {
              schemaVersion: 1,
              state: "terminal",
              run: {
                status: "completed",
                outcome: { type: "completed", text: "Hello!" },
              },
            },
      );
    }) as typeof fetch;
    const conversation = await converseV1({
      url: "https://bot.example.com",
      accessToken: "jwt",
      text: "hi",
      fetch: fetchImpl,
      pollMs: 1,
    });
    expect(conversation.reply).toBe("Hello!");
    expect(conversation.botId).toBe("general-1");
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(
    join(REPO_ROOT_V1, ".github/workflows/release.yml"),
    "utf8",
  );

  test("builds the bundle, gates it on the previous release, and attaches both files", () => {
    expect(workflow).toContain("bun scripts/build-deploy-bundle.ts");
    expect(workflow).toContain("bun scripts/check-deploy-bundle.ts");
    expect(workflow).toContain("frockbot-deploy-$VERSION.json");
    expect(workflow).toContain("frockbot-deploy-$VERSION.tar.gz");
  });
});

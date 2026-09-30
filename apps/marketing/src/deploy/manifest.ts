/**
 * The release bundle a one-click deploy installs.
 *
 * A release publishes, beside its other assets, `frockbot-deploy-<version>.json`
 * and the files it names. The manifest says what a self-hosted install is made
 * of — the resources to create, the Worker modules, their bindings, the Durable
 * Object migrations, the web client and the secrets to mint — in terms of
 * *roles* rather than names, so the deployer names every resource after the
 * install and the same manifest serves any account. Nothing here is built on
 * the deploying side: every byte comes from the release.
 */

export const RELEASE_REPOSITORY_V1 = "timoconnellaus/frockbot";

export function releaseManifestAssetV1(version: string): string {
  return `frockbot-deploy-${version}.json`;
}

export function releaseAssetUrlV1(version: string, asset: string): string {
  return `https://github.com/${RELEASE_REPOSITORY_V1}/releases/download/v${version}/${encodeURIComponent(asset)}`;
}

/** A file the release attached, checked against its digest when fetched. */
export interface BundleFileV1 {
  readonly asset: string;
  readonly sha256: string;
}

export type BundleModuleTypeV1 = "esm" | "commonjs" | "wasm" | "text" | "data";

export interface BundleModuleV1 extends BundleFileV1 {
  /** The module's name inside the Worker, as its imports spell it. */
  readonly name: string;
  readonly type: BundleModuleTypeV1;
}

/**
 * A binding, with any resource it points at named by role.
 *
 * `bucket`, `namespace`, `database`, `index`, `queue` and `dataset` are keys
 * into the manifest's `resources`; the deployer resolves them to the names or
 * ids it created for this install.
 */
export type BundleBindingV1 =
  | { readonly type: "ai"; readonly name: string }
  | { readonly type: "worker_loader"; readonly name: string }
  | { readonly type: "assets"; readonly name: string }
  | { readonly type: "version_metadata"; readonly name: string }
  | {
      readonly type: "durable_object_namespace";
      readonly name: string;
      readonly className: string;
    }
  | {
      readonly type: "r2_bucket";
      readonly name: string;
      readonly bucket: string;
    }
  | {
      readonly type: "kv_namespace";
      readonly name: string;
      readonly namespace: string;
    }
  | { readonly type: "d1"; readonly name: string; readonly database: string }
  | {
      readonly type: "vectorize";
      readonly name: string;
      readonly index: string;
    }
  | { readonly type: "queue"; readonly name: string; readonly queue: string }
  | {
      readonly type: "analytics_engine";
      readonly name: string;
      readonly dataset: string;
    }
  | {
      readonly type: "plain_text";
      readonly name: string;
      readonly text: string;
    }
  /** The install's own public origin, e.g. `https://x.y.workers.dev`. */
  | { readonly type: "install_origin"; readonly name: string }
  /** The Access team domain and audience the deployer created. */
  | { readonly type: "access_team_domain"; readonly name: string }
  | { readonly type: "access_aud"; readonly name: string }
  /** The deploying person's email: the single-user allowlist and admin. */
  | { readonly type: "owner_email"; readonly name: string };

export interface BundleMigrationV1 {
  readonly tag: string;
  readonly newSqliteClasses?: readonly string[];
  readonly deletedClasses?: readonly string[];
  readonly renamedClasses?: readonly { from: string; to: string }[];
}

/** A secret minted once, on the first deploy, and never read back. */
export interface BundleSecretV1 {
  readonly name: string;
  readonly shape: "hex" | "keyring";
}

export interface BundleD1MigrationV1 extends BundleFileV1 {
  /** Applied in this order, each once, recorded in `d1_migrations`. */
  readonly name: string;
}

export interface BundleResourcesV1 {
  readonly r2Buckets?: readonly string[];
  readonly kvNamespaces?: readonly string[];
  readonly queues?: readonly string[];
  readonly analyticsDatasets?: readonly string[];
  readonly d1Databases?: readonly {
    readonly role: string;
    readonly migrations: readonly BundleD1MigrationV1[];
  }[];
  readonly vectorizeIndexes?: readonly {
    readonly role: string;
    readonly dimensions: number;
    readonly metric: "cosine" | "euclidean" | "dot-product";
  }[];
}

/** An object the release puts in one of the install's buckets. */
export interface BundleR2ObjectV1 extends BundleFileV1 {
  readonly bucket: string;
  readonly key: string;
  readonly contentType?: string;
}

export interface BundleWorkerV1 {
  /** Only the app Worker for now; the Computer host is deployed from inside the install. */
  readonly role: "app";
  readonly mainModule: string;
  readonly modules: readonly BundleModuleV1[];
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly bindings: readonly BundleBindingV1[];
  readonly migrations: readonly BundleMigrationV1[];
  readonly secrets: readonly BundleSecretV1[];
  /** The web client, a zip of the static files, and how Workers serves them. */
  readonly assets?: BundleFileV1 & {
    readonly htmlHandling?: string;
    readonly notFoundHandling?: string;
    readonly runWorkerFirst?: boolean | readonly string[];
  };
  readonly r2Objects?: readonly BundleR2ObjectV1[];
}

export interface ReleaseBundleManifestV1 {
  readonly schemaVersion: 1;
  readonly version: string;
  /** One line for the Your installs page: what an update brings. */
  readonly highlights?: string;
  readonly resources: BundleResourcesV1;
  readonly workers: readonly BundleWorkerV1[];
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BINDING_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MODULE_TYPES: readonly BundleModuleTypeV1[] = [
  "esm",
  "commonjs",
  "wasm",
  "text",
  "data",
];

class ManifestErrorV1 extends Error {}

function fail(path: string, message: string): never {
  throw new ManifestErrorV1(`Release manifest ${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function text(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  if (pattern && !pattern.test(value)) fail(path, `is malformed: ${value}`);
  return value;
}

function strings(value: unknown, path: string, pattern?: RegExp): string[] {
  return list(value, path).map((item, i) =>
    text(item, `${path}[${i}]`, pattern),
  );
}

/**
 * An asset name is a file in the same release. Refusing separators keeps a
 * manifest from steering a fetch anywhere but that release's downloads.
 */
function file(value: Record<string, unknown>, path: string): BundleFileV1 {
  return {
    asset: text(value.asset, `${path}.asset`, /^[A-Za-z0-9._-]+$/),
    sha256: text(value.sha256, `${path}.sha256`, SHA256_PATTERN),
  };
}

function binding(
  value: unknown,
  path: string,
  roles: ReadonlyMap<string, ReadonlySet<string>>,
): BundleBindingV1 {
  const raw = record(value, path);
  const name = text(raw.name, `${path}.name`, BINDING_NAME_PATTERN);
  const role = (key: string, kind: string): string => {
    const found = text(raw[key], `${path}.${key}`, ROLE_PATTERN);
    if (!roles.get(kind)?.has(found)) {
      fail(
        `${path}.${key}`,
        `names ${found}, which resources.${kind} does not declare`,
      );
    }
    return found;
  };
  switch (raw.type) {
    case "ai":
    case "worker_loader":
    case "assets":
    case "version_metadata":
    case "install_origin":
    case "access_team_domain":
    case "access_aud":
    case "owner_email":
      return { type: raw.type, name };
    case "durable_object_namespace":
      return {
        type: raw.type,
        name,
        className: text(
          raw.className,
          `${path}.className`,
          /^[A-Za-z_$][\w$]*$/,
        ),
      };
    case "r2_bucket":
      return { type: raw.type, name, bucket: role("bucket", "r2Buckets") };
    case "kv_namespace":
      return {
        type: raw.type,
        name,
        namespace: role("namespace", "kvNamespaces"),
      };
    case "d1":
      return {
        type: raw.type,
        name,
        database: role("database", "d1Databases"),
      };
    case "vectorize":
      return { type: raw.type, name, index: role("index", "vectorizeIndexes") };
    case "queue":
      return { type: raw.type, name, queue: role("queue", "queues") };
    case "analytics_engine":
      return {
        type: raw.type,
        name,
        dataset: role("dataset", "analyticsDatasets"),
      };
    case "plain_text":
      if (typeof raw.text !== "string")
        fail(`${path}.text`, "must be a string");
      return { type: raw.type, name, text: raw.text };
    default:
      return fail(
        `${path}.type`,
        `is not a binding this deployer knows: ${String(raw.type)}`,
      );
  }
}

/**
 * The manifest, or why it cannot be deployed.
 *
 * Strict on purpose: a binding type this deployer does not know would upload a
 * Worker missing something the release expects, and the person would find out
 * from a broken install rather than from this page.
 */
export function decodeReleaseManifestV1(
  value: unknown,
): ReleaseBundleManifestV1 {
  const raw = record(value, "");
  if (raw.schemaVersion !== 1) {
    fail(
      "schemaVersion",
      `is ${String(raw.schemaVersion)}; this deployer reads 1`,
    );
  }
  const version = text(raw.version, "version", VERSION_PATTERN);
  const rawResources = record(raw.resources ?? {}, "resources");

  const d1Databases = list(
    rawResources.d1Databases,
    "resources.d1Databases",
  ).map((item, i) => {
    const path = `resources.d1Databases[${i}]`;
    const entry = record(item, path);
    return {
      role: text(entry.role, `${path}.role`, ROLE_PATTERN),
      migrations: list(entry.migrations, `${path}.migrations`).map((m, j) => {
        const migration = record(m, `${path}.migrations[${j}]`);
        return {
          name: text(migration.name, `${path}.migrations[${j}].name`),
          ...file(migration, `${path}.migrations[${j}]`),
        };
      }),
    };
  });
  const vectorizeIndexes = list(
    rawResources.vectorizeIndexes,
    "resources.vectorizeIndexes",
  ).map((item, i) => {
    const path = `resources.vectorizeIndexes[${i}]`;
    const entry = record(item, path);
    const dimensions = entry.dimensions;
    if (
      typeof dimensions !== "number" ||
      !Number.isInteger(dimensions) ||
      dimensions < 1
    ) {
      fail(`${path}.dimensions`, "must be a positive integer");
    }
    if (
      entry.metric !== "cosine" &&
      entry.metric !== "euclidean" &&
      entry.metric !== "dot-product"
    ) {
      fail(`${path}.metric`, "must be cosine, euclidean or dot-product");
    }
    return {
      role: text(entry.role, `${path}.role`, ROLE_PATTERN),
      dimensions,
      metric: entry.metric as "cosine" | "euclidean" | "dot-product",
    };
  });
  const resources: BundleResourcesV1 = {
    r2Buckets: strings(
      rawResources.r2Buckets,
      "resources.r2Buckets",
      ROLE_PATTERN,
    ),
    kvNamespaces: strings(
      rawResources.kvNamespaces,
      "resources.kvNamespaces",
      ROLE_PATTERN,
    ),
    queues: strings(rawResources.queues, "resources.queues", ROLE_PATTERN),
    analyticsDatasets: strings(
      rawResources.analyticsDatasets,
      "resources.analyticsDatasets",
      ROLE_PATTERN,
    ),
    d1Databases,
    vectorizeIndexes,
  };
  const roles = new Map<string, ReadonlySet<string>>([
    ["r2Buckets", new Set(resources.r2Buckets)],
    ["kvNamespaces", new Set(resources.kvNamespaces)],
    ["queues", new Set(resources.queues)],
    ["analyticsDatasets", new Set(resources.analyticsDatasets)],
    ["d1Databases", new Set(d1Databases.map((d) => d.role))],
    ["vectorizeIndexes", new Set(vectorizeIndexes.map((v) => v.role))],
  ]);

  const workers = list(raw.workers, "workers").map(
    (item, i): BundleWorkerV1 => {
      const path = `workers[${i}]`;
      const worker = record(item, path);
      if (worker.role !== "app") fail(`${path}.role`, "must be app");
      const modules = list(worker.modules, `${path}.modules`).map((m, j) => {
        const modulePath = `${path}.modules[${j}]`;
        const entry = record(m, modulePath);
        if (!MODULE_TYPES.includes(entry.type as BundleModuleTypeV1)) {
          fail(
            `${modulePath}.type`,
            `must be one of ${MODULE_TYPES.join(", ")}`,
          );
        }
        return {
          name: text(entry.name, `${modulePath}.name`),
          type: entry.type as BundleModuleTypeV1,
          ...file(entry, modulePath),
        };
      });
      const mainModule = text(worker.mainModule, `${path}.mainModule`);
      if (!modules.some((m) => m.name === mainModule && m.type === "esm")) {
        fail(
          `${path}.mainModule`,
          `${mainModule} is not one of its ES modules`,
        );
      }
      const bindings = list(worker.bindings, `${path}.bindings`).map((b, j) =>
        binding(b, `${path}.bindings[${j}]`, roles),
      );
      const names = new Set<string>();
      for (const b of bindings) {
        if (names.has(b.name))
          fail(`${path}.bindings`, `binds ${b.name} twice`);
        names.add(b.name);
      }
      const secrets = list(worker.secrets, `${path}.secrets`).map((s, j) => {
        const secret = record(s, `${path}.secrets[${j}]`);
        if (secret.shape !== "hex" && secret.shape !== "keyring") {
          fail(`${path}.secrets[${j}].shape`, "must be hex or keyring");
        }
        const name = text(
          secret.name,
          `${path}.secrets[${j}].name`,
          BINDING_NAME_PATTERN,
        );
        if (names.has(name))
          fail(`${path}.secrets[${j}]`, `${name} is also a binding`);
        return { name, shape: secret.shape } as BundleSecretV1;
      });
      const migrations = list(worker.migrations, `${path}.migrations`).map(
        (m, j) => {
          const migration = record(m, `${path}.migrations[${j}]`);
          return {
            tag: text(migration.tag, `${path}.migrations[${j}].tag`),
            newSqliteClasses: strings(
              migration.newSqliteClasses,
              `${path}.migrations[${j}].newSqliteClasses`,
            ),
            deletedClasses: strings(
              migration.deletedClasses,
              `${path}.migrations[${j}].deletedClasses`,
            ),
            renamedClasses: list(
              migration.renamedClasses,
              `${path}.migrations[${j}].renamedClasses`,
            ).map((r, k) => {
              const renamed = record(
                r,
                `${path}.migrations[${j}].renamedClasses[${k}]`,
              );
              return {
                from: text(
                  renamed.from,
                  `${path}.migrations[${j}].renamedClasses[${k}].from`,
                ),
                to: text(
                  renamed.to,
                  `${path}.migrations[${j}].renamedClasses[${k}].to`,
                ),
              };
            }),
          };
        },
      );
      const assets =
        worker.assets === undefined
          ? undefined
          : (() => {
              const raw = record(worker.assets, `${path}.assets`);
              const runWorkerFirst = raw.runWorkerFirst;
              return {
                ...file(raw, `${path}.assets`),
                ...(typeof raw.htmlHandling === "string"
                  ? { htmlHandling: raw.htmlHandling }
                  : {}),
                ...(typeof raw.notFoundHandling === "string"
                  ? { notFoundHandling: raw.notFoundHandling }
                  : {}),
                ...(typeof runWorkerFirst === "boolean" ||
                Array.isArray(runWorkerFirst)
                  ? { runWorkerFirst: runWorkerFirst as boolean | string[] }
                  : {}),
              };
            })();
      const r2Objects = list(worker.r2Objects, `${path}.r2Objects`).map(
        (o, j) => {
          const objectPath = `${path}.r2Objects[${j}]`;
          const entry = record(o, objectPath);
          const bucket = text(
            entry.bucket,
            `${objectPath}.bucket`,
            ROLE_PATTERN,
          );
          if (!roles.get("r2Buckets")?.has(bucket)) {
            fail(
              `${objectPath}.bucket`,
              `names ${bucket}, which resources.r2Buckets does not declare`,
            );
          }
          return {
            bucket,
            key: text(entry.key, `${objectPath}.key`),
            ...(typeof entry.contentType === "string"
              ? { contentType: entry.contentType }
              : {}),
            ...file(entry, objectPath),
          };
        },
      );
      return {
        role: "app",
        mainModule,
        modules,
        compatibilityDate: text(
          worker.compatibilityDate,
          `${path}.compatibilityDate`,
          /^\d{4}-\d{2}-\d{2}$/,
        ),
        compatibilityFlags: strings(
          worker.compatibilityFlags,
          `${path}.compatibilityFlags`,
        ),
        bindings,
        migrations,
        secrets,
        ...(assets ? { assets } : {}),
        r2Objects,
      };
    },
  );
  if (workers.length !== 1) fail("workers", "must name exactly one app Worker");
  return {
    schemaVersion: 1,
    version,
    ...(typeof raw.highlights === "string"
      ? { highlights: raw.highlights }
      : {}),
    resources,
    workers,
  };
}

/** `a` is newer than `b`, by semantic version. */
export function isNewerVersionV1(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

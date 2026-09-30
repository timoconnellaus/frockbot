/**
 * What the deploy flow decides, apart from what it does.
 *
 * Names, addresses, the account checks and their fixes, the Worker's upload
 * metadata and which migrations are due: functions over values, so the tests
 * can check every judgement without a Cloudflare account.
 */
import type {
  BundleBindingV1,
  BundleMigrationV1,
  BundleWorkerV1,
  ReleaseBundleManifestV1,
} from "./manifest";

/**
 * Short enough that `<name>-<role>` fits every resource's name limit (R2's 63
 * is the tightest), and a DNS label besides.
 */
export const INSTALL_NAME_MAX_V1 = 40;
const INSTALL_NAME_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

export function installNameProblemV1(name: string): string | undefined {
  if (name.length === 0) return "Give it a name.";
  if (name.length > INSTALL_NAME_MAX_V1) {
    return `Keep it to ${INSTALL_NAME_MAX_V1} characters.`;
  }
  if (!INSTALL_NAME_PATTERN.test(name) || name.includes("--")) {
    return "Use lowercase letters, numbers and single dashes, starting with a letter.";
  }
  return undefined;
}

/** A name from what someone typed: lowercased, dashed, trimmed to fit. */
export function normalizeInstallNameV1(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, INSTALL_NAME_MAX_V1)
    .replace(/-+$/, "");
}

/** `tims-frockbot` for tim@example.com. */
export function suggestedInstallNameV1(email: string): string {
  const local = normalizeInstallNameV1(email.split("@")[0] ?? "");
  const base = local
    ? `${local.slice(0, INSTALL_NAME_MAX_V1 - 10)}-frockbot`
    : "frockbot";
  return normalizeInstallNameV1(base) || "frockbot";
}

/** A `workers.dev` subdomain for an account that has none yet. */
export function suggestedWorkersSubdomainV1(
  accountName: string,
  accountId: string,
): string {
  const base = normalizeInstallNameV1(accountName).slice(0, 40) || "frockbot";
  return `${base}-${accountId.slice(0, 6)}`;
}

export function installHostnameV1(
  name: string,
  workersSubdomain: string,
): string {
  return `${name}.${workersSubdomain}.workers.dev`;
}

export function installOriginV1(
  name: string,
  workersSubdomain: string,
): string {
  return `https://${installHostnameV1(name, workersSubdomain)}`;
}

/** The name the install gives a resource the release declares by role. */
export function resourceNameV1(installName: string, role: string): string {
  return `${installName}-${role}`;
}

/** A Zero Trust team name for an account that has never had one. */
export function suggestedTeamNameV1(
  accountName: string,
  accountId: string,
): string {
  const base = normalizeInstallNameV1(accountName).slice(0, 30) || "frockbot";
  return `${base}-${accountId.slice(0, 6)}`;
}

// --- Account checks ---------------------------------------------------------

export type CheckIdV1 = "workers-paid" | "r2" | "workers-ai" | "zero-trust";
export type CheckStateV1 = "ok" | "fix" | "unknown";

export interface AccountCheckV1 {
  readonly id: CheckIdV1;
  readonly title: string;
  readonly state: CheckStateV1;
  readonly detail: string;
  /** Where the fix is, when there is one to make. */
  readonly fixUrl?: string;
  readonly fixLabel?: string;
}

export function dashboardUrlV1(accountId: string, path: string): string {
  return `https://dash.cloudflare.com/${accountId}/${path}`;
}

export function workersPaidCheckV1(
  accountId: string,
  paid: boolean | undefined,
): AccountCheckV1 {
  if (paid === true) {
    return {
      id: "workers-paid",
      title: "Workers Paid plan",
      state: "ok",
      detail:
        "Found. FrockBot runs on Workers, Durable Objects and storage it includes.",
    };
  }
  return {
    id: "workers-paid",
    title: "Workers Paid plan",
    state: paid === false ? "fix" : "unknown",
    detail:
      paid === false
        ? "This account is on the free Workers plan. FrockBot needs Workers Paid, which Cloudflare bills at $5 a month."
        : "We couldn’t read this account’s plan. If it’s already on Workers Paid, check again.",
    fixUrl: dashboardUrlV1(accountId, "workers/plans"),
    fixLabel: "Choose Workers Paid",
  };
}

export function r2CheckV1(
  accountId: string,
  enabled: boolean | undefined,
): AccountCheckV1 {
  if (enabled === true) {
    return {
      id: "r2",
      title: "R2 storage",
      state: "ok",
      detail: "On. Your bots’ files and memory are kept here.",
    };
  }
  return {
    id: "r2",
    title: "R2 storage",
    state: enabled === false ? "fix" : "unknown",
    detail:
      enabled === false
        ? "This account hasn’t turned on R2 yet. Turn it on once in Cloudflare; the free allowance covers a personal install."
        : "We couldn’t check R2 on this account. Check again in a moment.",
    fixUrl: dashboardUrlV1(accountId, "r2/overview"),
    fixLabel: "Turn on R2",
  };
}

export function workersAiCheckV1(
  accountId: string,
  available: boolean | undefined,
): AccountCheckV1 {
  if (available === true) {
    return {
      id: "workers-ai",
      title: "Workers AI",
      state: "ok",
      detail:
        "Available. Jev, chat, dictation and images can use it, billed by Cloudflare.",
    };
  }
  return {
    id: "workers-ai",
    title: "Workers AI",
    state: available === false ? "fix" : "unknown",
    detail:
      available === false
        ? "Jev isn’t in this account’s Workers AI catalog yet. Open Workers AI once in Cloudflare, then check again."
        : "We couldn’t reach Workers AI on this account. Check again in a moment.",
    fixUrl: dashboardUrlV1(accountId, "ai/workers-ai"),
    fixLabel: "Open Workers AI",
  };
}

export function zeroTrustCheckV1(
  accountId: string,
  enabled: boolean | undefined,
): AccountCheckV1 {
  if (enabled === true) {
    return {
      id: "zero-trust",
      title: "Zero Trust team",
      state: "ok",
      detail: "Found. Cloudflare Access will let only you sign in.",
    };
  }
  return {
    id: "zero-trust",
    title: "Zero Trust team",
    state: enabled === false ? "fix" : "unknown",
    detail:
      enabled === false
        ? "This account hasn’t turned on Zero Trust yet. It’s what lets only you sign in. Turn it on once in Cloudflare and choose the Free plan; Cloudflare asks for a payment method but doesn’t charge for it. We set up the rest."
        : "We couldn’t check Zero Trust on this account. Check again in a moment.",
    fixUrl: `https://one.dash.cloudflare.com/${accountId}/`,
    fixLabel: "Turn on Zero Trust",
  };
}

export function checksPassV1(checks: readonly AccountCheckV1[]): boolean {
  return checks.length > 0 && checks.every((check) => check.state === "ok");
}

// --- The deploy's steps ----------------------------------------------------

export type DeployStepIdV1 =
  "storage" | "release" | "sign-in" | "workers-ai" | "first-check";
export type StepStateV1 = "waiting" | "running" | "done" | "failed";

export interface DeployStepV1 {
  readonly id: DeployStepIdV1;
  readonly state: StepStateV1;
  readonly detail?: string;
}

/**
 * Sign-in comes before the release: the Worker is uploaded with the audience
 * Access issued, and nothing is reachable before Access stands in front of it.
 */
export const DEPLOY_STEPS_V1: readonly DeployStepIdV1[] = [
  "storage",
  "sign-in",
  "release",
  "workers-ai",
  "first-check",
];

export function stepTitleV1(id: DeployStepIdV1, version: string): string {
  switch (id) {
    case "storage":
      return "Storage";
    case "release":
      return `FrockBot release ${version}`;
    case "sign-in":
      return "Sign-in";
    case "workers-ai":
      return "Jev and Workers AI";
    case "first-check":
      return "First check";
  }
}

export function stepWaitingTextV1(id: DeployStepIdV1, email: string): string {
  switch (id) {
    case "storage":
      return "Creating the database, file storage and search index.";
    case "release":
      return "Deploying the app and its web client.";
    case "sign-in":
      return `Creating the Cloudflare Access application for ${email}.`;
    case "workers-ai":
      return "Connecting Jev to your account’s Workers AI.";
    case "first-check":
      return "Opening your install and checking it answers.";
  }
}

export function stepDoneTextV1(id: DeployStepIdV1, email: string): string {
  switch (id) {
    case "storage":
      return "Created the database, file storage and search index.";
    case "release":
      return "Deployed the app and its web client.";
    case "sign-in":
      return `Only ${email} can sign in.`;
    case "workers-ai":
      return "Jev runs on your account’s Workers AI.";
    case "first-check":
      return "Your install answered, behind Cloudflare Access.";
  }
}

export function initialStepsV1(): DeployStepV1[] {
  return DEPLOY_STEPS_V1.map((id) => ({ id, state: "waiting" }));
}

/** Percent done, for the bar: finished steps, plus half of a running one. */
export function progressPercentV1(steps: readonly DeployStepV1[]): number {
  if (steps.length === 0) return 0;
  const units = steps.reduce(
    (sum, step) =>
      sum + (step.state === "done" ? 1 : step.state === "running" ? 0.5 : 0),
    0,
  );
  return Math.round((units / steps.length) * 100);
}

// --- The Worker upload ------------------------------------------------------

/** What the deployer created for this install, that bindings resolve to. */
export interface ResolvedResourcesV1 {
  readonly installName: string;
  readonly origin: string;
  readonly ownerEmail: string;
  readonly accessTeamDomain: string;
  readonly accessAud: string;
  readonly kvNamespaceIds: Readonly<Record<string, string>>;
  readonly d1DatabaseIds: Readonly<Record<string, string>>;
}

function missing(kind: string, role: string): never {
  throw new Error(
    `The deploy did not create the ${kind} "${role}" this release binds`,
  );
}

/** One binding as the Workers script upload API spells it. */
export function uploadBindingV1(
  binding: BundleBindingV1,
  resources: ResolvedResourcesV1,
): Record<string, unknown> {
  const named = (role: string) => resourceNameV1(resources.installName, role);
  switch (binding.type) {
    case "ai":
    case "worker_loader":
    case "assets":
    case "version_metadata":
      return { type: binding.type, name: binding.name };
    case "durable_object_namespace":
      return {
        type: binding.type,
        name: binding.name,
        class_name: binding.className,
      };
    case "r2_bucket":
      return {
        type: binding.type,
        name: binding.name,
        bucket_name: named(binding.bucket),
      };
    case "kv_namespace":
      return {
        type: binding.type,
        name: binding.name,
        namespace_id:
          resources.kvNamespaceIds[binding.namespace] ??
          missing("KV namespace", binding.namespace),
      };
    case "d1":
      return {
        type: binding.type,
        name: binding.name,
        id:
          resources.d1DatabaseIds[binding.database] ??
          missing("database", binding.database),
      };
    case "vectorize":
      return {
        type: binding.type,
        name: binding.name,
        index_name: named(binding.index),
      };
    case "queue":
      return {
        type: binding.type,
        name: binding.name,
        queue_name: named(binding.queue),
      };
    case "analytics_engine":
      return {
        type: binding.type,
        name: binding.name,
        dataset: named(binding.dataset),
      };
    case "plain_text":
      return { type: binding.type, name: binding.name, text: binding.text };
    case "install_origin":
      return { type: "plain_text", name: binding.name, text: resources.origin };
    case "access_team_domain":
      return {
        type: "plain_text",
        name: binding.name,
        text: resources.accessTeamDomain,
      };
    case "access_aud":
      return {
        type: "plain_text",
        name: binding.name,
        text: resources.accessAud,
      };
    case "owner_email":
      return {
        type: "plain_text",
        name: binding.name,
        text: resources.ownerEmail,
      };
  }
}

/**
 * The Durable Object migrations still due, as the upload API takes them.
 *
 * Only the ones after the tag the Worker already carries: replaying an applied
 * migration is refused, and skipping one is a class with no storage. A tag the
 * release no longer lists means the install is on a history this release does
 * not continue, and deploying over it could lose Durable Object data, so it
 * stops rather than guesses.
 */
export function dueMigrationsV1(
  migrations: readonly BundleMigrationV1[],
  currentTag: string | undefined,
): Record<string, unknown> | undefined {
  let start = 0;
  if (currentTag) {
    const index = migrations.findIndex((m) => m.tag === currentTag);
    if (index < 0) {
      throw new Error(
        `This install's Durable Objects are at migration ${currentTag}, which this release doesn't continue from. Updating could lose data, so nothing was changed.`,
      );
    }
    start = index + 1;
  }
  const due = migrations.slice(start);
  if (due.length === 0) return undefined;
  return {
    ...(currentTag ? { old_tag: currentTag } : {}),
    new_tag: due[due.length - 1]!.tag,
    steps: due.map((m) => ({
      ...(m.newSqliteClasses?.length
        ? { new_sqlite_classes: m.newSqliteClasses }
        : {}),
      ...(m.deletedClasses?.length
        ? { deleted_classes: m.deletedClasses }
        : {}),
      ...(m.renamedClasses?.length
        ? { renamed_classes: m.renamedClasses }
        : {}),
    })),
  };
}

/** The `metadata` part of the script upload. */
export function scriptMetadataV1(
  worker: BundleWorkerV1,
  resources: ResolvedResourcesV1,
  options: {
    readonly currentMigrationTag: string | undefined;
    readonly mintedSecrets: Readonly<Record<string, string>>;
    readonly assetsJwt: string | undefined;
  },
): Record<string, unknown> {
  const bindings: Record<string, unknown>[] = worker.bindings.map((b) =>
    uploadBindingV1(b, resources),
  );
  for (const [name, text] of Object.entries(options.mintedSecrets)) {
    bindings.push({ type: "secret_text", name, text });
  }
  const migrations = dueMigrationsV1(
    worker.migrations,
    options.currentMigrationTag,
  );
  return {
    main_module: worker.mainModule,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: worker.compatibilityFlags,
    bindings,
    // The secrets minted on the first deploy stay; they sign and encrypt what
    // the install has stored, and nobody but the Worker ever reads them back.
    keep_bindings: ["secret_text"],
    observability: { enabled: true },
    ...(migrations ? { migrations } : {}),
    ...(worker.assets && options.assetsJwt
      ? {
          assets: {
            jwt: options.assetsJwt,
            config: {
              ...(worker.assets.htmlHandling
                ? { html_handling: worker.assets.htmlHandling }
                : {}),
              ...(worker.assets.notFoundHandling
                ? { not_found_handling: worker.assets.notFoundHandling }
                : {}),
              ...(worker.assets.runWorkerFirst !== undefined
                ? { run_worker_first: worker.assets.runWorkerFirst }
                : {}),
            },
          },
        }
      : {}),
  };
}

export const MODULE_CONTENT_TYPES_V1 = {
  esm: "application/javascript+module",
  commonjs: "application/javascript",
  wasm: "application/wasm",
  text: "text/plain",
  data: "application/octet-stream",
} as const;

const ASSET_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  json: "application/json",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  map: "application/json",
  riv: "application/octet-stream",
  bin: "application/octet-stream",
  frag: "text/plain",
};

export function assetContentTypeV1(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ASSET_TYPES[extension] ?? "application/octet-stream";
}

/** Secrets the release wants that this Worker doesn't hold yet. */
export function secretsToMintV1(
  worker: BundleWorkerV1,
  existing: readonly string[],
): BundleWorkerV1["secrets"] {
  return worker.secrets.filter((secret) => !existing.includes(secret.name));
}

export function randomHexV1(
  bytes = crypto.getRandomValues(new Uint8Array(32)),
): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A credential keyring in the shape the app Worker parses. */
export function credentialKeyringV1(
  now: Date,
  bytes = crypto.getRandomValues(new Uint8Array(32)),
): string {
  const keyId = now.toISOString().slice(0, 7);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId: keyId,
    keys: { [keyId]: key },
  });
}

export function mintSecretV1(shape: "hex" | "keyring", now: Date): string {
  return shape === "keyring" ? credentialKeyringV1(now) : randomHexV1();
}

export function appWorkerV1(manifest: ReleaseBundleManifestV1): BundleWorkerV1 {
  const worker = manifest.workers.find((w) => w.role === "app");
  if (!worker) throw new Error("This release has no app Worker");
  return worker;
}

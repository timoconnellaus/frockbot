import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseJsoncV1 } from "./jsonc.ts";
import {
  decodeBrandV1,
  isBuiltInAuthPackageIdV1,
  type AuthPackageSettingV1,
  type BuiltInAuthPackageIdV1,
} from "@frockbot/core/contracts";
import {
  PACKAGE_ROOT_V1,
  type DeploymentProfileV1,
  type DeploymentWorkerV1,
} from "./profile.ts";

/**
 * The deployables, and where each one's tracked template lives, relative to
 * the directory this package sits in: `apps/` in the FrockBot repository.
 *
 * Only the app Worker is `@frockbot/cloudflare` itself, and so the only one a
 * consumer's `node_modules` carries. The others are read from beside it when
 * they are there, which they are in a FrockBot checkout; a profile outside it
 * that names one is refused with the reason (see `readTemplateV1`).
 */
export const DEPLOYABLE_WORKERS_V1 = {
  app: { directory: "cloudflare" },
  computerHost: { directory: "computer-host" },
  appletBuild: { directory: "applet-build" },
  marketing: { directory: "marketing" },
  adminPortal: { directory: "admin-portal" },
} as const;

export type DeployableWorkerV1 = keyof typeof DEPLOYABLE_WORKERS_V1;

/** The directory one Worker's generated config is written to, under a profile. */
export const WORKER_OUTPUT_DIRECTORIES_V1: Record<DeployableWorkerV1, string> =
  {
    app: "app",
    computerHost: "computer-host",
    appletBuild: "applet-build",
    marketing: "marketing",
    adminPortal: "admin-portal",
  };

/**
 * The image `release.yml` publishes for each container Worker. One name per
 * image rather than per deployment: every deployment that pulls rather than
 * builds pulls the same bytes for a given tag.
 */
export const CONTAINER_IMAGE_REPOSITORIES_V1: Partial<
  Record<DeployableWorkerV1, string>
> = {
  computerHost: "frockbot-computer-host",
  appletBuild: "frockbot-applet-build",
};

/**
 * Where `release.yml` pushes them, and so the default an installer writes into
 * a profile. Docker Hub because Cloudflare pulls a *public* image from it with
 * no credentials configured in the pulling account, which is the only registry
 * of the four it supports where that is true (see the README).
 */
export const PUBLISHED_IMAGE_REGISTRY_V1 = "docker.io/timoconnellaus";

/**
 * The specifier the Worker imports its sign-in Package through.
 *
 * `apps/cloudflare/package.json` maps it to the better-auth chooser, which is
 * what `wrangler dev`, every suite and the hosted deploy resolve. An `access`
 * profile's generated config aliases it to the other chooser, and a profile
 * that names a chooser by path — a white-label's own Package (ADR 0038 §3) —
 * aliases it to that file, so the build a deployment ships is decided by its
 * own config and no bundle carries a Package it did not choose. A bare
 * specifier rather than a relative path because esbuild — which is what
 * wrangler's `alias` reaches — refuses to alias a relative import.
 */
const AUTH_PACKAGE_ALIAS_V1 = "#auth-package";

/** The build the tracked source already resolves to, so no alias is written. */
const TRACKED_AUTH_PACKAGE_V1 = "better-auth";

/** The chooser each built-in auth Package's build resolves that specifier to. */
export const AUTH_PACKAGE_CHOOSERS_V1: Record<BuiltInAuthPackageIdV1, string> =
  {
    "better-auth": "./src/auth-package.ts",
    access: "./src/auth-package.access.ts",
  };

/**
 * The specifier the Worker imports its brand through
 * ([ADR 0038](../../docs/adr/0038-white-label-deployments.md)).
 *
 * The same shape as `#auth-package`: `apps/cloudflare/package.json` maps it to
 * FrockBot's brand, and a profile that names its own brand module gets an
 * alias to that file. No alias is written otherwise, so the hosted and staging
 * configs are unchanged by the seam.
 */
export const BRAND_ALIAS_V1 = "#brand";

/**
 * Config values that name a file or directory. `wrangler -c <path>` resolves
 * each one against the config's own directory, so a generated config that
 * copied them verbatim would look for `src/index.ts` inside `.deployment/`.
 */
const PATH_FIELDS_V1 = [
  ["$schema"],
  ["main"],
  ["assets", "directory"],
  // Written below as the app template's own relative path, then rewritten with
  // every other path so wrangler resolves it from `.deployment/` too.
  ["alias", AUTH_PACKAGE_ALIAS_V1],
  ["alias", BRAND_ALIAS_V1],
] as const;

export interface GenerateOptionsV1 {
  profile: DeploymentProfileV1;
  /**
   * The `AUTH_DB` identifier when the profile leaves it to the deploy: a
   * disposable stage creates its database in the same job that deploys it.
   */
  d1DatabaseId?: string;
  /**
   * The sha256 of the application artifact this deployment uploaded, which is
   * the R2 key it is stored under. Resolved by whoever uploads it — the release
   * job, or the installer for the tag it downloaded — so it is a flag rather
   * than a profile field, the way `d1DatabaseId` is.
   */
  applicationHash?: string;
  /**
   * Where the profile file lives, which a `brand`, `webClient` or auth
   * Package path is relative to.
   */
  profileDirectory: string;
  /** Where `<name>/<worker>/wrangler.jsonc` is written: a `.deployment/`. */
  outputRoot: string;
  /**
   * The directory the Worker templates sit in, as `DEPLOYABLE_WORKERS_V1`
   * names them. The one this package is in, except in tests.
   */
  workersRoot?: string;
}

export interface GeneratedConfigV1 {
  worker: DeployableWorkerV1;
  /** Where the config was written, or would be. */
  file: string;
  config: Record<string, unknown>;
}

function derivedWorkerNameV1(
  worker: DeployableWorkerV1,
  profile: DeploymentProfileV1,
): string {
  const configured = profile.workers?.[worker]?.name;
  if (configured) return configured;
  switch (worker) {
    case "app":
      return profile.prefix;
    case "computerHost":
      return `${profile.prefix}-computer-host`;
    case "appletBuild":
      return `${profile.prefix}-applet-build`;
    case "marketing":
      return `${profile.prefix}-marketing`;
    case "adminPortal":
      return `${profile.prefix}-admin-portal`;
  }
}

/**
 * The bucket, index and database names this profile binds.
 *
 * Exported because the installer creates and writes to exactly these, and a
 * second derivation of the same names is a bucket nothing opens.
 */
export function resourceNamesV1(profile: DeploymentProfileV1) {
  const named = profile.resources ?? {};
  return {
    applicationArtifactsBucket:
      named.applicationArtifactsBucket ??
      `${profile.prefix}-application-artifacts`,
    memoryFilesBucket:
      named.memoryFilesBucket ?? `${profile.prefix}-memory-files`,
    memoryIndex: named.memoryIndex ?? `${profile.prefix}-memory`,
    authDatabaseName: named.authDatabaseName ?? `${profile.prefix}-auth`,
  };
}

/** Which Workers a profile deploys: the ones it names. */
export function profileWorkersV1(
  profile: DeploymentProfileV1,
): DeployableWorkerV1[] {
  const named = profile.workers ?? {};
  return (Object.keys(DEPLOYABLE_WORKERS_V1) as DeployableWorkerV1[]).filter(
    (worker) => named[worker] !== undefined,
  );
}

function readTemplateV1(workersRoot: string, worker: DeployableWorkerV1) {
  const directory = join(workersRoot, DEPLOYABLE_WORKERS_V1[worker].directory);
  const file = join(directory, "wrangler.jsonc");
  if (!existsSync(file)) {
    throw new Error(
      `${worker} has no tracked wrangler config at ${file}. Only the app Worker is published as @frockbot/cloudflare; ` +
        "deploy the other Workers from a FrockBot checkout of the same release.",
    );
  }
  const config = parseJsoncV1(readFileSync(file, "utf8"), file);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} is not a wrangler config`);
  }
  return { directory, config: config as Record<string, unknown> };
}

function entryAt(
  config: Record<string, unknown>,
  path: readonly string[],
): { holder: Record<string, unknown>; key: string } | undefined {
  let holder: Record<string, unknown> = config;
  for (const segment of path.slice(0, -1)) {
    const next = holder[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return undefined;
    }
    holder = next as Record<string, unknown>;
  }
  const key = path[path.length - 1]!;
  return key in holder ? { holder, key } : undefined;
}

/**
 * Rewrite every path in a config so it resolves from `to` the same place it
 * resolved from `from`. A path already absolute is left alone.
 */
function rewritePathsV1(
  config: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const rewrite = (value: unknown): string | undefined => {
    if (typeof value !== "string" || value === "" || isAbsolute(value)) {
      return undefined;
    }
    return relative(to, resolve(from, value)) || ".";
  };
  for (const path of PATH_FIELDS_V1) {
    const entry = entryAt(config, path);
    if (!entry) continue;
    const next = rewrite(entry.holder[entry.key]);
    if (next === undefined) continue;
    // esbuild reads an alias target without a leading dot as a package name.
    entry.holder[entry.key] =
      path[0] === "alias" && !next.startsWith(".") ? `./${next}` : next;
  }
  for (const database of asArray(config.d1_databases)) {
    const next = rewrite(database.migrations_dir);
    if (next !== undefined) database.migrations_dir = next;
  }
  for (const container of asArray(config.containers)) {
    for (const key of ["image", "image_build_context"] as const) {
      const next = rewrite(container[key]);
      if (next !== undefined) container[key] = next;
    }
  }
}

/**
 * Point the container entries at the published image instead of the Dockerfile.
 *
 * Runs after the path rewrite, because a registry reference is not a path and
 * resolving it against a directory would mangle it.
 */
function applyPublishedImagesV1(
  worker: DeployableWorkerV1,
  config: Record<string, unknown>,
  profile: DeploymentProfileV1,
): void {
  const images = profile.images;
  if (!images || images.source === "dockerfile") return;
  const containers = asArray(config.containers);
  if (containers.length === 0) return;
  const repository = CONTAINER_IMAGE_REPOSITORIES_V1[worker];
  if (!repository) {
    throw new Error(`${worker} fronts a container but publishes no image`);
  }
  for (const container of containers) {
    container.image = `${images.registry}/${repository}:${images.tag}`;
    // Nothing is built, so there is no context to build it in; wrangler refuses
    // the pair.
    delete container.image_build_context;
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

function bindingNamed(
  entries: Record<string, unknown>[],
  binding: string,
): Record<string, unknown> | undefined {
  return entries.find((entry) => entry.binding === binding);
}

/**
 * The brand module a profile names, as an absolute path, or undefined for
 * FrockBot's own.
 */
export function profileBrandModuleV1(
  profile: DeploymentProfileV1,
  profileDirectory: string,
): string | undefined {
  return profile.brand === undefined
    ? undefined
    : resolve(profileDirectory, profile.brand);
}

/**
 * Load the brand module a profile names and hold it to `BrandV1`: every look
 * through the ThemeDocument decoder and its contrast floor, and the icon a
 * file the artifact build can read. This is the build-time refusal of a brand
 * that would ship an unreadable look.
 */
export async function validateProfileBrandV1(
  profile: DeploymentProfileV1,
  profileDirectory: string,
): Promise<void> {
  const module = profileBrandModuleV1(profile, profileDirectory);
  if (module === undefined) return;
  if (!existsSync(module)) {
    throw new Error(
      `Profile "${profile.name}" names the brand ${profile.brand}, and there is no ${module}`,
    );
  }
  const loaded = (await import(module)) as { BRAND_V1?: unknown };
  const brand = decodeBrandV1(loaded.BRAND_V1);
  const icon = resolve(dirname(module), brand.iconPng);
  if (!existsSync(icon)) {
    throw new Error(
      `The brand at ${module} names the icon ${icon}, which does not exist`,
    );
  }
}

/**
 * The chooser module a profile names by path, as an absolute path, or
 * undefined for a built-in Package.
 */
export function profileAuthChooserV1(
  profile: DeploymentProfileV1,
  profileDirectory: string,
): string | undefined {
  return isBuiltInAuthPackageIdV1(profile.authPackage)
    ? undefined
    : resolve(profileDirectory, profile.authPackage);
}

/** The shape of a chooser module, as far as the generator reads one. */
interface LoadedAuthChooserV1 {
  AUTH_PACKAGE_V1?: {
    id?: unknown;
    required?: readonly AuthPackageSettingV1[];
    nativeTokenSecret?: { name?: unknown };
  };
}

/**
 * What the production-secrets check requires of a deploy's auth Package, for
 * a profile whose Package is not one this package ships: the chooser's own
 * name and the secrets its profile says it needs. Undefined for a built-in
 * Package, whose requirements the manifest already knows.
 */
export async function profileAuthPackageV1(
  profile: DeploymentProfileV1,
  profileDirectory: string,
): Promise<
  { id: string; required: readonly AuthPackageSettingV1[] } | undefined
> {
  const chooser = profileAuthChooserV1(profile, profileDirectory);
  if (chooser === undefined) return undefined;
  const id = (await loadAuthChooserV1(profile, chooser)).id;
  return { id, required: profile.authEnvironment?.secrets ?? [] };
}

async function loadAuthChooserV1(
  profile: DeploymentProfileV1,
  chooser: string,
): Promise<{ id: string; required: readonly AuthPackageSettingV1[] }> {
  if (!existsSync(chooser)) {
    throw new Error(
      `Profile "${profile.name}" names the auth Package ${profile.authPackage}, and there is no ${chooser}`,
    );
  }
  const build = ((await import(chooser)) as LoadedAuthChooserV1)
    .AUTH_PACKAGE_V1;
  if (
    typeof build !== "object" ||
    build === null ||
    typeof build.id !== "string" ||
    !Array.isArray(build.required)
  ) {
    throw new Error(
      `${chooser} exports no AUTH_PACKAGE_V1 with an id and its required settings; an auth Package chooser exports what apps/cloudflare/src/auth-package.ts does`,
    );
  }
  return { id: build.id, required: build.required };
}

/**
 * Load the chooser a profile names by path and hold it to its profile: it
 * must name itself something other than the two Packages this repository
 * ships, and the settings it requires must be exactly the ones the profile
 * says where to find — as secrets the release checks and deploys, or as vars
 * the config carries. A setting in neither would reach production unset, and
 * the Package would answer 503 to every sign-in.
 */
export async function validateProfileAuthPackageV1(
  profile: DeploymentProfileV1,
  profileDirectory: string,
): Promise<void> {
  const chooser = profileAuthChooserV1(profile, profileDirectory);
  if (chooser === undefined) return;
  const build = await loadAuthChooserV1(profile, chooser);
  if (isBuiltInAuthPackageIdV1(build.id)) {
    throw new Error(
      `${chooser} names itself "${build.id}", which is one of the Packages @frockbot/cloudflare ships; an external Package names itself`,
    );
  }
  const environment = profile.authEnvironment ?? {};
  const secrets = (environment.secrets ?? []).map((secret) => secret.name);
  const vars = Object.keys(environment.vars ?? {});
  const both = secrets.filter((name) => vars.includes(name));
  if (both.length > 0) {
    throw new Error(
      `Profile "${profile.name}" names ${both.join(", ")} as both a secret and a var`,
    );
  }
  const named = new Set([...secrets, ...vars]);
  const required = new Set(build.required.map((setting) => setting.name));
  const unnamed = [...required].filter((name) => !named.has(name));
  const unread = [...named].filter((name) => !required.has(name));
  if (unnamed.length > 0 || unread.length > 0) {
    throw new Error(
      [
        `Profile "${profile.name}"'s authEnvironment must name exactly what ${chooser} requires.`,
        ...(unnamed.length > 0
          ? [`Required and not named: ${unnamed.join(", ")}.`]
          : []),
        ...(unread.length > 0
          ? [`Named and not required: ${unread.join(", ")}.`]
          : []),
      ].join(" "),
    );
  }
}

function identityVarsV1(
  worker: DeployableWorkerV1,
  profile: DeploymentProfileV1,
): Record<string, string> {
  if (worker !== "app") return {};
  const vars: Record<string, string> = {};
  if (profile.nativeAuth) {
    vars.NATIVE_SLICE_2_AUTH = profile.nativeAuth.join(",");
  }
  if (profile.aiGateway?.id) vars.FROCK_AI_GATEWAY_ID = profile.aiGateway.id;
  if (profile.aiGateway) vars.FROCK_AI_ACCOUNT_ID = profile.aiGateway.accountId;
  if (profile.aiGateway?.autoRoute) {
    vars.FROCK_AI_AUTO_ROUTE = profile.aiGateway.autoRoute;
  }
  if (profile.access) {
    vars.ACCESS_TEAM_DOMAIN = profile.access.teamDomain;
    vars.ACCESS_AUD = profile.access.aud;
  }
  if (profile.email) vars.EMAIL_DOMAIN = profile.email.domain;
  Object.assign(vars, profile.authEnvironment?.vars ?? {});
  // A string rather than a JSON var, so it is read and decoded exactly like
  // every other setting the Worker takes (`native-auth.ts`).
  if (profile.nativeApps) vars.NATIVE_APPS = JSON.stringify(profile.nativeApps);
  return vars;
}

/**
 * The app Worker's outbound sender, Cloudflare Email Service, when the
 * profile names the email domain (`app/email/sender.ts`).
 *
 * Every Bot sends from its own address on that domain, and the binding cannot
 * say "any address on one domain": `allowed_sender_addresses` is a list of
 * exact addresses, with no wildcard or domain form
 * (developers.cloudflare.com/email-service/configuration/send-bindings/,
 * read 2026-09-25). So the binding carries no sender restriction and the
 * sender enforces the domain instead: it composes every `from` itself, on
 * `EMAIL_DOMAIN`, and refuses any other before the binding is reached. The
 * platform refuses any domain the account has not onboarded for Email
 * Sending. No destination restriction either: a Bot writes to its owner, and a
 * draft card to whoever the person approved.
 */
function emailBindingsV1(
  worker: DeployableWorkerV1,
  profile: DeploymentProfileV1,
): Record<string, unknown>[] {
  if (worker !== "app" || !profile.email) return [];
  return [{ name: "SEND_EMAIL" }];
}

export function generateWorkerConfigV1(
  worker: DeployableWorkerV1,
  options: GenerateOptionsV1,
): GeneratedConfigV1 {
  const { profile, outputRoot } = options;
  const workersRoot = options.workersRoot ?? join(PACKAGE_ROOT_V1, "..");
  const entry = profile.workers?.[worker];
  if (!entry) {
    throw new Error(`Profile "${profile.name}" does not deploy ${worker}`);
  }
  const template = readTemplateV1(workersRoot, worker);
  const config = structuredClone(template.config);
  const resources = resourceNamesV1(profile);

  // The `development` and `e2e` environments belong to the tracked file, where
  // `wrangler dev`, the suites and the harness read them. A generated config is
  // deployed, and a named environment in it would be a second Worker nobody
  // asked for.
  delete config.env;

  config.name = derivedWorkerNameV1(worker, profile);
  config.account_id = profile.accountId;

  const routes = entry.hostnames ?? [];
  if (routes.length > 0) {
    config.routes = routes.map((pattern) => ({
      pattern,
      custom_domain: true,
    }));
  } else {
    delete config.routes;
    // A Worker with no zone is reached on `workers.dev`. A template that has
    // already decided — the Computer host and the build service are reachable
    // only over a service binding — keeps its answer.
    if (!("workers_dev" in config)) config.workers_dev = true;
  }

  const buckets = asArray(config.r2_buckets);
  const artifacts = bindingNamed(buckets, "APPLICATION_ARTIFACTS");
  if (artifacts) artifacts.bucket_name = resources.applicationArtifactsBucket;
  const memoryFiles = bindingNamed(buckets, "MEMORY_FILES");
  if (memoryFiles) memoryFiles.bucket_name = resources.memoryFilesBucket;

  const index = bindingNamed(asArray(config.vectorize), "MEMORY_INDEX");
  if (index) index.index_name = resources.memoryIndex;

  const services = asArray(config.services);
  const computerHost = bindingNamed(services, "COMPUTER_HOST");
  if (computerHost) {
    computerHost.service = derivedWorkerNameV1("computerHost", profile);
  }
  const appletBuild = bindingNamed(services, "APPLET_BUILD");
  if (appletBuild) {
    appletBuild.service = derivedWorkerNameV1("appletBuild", profile);
  }
  // The admin portal's one binding: the app Worker's `AdminEntrypoint`.
  const app = bindingNamed(services, "APP");
  if (app) app.service = derivedWorkerNameV1("app", profile);

  const authDatabase = bindingNamed(asArray(config.d1_databases), "AUTH_DB");
  if (authDatabase) {
    const databaseId = options.d1DatabaseId ?? profile.d1DatabaseId;
    if (
      profile.authPackage === "access" ||
      (profile.authPackage !== "better-auth" && databaseId === undefined)
    ) {
      // The Access Package stores nothing, so the deployment has no database to
      // bind and the installer creates none. A white-label's Package gets the
      // `AUTH_DB` binding only when its profile names a database for it.
      delete config.d1_databases;
    } else {
      if (!databaseId) {
        throw new Error(
          `Profile "${profile.name}" builds better-auth but names no d1DatabaseId; pass --d1-database-id when the deploy creates it`,
        );
      }
      authDatabase.database_name = resources.authDatabaseName;
      authDatabase.database_id = databaseId;
    }
  }

  if (worker === "app" && profile.authPackage !== TRACKED_AUTH_PACKAGE_V1) {
    // Only when the profile builds another Package: the tracked source
    // already resolves `#auth-package` to the default chooser, so the hosted
    // and staging configs stay byte-for-byte what production runs and the
    // equivalence gate has nothing new to approve.
    const external = profileAuthChooserV1(profile, options.profileDirectory);
    config.alias = {
      ...((config.alias as Record<string, unknown>) ?? {}),
      // Written relative to the template, like the brand below, and rewritten
      // with every other path once the output directory is known.
      [AUTH_PACKAGE_ALIAS_V1]:
        external === undefined
          ? AUTH_PACKAGE_CHOOSERS_V1[
              profile.authPackage as BuiltInAuthPackageIdV1
            ]
          : relative(template.directory, external),
    };
  }

  if (worker === "app" && profile.webClient !== undefined) {
    // The white-label's own client, staged by `build-flutter-web.ts` from its
    // own application; rewritten from the template's directory below.
    config.assets = {
      ...((config.assets as Record<string, unknown>) ?? {}),
      directory: relative(
        template.directory,
        resolve(options.profileDirectory, profile.webClient),
      ),
    };
  }

  const brandModule =
    worker === "app"
      ? profileBrandModuleV1(profile, options.profileDirectory)
      : undefined;
  if (brandModule !== undefined) {
    // Written relative to the template, like the auth alias above, and
    // rewritten with every other path once the output directory is known.
    config.alias = {
      ...((config.alias as Record<string, unknown>) ?? {}),
      [BRAND_ALIAS_V1]: relative(template.directory, brandModule),
    };
  }

  const email = emailBindingsV1(worker, profile);
  if (email.length > 0) {
    config.send_email = [...asArray(config.send_email), ...email];
  }

  const identity = identityVarsV1(worker, profile);
  if (Object.keys(identity).length > 0) {
    config.vars = {
      ...((config.vars as Record<string, unknown>) ?? {}),
      ...identity,
    };
  }

  if (worker === "app" && options.applicationHash) {
    // The Worker loads its application from R2 under that file's own sha256, so
    // the var has to name the artifact this deployment actually uploaded. The
    // tracked placeholder `foundation-v1` is no object in anybody's bucket.
    config.vars = {
      ...((config.vars as Record<string, unknown>) ?? {}),
      DEFAULT_APPLICATION_HASH: options.applicationHash,
    };
  }

  const file = join(
    outputRoot,
    profile.name,
    WORKER_OUTPUT_DIRECTORIES_V1[worker],
    "wrangler.jsonc",
  );
  rewritePathsV1(config, template.directory, dirname(file));
  applyPublishedImagesV1(worker, config, profile);
  return { worker, file, config };
}

export function generateProfileConfigsV1(
  options: GenerateOptionsV1,
): GeneratedConfigV1[] {
  return profileWorkersV1(options.profile).map((worker) =>
    generateWorkerConfigV1(worker, options),
  );
}

export function writeGeneratedConfigsV1(
  generated: readonly GeneratedConfigV1[],
  profileName: string,
): void {
  for (const { file, config } of generated) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `// Generated by \`frockbot-deployment-config ${profileName}\`. Not tracked.\n` +
        `// Deployment identity comes from \`deployments/${profileName}.json\`; everything\n` +
        `// else is the tracked wrangler config this was derived from.\n` +
        `${JSON.stringify(config, null, 2)}\n`,
    );
  }
}

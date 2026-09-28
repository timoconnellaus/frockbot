#!/usr/bin/env bun
/**
 * `frockbot-deployment-config`: write the deployable wrangler configs for one
 * deployment profile, and check a deploy's secrets against it.
 *
 * The tracked `wrangler.jsonc` files hold bindings, migrations and comments and
 * no deployment identity at all; a profile holds the identity. This joins them
 * and writes `<out>/<profile>/<worker>/wrangler.jsonc`, which is what
 * `wrangler deploy -c` takes (ADR 0028 step 3). A white-label runs it from its
 * own repository, where `deployments/<name>.json` names its brand and its own
 * auth Package by path (ADR 0038 §5):
 *
 *   frockbot-deployment-config <profile> [--profiles <dir>] [--out <dir>]
 *                              [--d1-database-id <uuid>] [--application-hash <sha256>]
 *   frockbot-deployment-config secrets <profile> check [--profiles <dir>]
 *   frockbot-deployment-config secrets <profile> write-secrets-file <path> [--profiles <dir>]
 *
 * `--profiles` defaults to `./deployments` and `--out` to `./.deployment`.
 * Bun runs it: the package is TypeScript source, as wrangler bundles it.
 */
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  AUTH_PACKAGE_CHOOSERS_V1,
  PAYMENTS_CHOOSERS_V1,
  generateProfileConfigsV1,
  profileAuthPackageV1,
  profileBrandModuleV1,
  profilePaymentsPackageV1,
  profilePaymentsV1,
  validateProfileAuthPackageV1,
  validateProfileBrandV1,
  validateProfilePaymentsPackageV1,
  writeGeneratedConfigsV1,
} from "./generate.ts";
import { loadProfileV1, PACKAGE_ROOT_V1 } from "./profile.ts";

export interface DeploymentConfigCliOptionsV1 {
  /** Where `<name>.json` is read from. */
  profileDirectory: string;
  /** Where `<name>/<worker>/wrangler.jsonc` is written. */
  outputRoot: string;
  /** What printed paths are relative to. */
  displayRoot: string;
  /** How a usage error names the command. */
  command: string;
}

class UsageError extends Error {}

function takeFlag(
  args: string[],
  names: readonly string[],
): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length;) {
    const flag = args[index]!;
    if (!names.includes(flag)) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    flags[flag] = value;
    args.splice(index, 2);
  }
  return flags;
}

async function generate(
  args: string[],
  options: DeploymentConfigCliOptionsV1,
): Promise<number> {
  const flags = takeFlag(args, ["--d1-database-id", "--application-hash"]);
  const [name, ...rest] = args;
  if (!name || name.startsWith("-") || rest.length > 0) {
    throw new UsageError(
      `usage: ${options.command} <profile> [--d1-database-id <uuid>] [--application-hash <sha256>]`,
    );
  }
  const { profileDirectory } = options;
  const profile = loadProfileV1(name, profileDirectory);
  await validateProfileBrandV1(profile, profileDirectory);
  await validateProfileAuthPackageV1(profile, profileDirectory);
  await validateProfilePaymentsPackageV1(profile, profileDirectory);
  const d1DatabaseId = flags["--d1-database-id"];
  const applicationHash = flags["--application-hash"];
  const generated = generateProfileConfigsV1({
    profile,
    profileDirectory,
    outputRoot: options.outputRoot,
    ...(d1DatabaseId === undefined ? {} : { d1DatabaseId }),
    ...(applicationHash === undefined ? {} : { applicationHash }),
  });
  writeGeneratedConfigsV1(generated, profile.name);

  const shown = (path: string) => relative(options.displayRoot, path);
  const external = await profileAuthPackageV1(profile, profileDirectory);
  const brand = profileBrandModuleV1(profile, profileDirectory);
  const payments = await profilePaymentsPackageV1(profile, profileDirectory);
  console.log(`Deployment profile ${profile.name}`);
  console.log(`  account        ${profile.accountId}`);
  console.log(
    `  auth Package   ${
      external === undefined
        ? `${profile.authPackage} (${shown(
            resolve(
              PACKAGE_ROOT_V1,
              AUTH_PACKAGE_CHOOSERS_V1[
                profile.authPackage as keyof typeof AUTH_PACKAGE_CHOOSERS_V1
              ],
            ),
          )})`
        : `${external.id} (${shown(resolve(profileDirectory, profile.authPackage))})`
    }`,
  );
  console.log(
    `  payments       ${
      payments === undefined
        ? `${profilePaymentsV1(profile)} (${shown(
            resolve(
              PACKAGE_ROOT_V1,
              PAYMENTS_CHOOSERS_V1[
                profilePaymentsV1(profile) as keyof typeof PAYMENTS_CHOOSERS_V1
              ],
            ),
          )})`
        : `${payments.id} (${shown(resolve(profileDirectory, profilePaymentsV1(profile)))})`
    }`,
  );
  console.log(
    `  brand          ${
      brand === undefined
        ? `FrockBot (${shown(resolve(PACKAGE_ROOT_V1, "src/brand.ts"))})`
        : shown(brand)
    }`,
  );
  // Whether the deploy needs Docker is the difference worth printing here,
  // for a profile that deploys a container Worker at all.
  if (profile.workers?.computerHost || profile.workers?.appletBuild) {
    console.log(
      `  images         ${
        profile.images?.source === "registry"
          ? `pulled from ${profile.images.registry} at ${profile.images.tag}`
          : "built from the Dockerfile, which needs Docker"
      }`,
    );
  }
  for (const { worker, config, file } of generated) {
    const hostnames = (
      (config.routes as { pattern: string }[] | undefined) ?? []
    ).map((route) => route.pattern);
    const reach =
      hostnames.length > 0
        ? `on ${hostnames.join(", ")}`
        : config.workers_dev === false
          ? "reached only over a service binding"
          : "on workers.dev";
    console.log(`  ${worker.padEnd(13)}${String(config.name)} ${reach}`);
    console.log(`                 ${shown(file)}`);
  }
  return 0;
}

/**
 * The production-secrets check for a profile, which is how a white-label's
 * own auth Package's secrets are checked and deployed: the manifest cannot
 * know them, and the profile names them.
 */
async function secrets(
  args: string[],
  options: DeploymentConfigCliOptionsV1,
): Promise<number> {
  const [name, action, path, ...rest] = args;
  const usage = `usage: ${options.command} secrets <profile> check | write-secrets-file <path>`;
  if (!name || rest.length > 0) throw new UsageError(usage);
  const profile = loadProfileV1(name, options.profileDirectory);
  await validateProfileAuthPackageV1(profile, options.profileDirectory);
  await validateProfilePaymentsPackageV1(profile, options.profileDirectory);
  const auth = await profileAuthPackageV1(profile, options.profileDirectory);
  const payments = await profilePaymentsPackageV1(
    profile,
    options.profileDirectory,
  );
  // Only here: the manifest reaches the Worker's own choosers through
  // `#auth-package` and `#payments`, which writing a config has no reason to
  // load. A built-in Package the profile chose is the manifest's to know by
  // name; its own default is the tracked build's.
  const { deployedSecretNamesV1, productionSecretsReportV1 } =
    await import("../src/production-secrets.ts");
  const paymentsBuild = payments ?? {
    id: profilePaymentsV1(profile),
    required: [],
  };
  if (action === "check" && path === undefined) {
    const report = productionSecretsReportV1(
      process.env,
      undefined,
      auth,
      paymentsBuild,
    );
    for (const warning of report.warnings) console.log(`warning: ${warning}`);
    for (const failure of report.failures) console.error(failure);
    if (report.ok) {
      console.log(
        `Production secrets check passed: ${deployedSecretNamesV1(auth, paymentsBuild).length} names carried by this deploy.`,
      );
    }
    return report.ok ? 0 : 1;
  }
  if (action === "write-secrets-file" && path !== undefined) {
    // JSON, as `wrangler deploy --secrets-file` reads first; an unset optional
    // name is omitted rather than written empty.
    const values: Record<string, string> = {};
    for (const secret of deployedSecretNamesV1(auth, paymentsBuild)) {
      const value = process.env[secret];
      if (value !== undefined && value !== "") values[secret] = value;
    }
    writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
    console.log(
      `Wrote ${Object.keys(values).length} secrets for wrangler --secrets-file.`,
    );
    return 0;
  }
  throw new UsageError(usage);
}

export async function runDeploymentConfigCliV1(
  argv: readonly string[],
  options: DeploymentConfigCliOptionsV1,
): Promise<number> {
  const args = [...argv];
  try {
    return args[0] === "secrets"
      ? await secrets(args.slice(1), options)
      : await generate(args, options);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  let flags: Record<string, string>;
  try {
    flags = takeFlag(args, ["--profiles", "--out"]);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  process.exit(
    await runDeploymentConfigCliV1(args, {
      profileDirectory: resolve(cwd, flags["--profiles"] ?? "deployments"),
      outputRoot: resolve(cwd, flags["--out"] ?? ".deployment"),
      displayRoot: cwd,
      command: "frockbot-deployment-config",
    }),
  );
}

#!/usr/bin/env bun
/**
 * Write the deployable wrangler configs for one deployment profile.
 *
 * The tracked `wrangler.jsonc` files hold bindings, migrations and comments and
 * no deployment identity at all; a profile holds the identity. This joins them
 * and writes `.deployment/<profile>/<worker>/wrangler.jsonc`, which is what
 * `wrangler deploy -c` takes (ADR 0028 step 3).
 *
 *   bun run deployment:config hosted
 *   bun run deployment:config staging --d1-database-id <uuid>
 */
import { relative } from "node:path";
import {
  AUTH_PACKAGE_CHOOSERS_V1,
  generateProfileConfigsV1,
  writeGeneratedConfigsV1,
} from "./deployment-config/generate.ts";
import { loadProfileV1, REPO_ROOT_V1 } from "./deployment-config/profile.ts";

function usage(): never {
  console.error(
    "usage: bun run deployment:config <profile> [--d1-database-id <uuid>] [--application-hash <sha256>]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const name = args[0];
if (!name || name.startsWith("-")) usage();

const flags: Record<string, string | undefined> = {};
for (let index = 1; index < args.length; index += 1) {
  const flag = args[index];
  if (flag !== "--d1-database-id" && flag !== "--application-hash") usage();
  const value = args[index + 1];
  if (!value) usage();
  flags[flag] = value;
  index += 1;
}
const d1DatabaseId = flags["--d1-database-id"];
const applicationHash = flags["--application-hash"];

const profile = loadProfileV1(name);
const generated = generateProfileConfigsV1({
  profile,
  ...(d1DatabaseId === undefined ? {} : { d1DatabaseId }),
  ...(applicationHash === undefined ? {} : { applicationHash }),
});
writeGeneratedConfigsV1(generated, profile.name);

console.log(`Deployment profile ${profile.name}`);
console.log(`  account        ${profile.accountId}`);
console.log(
  `  auth Package   ${profile.authPackage} (apps/cloudflare/${AUTH_PACKAGE_CHOOSERS_V1[profile.authPackage].replace("./", "")})`,
);
// Whether the deploy needs Docker is the difference worth printing here.
console.log(
  `  images         ${
    profile.images?.source === "registry"
      ? `pulled from ${profile.images.registry} at ${profile.images.tag}`
      : "built from the Dockerfile, which needs Docker"
  }`,
);
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
  console.log(`                 ${relative(REPO_ROOT_V1, file)}`);
}

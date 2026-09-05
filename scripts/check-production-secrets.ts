#!/usr/bin/env bun
/*
 * The gate between a release and a production Worker missing a secret.
 *
 * `check` runs in the release workflow before `wrangler deploy`: it compares
 * the manifest in `apps/cloudflare/src/production-secrets.ts` against the
 * environment the deploy job was given, and against the secrets the deployed
 * Worker already holds. A missing required secret fails here, named, with the
 * reason it matters — rather than 503-ing one feature in production until
 * somebody notices weeks later.
 *
 * `write-secrets-file <path>` writes the JSON `wrangler deploy --secrets-file`
 * consumes, from the same manifest, so the list that is checked and the list
 * that is deployed cannot drift apart.
 *
 * `revoke <NAME>` deletes one secret from the deployed Worker. It exists
 * because the deploy cannot: `--secrets-file` is additive, so dropping a name
 * from the production environment stops releases updating that secret and
 * leaves the value production is running on live and authorized. Revocation
 * is a deliberate act by an operator, never a side effect of a release, and
 * the release workflow never runs this command.
 *
 *   bun scripts/check-production-secrets.ts check [--live]
 *   bun scripts/check-production-secrets.ts write-secrets-file <path>
 *   bun scripts/check-production-secrets.ts revoke <NAME>
 */
import { writeFileSync } from "node:fs";
import {
  REQUIRED_PRODUCTION_SECRETS_V1,
  deployedSecretNamesV1,
  productionSecretsReportV1,
} from "../apps/cloudflare/src/production-secrets.js";

const workerDirectory = new URL("../apps/cloudflare/", import.meta.url)
  .pathname;

/** The secret names the deployed Worker holds, or undefined if unreadable. */
async function liveSecretNames(): Promise<string[] | undefined> {
  const listed = Bun.spawnSync({
    cmd: ["bunx", "wrangler", "secret", "list"],
    cwd: workerDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    console.warn(
      `Could not read the deployed Worker's secrets: ${listed.stderr.toString().trim()}`,
    );
    return undefined;
  }
  try {
    const parsed = JSON.parse(listed.stdout.toString()) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === "string"
        ? [(entry as { name: string }).name]
        : [],
    );
  } catch {
    return undefined;
  }
}

async function check(live: boolean): Promise<number> {
  const report = productionSecretsReportV1(
    process.env,
    live ? await liveSecretNames() : undefined,
  );
  for (const notice of report.notices) console.log(notice);
  for (const warning of report.warnings) {
    console.log(
      process.env.GITHUB_ACTIONS
        ? `::warning::${warning}`
        : `warning: ${warning}`,
    );
  }
  if (report.ok) {
    console.log(
      `Production secrets check passed: ${deployedSecretNamesV1().length} names carried by this deploy.`,
    );
    return 0;
  }
  for (const failure of report.failures) console.error(failure);
  console.error(
    "The manifest is apps/cloudflare/src/production-secrets.ts; docs/architecture/delivery.md says how it is used.",
  );
  return 1;
}

function writeSecretsFile(path: string): number {
  /*
   * Wrangler reads a secrets file as JSON first and only falls back to dotenv,
   * and a dotenv line keeps the backslash escapes inside a double-quoted
   * value — which would reach the Worker mangled for a secret that is itself
   * JSON, like the credential keyring. So: JSON. An unset optional name is
   * omitted rather than written empty.
   */
  const secrets: Record<string, string> = {};
  for (const name of deployedSecretNamesV1()) {
    const value = process.env[name];
    if (value !== undefined && value !== "") secrets[name] = value;
  }
  writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
  console.log(
    `Wrote ${Object.keys(secrets).length} secrets for wrangler --secrets-file.`,
  );
  return 0;
}

/**
 * Delete one secret from the deployed Worker.
 *
 * The only way a value stops being live. A required name is refused: deleting
 * it takes production down, and the operator who genuinely means to do that
 * can reach for wrangler directly. Everything else — a retired optional key, a
 * door left open by hand, a name nobody claims — is deleted here, named in the
 * output so the act is on the record. The name is not the value; nothing
 * secret is printed.
 */
function revoke(name: string): number {
  if (REQUIRED_PRODUCTION_SECRETS_V1.some((secret) => secret.name === name)) {
    console.error(
      `${name} is required in production: ${REQUIRED_PRODUCTION_SECRETS_V1.find((secret) => secret.name === name)?.why} Refusing to revoke it.`,
    );
    return 1;
  }
  console.log(`Deleting ${name} from the deployed Worker…`);
  const deleted = Bun.spawnSync({
    cmd: ["bunx", "wrangler", "secret", "delete", name],
    cwd: workerDirectory,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  if (deleted.exitCode !== 0) {
    console.error(`Could not delete ${name}; it is still live.`);
    return deleted.exitCode === null ? 1 : deleted.exitCode;
  }
  console.log(
    `${name} is deleted. Remove it from the production environment and from the manifest if it is named there, so no release puts it back.`,
  );
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "check") {
  process.exit(await check(rest.includes("--live")));
} else if (command === "write-secrets-file") {
  const path = rest[0];
  if (!path) {
    console.error("write-secrets-file needs a path");
    process.exit(1);
  }
  process.exit(writeSecretsFile(path));
} else if (command === "revoke") {
  const name = rest[0];
  if (!name) {
    console.error("revoke needs the name of one secret");
    process.exit(1);
  }
  process.exit(revoke(name));
} else {
  console.error(
    "usage: check-production-secrets.ts check [--live] | write-secrets-file <path> | revoke <NAME>",
  );
  process.exit(1);
}

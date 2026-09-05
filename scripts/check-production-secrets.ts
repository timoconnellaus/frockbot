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
 *   bun scripts/check-production-secrets.ts check [--live]
 *   bun scripts/check-production-secrets.ts write-secrets-file <path>
 */
import { writeFileSync } from "node:fs";
import {
  deployedSecretNamesV1,
  productionSecretsReportV1,
} from "../apps/cloudflare/src/production-secrets.js";

/** The secret names the deployed Worker holds, or undefined if unreadable. */
async function liveSecretNames(): Promise<string[] | undefined> {
  const listed = Bun.spawnSync({
    cmd: ["bunx", "wrangler", "secret", "list"],
    cwd: new URL("../apps/cloudflare/", import.meta.url).pathname,
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
} else {
  console.error(
    "usage: check-production-secrets.ts check [--live] | write-secrets-file <path>",
  );
  process.exit(1);
}

/// <reference types="bun" />
/*
 * The release gate, run as the release runs it.
 *
 * `production-secrets.test.ts` proves the manifest and the report in isolation.
 * This file proves the command an operator and the workflow actually invoke,
 * against a stubbed `wrangler` that answers with a live secret list — because
 * the thing that was wrong was not a wrong string in a report, it was the
 * script telling an operator that a deploy revokes a secret when
 * `--secrets-file` is additive and revokes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deployedSecretNamesV1,
  REQUIRED_PRODUCTION_SECRETS_V1,
} from "../apps/cloudflare/src/production-secrets.js";

const script = fileURLToPath(
  new URL("./check-production-secrets.ts", import.meta.url),
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A `bunx` that answers `wrangler secret list` and logs every call. */
async function stubbedWrangler(live: readonly string[]): Promise<{
  bin: string;
  log: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "frockbot-secrets-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  await mkdir(bin);
  const log = join(directory, "wrangler.log");
  const bunx = join(bin, "bunx");
  await Bun.write(
    bunx,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$WRANGLER_LOG"
if [[ "$2 $3" == "secret list" ]]; then
  printf '%s\\n' '${JSON.stringify(live.map((name) => ({ name })))}'
  exit 0
fi
if [[ "$2 $3" == "secret delete" ]]; then exit "\${WRANGLER_DELETE_EXIT:-0}"; fi
exit 0
`,
  );
  await chmod(bunx, 0o755);
  return { bin, log };
}

/** The environment a complete production release would hand the script. */
function completeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    deployedSecretNamesV1().map((name) => [name, `${name}-value`]),
  );
}

async function run(
  argv: readonly string[],
  options: {
    live?: readonly string[];
    environment?: Record<string, string>;
    deleteExit?: string;
  } = {},
): Promise<{ exitCode: number; output: string; calls: string[] }> {
  const { bin, log } = await stubbedWrangler(options.live ?? []);
  const child = Bun.spawn(["bun", script, ...argv], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      WRANGLER_LOG: log,
      ...(options.deleteExit
        ? { WRANGLER_DELETE_EXIT: options.deleteExit }
        : {}),
      ...(options.environment ?? completeEnvironment()),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const logged = await Bun.file(log).exists();
  return {
    exitCode,
    output: `${stdout}${stderr}`,
    calls: logged
      ? (await Bun.file(log).text()).trim().split("\n").filter(Boolean)
      : [],
  };
}

describe("check --live", () => {
  test("reports what an additive deploy does, and never claims a deletion", async () => {
    const { exitCode, output } = await run(["check", "--live"], {
      live: ["BETTER_AUTH_SECRET", "SOMETHING_SET_BY_HAND"],
    });

    expect(exitCode).toBe(0);
    // Every name the environment carries and the Worker does not hold yet.
    expect(output).toContain("This deploy adds");
    expect(output).toContain("APPLET_VIEWER_SECRET");
    expect(output).toContain("It overwrites 1 secret(s) the Worker already");
    expect(output).toContain("a deploy never deletes a secret");
    // The hand-set secret survives the release; the old copy said it would be
    // deleted, which is how an operator came to believe a release revokes.
    expect(output).toContain(
      "The deployed Worker holds a secret this release does not carry: SOMETHING_SET_BY_HAND",
    );
    expect(output).toContain("it stays live and in effect");
    expect(output).toContain("revoke SOMETHING_SET_BY_HAND");
    expect(output).not.toContain("deletes it");
    expect(output).not.toContain("replaces the whole secret set");
  });

  test("says an optional secret removed from GitHub is still live and unrevoked", async () => {
    const { COMPOSIO_API_KEY: _removed, ...environment } =
      completeEnvironment();
    const { exitCode, output } = await run(["check", "--live"], {
      environment,
      live: ["COMPOSIO_API_KEY"],
    });

    expect(exitCode).toBe(0);
    expect(output).toContain(
      "COMPOSIO_API_KEY is unset in this release's environment, but the deployed Worker still holds it",
    );
    expect(output).toContain("does not revoke it");
    expect(output).toContain(
      "bun scripts/check-production-secrets.ts revoke COMPOSIO_API_KEY",
    );
    // And it does not tell the operator Composio is off: it is still running
    // on the old key.
    expect(output).not.toContain("Composio Connections are unavailable");
  });

  test("fails the release when the Worker holds a door production must not have", async () => {
    const { exitCode, output } = await run(["check", "--live"], {
      live: ["ALLOW_DEVELOPMENT_AUTH"],
    });

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "The deployed Worker holds ALLOW_DEVELOPMENT_AUTH",
    );
    expect(output).toContain("sign in as any identity without Google");
    expect(output).toContain("revoke ALLOW_DEVELOPMENT_AUTH");
  });

  test("passes when the live Worker holds exactly what the release carries", async () => {
    const { exitCode, output } = await run(["check", "--live"], {
      live: deployedSecretNamesV1(),
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Production secrets check passed");
    expect(output).toContain("It leaves 0 live secret(s) untouched");
  });
});

describe("revoke", () => {
  test("deletes the named secret from the deployed Worker", async () => {
    const { exitCode, output, calls } = await run([
      "revoke",
      "SOMETHING_SET_BY_HAND",
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toContain("wrangler secret delete SOMETHING_SET_BY_HAND");
    expect(output).toContain("SOMETHING_SET_BY_HAND is deleted");
  });

  test("fails when wrangler could not delete it, saying it is still live", async () => {
    const { exitCode, output } = await run(["revoke", "COMPOSIO_API_KEY"], {
      deleteExit: "7",
    });

    expect(exitCode).toBe(7);
    expect(output).toContain("Could not delete COMPOSIO_API_KEY");
    expect(output).toContain("still live");
  });

  test("refuses to revoke a secret production requires", async () => {
    const required = REQUIRED_PRODUCTION_SECRETS_V1[0]?.name ?? "";
    const { exitCode, output, calls } = await run(["revoke", required]);

    expect(exitCode).toBe(1);
    expect(output).toContain(`${required} is required in production`);
    expect(calls).toEqual([]);
  });
});

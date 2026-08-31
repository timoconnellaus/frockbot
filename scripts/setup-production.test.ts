/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runProductionSetup(
  stdin: string,
  secretListMode:
    "missing" | "existing" | "failure" | "set-failure" = "missing",
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: string[];
}> {
  const directory = await temporaryDirectory("frockbot-setup-");
  const bin = join(directory, "bin");
  const ghLog = join(directory, "gh.log");
  await mkdir(bin);
  const gh = join(bin, "gh");
  const open = join(bin, "open");
  await Bun.write(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1 $2" == "secret list" ]]; then
  case "$GH_SECRET_LIST_MODE" in
    existing) printf 'CREDENTIAL_KEYRING\tUpdated\n' ;;
    failure) exit 42 ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "secret set" ]]; then
  if [[ "$GH_SECRET_LIST_MODE" == "set-failure" && "$3" == "CREDENTIAL_KEYRING" ]]; then
    exit 43
  fi
  value="$(cat)"
  printf 'secret-value:%s:%s\n' "$3" "$value" >> "$GH_LOG"
fi
`,
  );
  await Bun.write(open, "#!/usr/bin/env bash\nexit 0\n");
  await Promise.all([chmod(gh, 0o755), chmod(open, 0o755)]);

  const child = Bun.spawn(
    ["bash", fileURLToPath(new URL("./setup-production.sh", import.meta.url))],
    {
      cwd: directory,
      env: {
        ...process.env,
        ENV_FILE: join(directory, ".env"),
        GH_LOG: ghLog,
        GH_SECRET_LIST_MODE: secretListMode,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(stdin);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const calls = (await Bun.file(ghLog).text()).trim().split("\n");
  return { exitCode, stdout, stderr, calls };
}

describe("production setup", () => {
  test("provisions only active production integrations", async () => {
    const { exitCode, stdout, stderr, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\nsprites-production\n\n",
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "Checking environment secrets in timoconnellaus/frockbot…",
    );
    expect(stdout).toContain(
      "Stage 5/5 · GitHub: verify production configuration",
    );
    expect(calls).toContain(
      "secret set SPRITES_TOKEN --repo timoconnellaus/frockbot --env production",
    );
    expect(calls).toContain("secret-value:SPRITES_TOKEN:sprites-production");
    expect(calls).toContain(
      "secret set CREDENTIAL_KEYRING --repo timoconnellaus/frockbot --env production",
    );
    expect(
      calls.some((call) => call.startsWith("secret-value:CREDENTIAL_KEYRING:")),
    ).toBe(true);
    expect(calls.join("\n")).not.toContain("COMPOSIO");
    expect(calls.join("\n")).not.toContain(
      "FROCKBOT_AUTHORIZATION_STATE_SECRET",
    );
    expect(stdout).not.toContain("Composio");
  });

  test("aborts when the production keyring cannot be inspected", async () => {
    const { exitCode, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\nsprites-production\n\n",
      "failure",
    );

    expect(exitCode).not.toBe(0);
    expect(calls).not.toContain(
      "secret set CREDENTIAL_KEYRING --repo timoconnellaus/frockbot --env production",
    );
    expect(
      calls.some((call) => call.startsWith("secret-value:CREDENTIAL_KEYRING:")),
    ).toBe(false);
  });

  test("aborts when the generated production keyring cannot be stored", async () => {
    const { exitCode, stdout, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\nsprites-production\n\n",
      "set-failure",
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain(
      "could not set required production secret CREDENTIAL_KEYRING",
    );
    expect(calls).toContain(
      "secret set CREDENTIAL_KEYRING --repo timoconnellaus/frockbot --env production",
    );
    expect(stdout).not.toContain("Setup complete");
  });

  test("deploys without Composio configuration and forwards active secrets", async () => {
    const source = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    const workflow = Bun.YAML.parse(source) as {
      jobs: {
        "deploy-backend": {
          steps: Array<{
            name?: string;
            env?: Record<string, string>;
            run?: string;
          }>;
        };
      };
    };
    const deploymentSteps = workflow.jobs["deploy-backend"].steps;
    const validation = deploymentSteps.find(
      (step) => step.name === "Validate deployment configuration",
    );
    const deploy = deploymentSteps.find(
      (step) => step.name === "Deploy Worker",
    );
    expect(validation?.env).not.toHaveProperty("COMPOSIO_API_KEY");
    expect(validation?.env).not.toHaveProperty("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
    expect(validation?.env).not.toHaveProperty(
      "FROCKBOT_AUTHORIZATION_STATE_SECRET",
    );
    expect(deploy?.env?.SPRITES_TOKEN).toBe("${{ secrets.SPRITES_TOKEN }}");
    expect(validation?.env?.CREDENTIAL_KEYRING).toBe(
      "${{ secrets.CREDENTIAL_KEYRING }}",
    );
    expect(deploy?.env?.CREDENTIAL_KEYRING).toBe(
      "${{ secrets.CREDENTIAL_KEYRING }}",
    );

    const productionEnvironment = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
      CLOUDFLARE_D1_DATABASE_ID: "cloudflare-database",
      BETTER_AUTH_URL: "https://bot.frockbot.com",
      BETTER_AUTH_SECRET:
        "a87ad4f95378b32a7954573d8f0933e07bc99a6d3c58ae2b61d85fd43ac424eb",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      SPRITES_TOKEN: "sprites-production",
      CREDENTIAL_KEYRING:
        '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
    };
    const validConfiguration = Bun.spawnSync(
      ["bash", "-c", validation?.run ?? ""],
      { env: productionEnvironment, stdout: "pipe", stderr: "pipe" },
    );
    expect(validConfiguration.exitCode).toBe(0);

    const missingSprites = Bun.spawnSync(
      ["bash", "-c", validation?.run ?? ""],
      {
        env: { ...productionEnvironment, SPRITES_TOKEN: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(missingSprites.exitCode).toBe(1);
    expect(missingSprites.stderr.toString()).toContain(
      "Missing production configuration: SPRITES_TOKEN",
    );

    for (const invalidKeyring of [
      "not-json",
      '{"schemaVersion":1,"currentKeyId":"missing","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
      '{"schemaVersion":1,"currentKeyId":"toString","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
      '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"c2hvcnQ"}}',
    ]) {
      const invalidConfiguration = Bun.spawnSync(
        ["bash", "-c", validation?.run ?? ""],
        {
          env: {
            ...productionEnvironment,
            CREDENTIAL_KEYRING: invalidKeyring,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(invalidConfiguration.exitCode).not.toBe(0);
    }

    const directory = await temporaryDirectory("frockbot-workflow-");
    const runner = join(directory, "runner");
    const bin = join(directory, "bin");
    const capture = join(directory, "forwarded.env");
    await Promise.all([mkdir(runner), mkdir(bin)]);
    const bunx = join(bin, "bunx");
    await Bun.write(
      bunx,
      `#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  if [[ "$1" == "--secrets-file" ]]; then cp "$2" "$WORKFLOW_CAPTURE"; exit 0; fi
  shift
done
exit 1
`,
    );
    await chmod(bunx, 0o755);
    const execution = Bun.spawnSync(["bash", "-c", deploy?.run ?? ""], {
      cwd: directory,
      env: {
        ...productionEnvironment,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: runner,
        WORKFLOW_CAPTURE: capture,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(execution.exitCode).toBe(0);
    // Wrangler parses the secrets file as JSON before it tries dotenv, and
    // dotenv would keep the backslash escapes inside a double-quoted value —
    // a keyring forwarded that way reached production mangled. So the file
    // must be one JSON object, read exactly as Wrangler reads it.
    const forwarded = JSON.parse(await Bun.file(capture).text()) as Record<
      string,
      string
    >;
    expect(forwarded.SPRITES_TOKEN).toBe("sprites-production");
    expect(forwarded.CREDENTIAL_KEYRING).toBe(
      productionEnvironment.CREDENTIAL_KEYRING,
    );
    expect(forwarded).not.toHaveProperty("COMPOSIO_API_KEY");
    expect(forwarded).not.toHaveProperty("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
    expect(forwarded).not.toHaveProperty("FROCKBOT_AUTHORIZATION_STATE_SECRET");
  });
});

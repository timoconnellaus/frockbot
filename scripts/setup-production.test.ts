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
  // The Catalog bucket stage shells out to wrangler; the stub records the
  // call and reports the bucket as absent so the create path is exercised.
  const bunx = join(bin, "bunx");
  await Bun.write(
    bunx,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$3 $4" == "bucket info" ]]; then exit 1; fi
exit 0
`,
  );
  await Promise.all([chmod(gh, 0o755), chmod(open, 0o755), chmod(bunx, 0o755)]);

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
      "Stage 6/6 · GitHub: verify production configuration",
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

  test("provisions the Package Catalog bucket when it is absent", async () => {
    const { exitCode, stdout, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\nsprites-production\n\n",
    );

    expect(exitCode).toBe(0);
    expect(calls).toContain(
      "wrangler r2 bucket info frockbot-package-catalog --config apps/cloudflare/wrangler.jsonc",
    );
    expect(calls).toContain(
      "wrangler r2 bucket create frockbot-package-catalog --config apps/cloudflare/wrangler.jsonc",
    );
    expect(stdout).toContain("created");
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

  test("publishes the Package Catalog after the artifact, pointer last", async () => {
    const source = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    const workflow = Bun.YAML.parse(source) as {
      jobs: {
        "deploy-backend": {
          steps: Array<{ name?: string; run?: string }>;
        };
      };
    };
    const steps = workflow.jobs["deploy-backend"].steps;
    const artifactStep = steps.findIndex(
      (step) => step.name === "Upload application artifact",
    );
    const publishStep = steps.findIndex(
      (step) => step.name === "Publish Package Catalog",
    );
    expect(artifactStep).toBeGreaterThanOrEqual(0);
    // The Catalog indexes the Packages of the artifact that was just uploaded,
    // so it is published after it and before the Worker that serves it.
    expect(publishStep).toBeGreaterThan(artifactStep);
    expect(
      steps.findIndex((step) => step.name === "Deploy Worker"),
    ).toBeGreaterThan(publishStep);

    // The step is run for real against a stubbed wrangler: the publisher and
    // the upload order are the two things a broken generation would break.
    const directory = await temporaryDirectory("frockbot-catalog-");
    const bin = join(directory, "bin");
    const uploadLog = join(directory, "uploads.log");
    await mkdir(bin);
    const bunx = join(bin, "bunx");
    await Bun.write(
      bunx,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$UPLOAD_LOG"
if [[ "$3 $4" == "bucket info" ]]; then exit 1; fi
exit 0
`,
    );
    await chmod(bunx, 0o755);
    const execution = Bun.spawnSync(
      ["bash", "-c", steps[publishStep]?.run ?? ""],
      {
        cwd: fileURLToPath(new URL("../apps/cloudflare", import.meta.url)),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: directory,
          UPLOAD_LOG: uploadLog,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect({
      code: execution.exitCode,
      stderr: execution.stderr.toString(),
    }).toMatchObject({ code: 0 });

    const calls = (await Bun.file(uploadLog).text()).trim().split("\n");
    expect(calls[0]).toBe("wrangler r2 bucket info frockbot-package-catalog");
    expect(calls[1]).toBe("wrangler r2 bucket create frockbot-package-catalog");
    const puts = calls.filter((call) =>
      call.startsWith("wrangler r2 object put"),
    );
    expect(puts.length).toBeGreaterThan(2);
    // Nothing may name a generation before every object in it exists, so the
    // one mutable object in the whole Catalog is written last.
    expect(puts.at(-1)).toContain("frockbot-package-catalog/catalog/current");
    expect(
      puts.slice(0, -1).every((call) => !call.includes("catalog/current")),
    ).toBe(true);
    expect(
      puts.some((call) =>
        /frockbot-package-catalog\/catalog\/g[0-9a-f]{32}\/index\.json/.test(
          call,
        ),
      ),
    ).toBe(true);
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
    const computerHost = deploymentSteps.find(
      (step) => step.name === "Deploy computer host",
    );
    const deploy = deploymentSteps.find(
      (step) => step.name === "Deploy Worker",
    );
    expect(validation?.env).not.toHaveProperty("COMPOSIO_API_KEY");
    expect(validation?.env).not.toHaveProperty("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
    expect(validation?.env).not.toHaveProperty(
      "FROCKBOT_AUTHORIZATION_STATE_SECRET",
    );
    expect(computerHost?.env?.SPRITES_TOKEN).toBe(
      "${{ secrets.SPRITES_TOKEN }}",
    );
    // The shared Computer host holds the Sprites token and re-checks the
    // service token; both are its secrets and neither is the app Worker's.
    expect(computerHost?.env?.COMPUTER_HOST_TOKEN).toBe(
      "${{ secrets.COMPUTER_HOST_TOKEN }}",
    );
    expect(validation?.env?.COMPUTER_HOST_TOKEN).toBe(
      "${{ secrets.COMPUTER_HOST_TOKEN }}",
    );
    // The host must be current before the app version that binds to it
    // (ADR 0004, two-Worker deploy ordering).
    const order = deploymentSteps.map((step) => step.name);
    expect(order.indexOf("Deploy computer host")).toBeGreaterThan(
      order.indexOf("Deploy bundler Worker"),
    );
    expect(order.indexOf("Deploy computer host")).toBeLessThan(
      order.indexOf("Deploy Worker"),
    );
    expect(deploy?.env?.SPRITES_TOKEN).toBe("${{ secrets.SPRITES_TOKEN }}");
    expect(validation?.env?.CREDENTIAL_KEYRING).toBe(
      "${{ secrets.CREDENTIAL_KEYRING }}",
    );
    expect(deploy?.env?.CREDENTIAL_KEYRING).toBe(
      "${{ secrets.CREDENTIAL_KEYRING }}",
    );
    // Every Routine webhook key is signed with it, so a deploy that forgot it
    // would leave the door verifying nothing.
    expect(validation?.env?.ROUTINE_HOOK_SECRET).toBe(
      "${{ secrets.ROUTINE_HOOK_SECRET }}",
    );
    expect(deploy?.env?.ROUTINE_HOOK_SECRET).toBe(
      "${{ secrets.ROUTINE_HOOK_SECRET }}",
    );
    expect(deploy?.run).toContain("'ROUTINE_HOOK_SECRET'");
    // Every registered-machine token and pairing code is signed with it, so a
    // deploy that forgot it would leave the enrollment door answering 503.
    expect(validation?.env?.MACHINE_TOKEN_SECRET).toBe(
      "${{ secrets.MACHINE_TOKEN_SECRET }}",
    );
    expect(deploy?.env?.MACHINE_TOKEN_SECRET).toBe(
      "${{ secrets.MACHINE_TOKEN_SECRET }}",
    );
    expect(deploy?.run).toContain("'MACHINE_TOKEN_SECRET'");
    expect(validation?.env?.FROCKBOT_ADMIN_EMAILS).toBe(
      "${{ secrets.FROCKBOT_ADMIN_EMAILS }}",
    );
    expect(deploy?.env?.FROCKBOT_ADMIN_EMAILS).toBe(
      "${{ secrets.FROCKBOT_ADMIN_EMAILS }}",
    );
    expect(deploy?.run).toContain("'FROCKBOT_ADMIN_EMAILS'");

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
      FROCKBOT_ADMIN_EMAILS: "owner@example.com",
      SPRITES_TOKEN: "sprites-production",
      COMPUTER_HOST_TOKEN: "computer-host-production",
      CREDENTIAL_KEYRING:
        '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
      ROUTINE_HOOK_SECRET:
        "5c1b7b0e5b0b4d1a9e6f3c2d8a7b6e5f4d3c2b1a0f9e8d7c6b5a4938271605f4",
      MACHINE_TOKEN_SECRET:
        "9f2c4a6e8d0b1357913579bdf02468ace13579bdf02468ace13579bdf02468ac",
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

    const missingHookSecret = Bun.spawnSync(
      ["bash", "-c", validation?.run ?? ""],
      {
        env: { ...productionEnvironment, ROUTINE_HOOK_SECRET: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(missingHookSecret.exitCode).toBe(1);
    expect(missingHookSecret.stderr.toString()).toContain(
      "Missing production configuration: ROUTINE_HOOK_SECRET",
    );

    const missingMachineSecret = Bun.spawnSync(
      ["bash", "-c", validation?.run ?? ""],
      {
        env: { ...productionEnvironment, MACHINE_TOKEN_SECRET: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(missingMachineSecret.exitCode).toBe(1);
    expect(missingMachineSecret.stderr.toString()).toContain(
      "Missing production configuration: MACHINE_TOKEN_SECRET",
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
    const workflowEnvironment = {
      ...productionEnvironment,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runner,
      WORKFLOW_CAPTURE: capture,
    };
    const hostExecution = Bun.spawnSync(
      ["bash", "-c", computerHost?.run ?? ""],
      {
        cwd: directory,
        env: workflowEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(hostExecution.exitCode).toBe(0);
    const hostSecrets = JSON.parse(await Bun.file(capture).text()) as Record<
      string,
      string
    >;
    expect(hostSecrets.SPRITES_TOKEN).toBe("sprites-production");
    expect(hostSecrets.COMPUTER_HOST_TOKEN).toBe("computer-host-production");
    // The Sprites token belongs to the host and to the app Worker's provider
    // gate; nothing else the host holds reaches anywhere else.
    expect(Object.keys(hostSecrets).sort()).toEqual([
      "COMPUTER_HOST_TOKEN",
      "SPRITES_TOKEN",
    ]);

    const execution = Bun.spawnSync(["bash", "-c", deploy?.run ?? ""], {
      cwd: directory,
      env: workflowEnvironment,
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
    expect(forwarded.FROCKBOT_ADMIN_EMAILS).toBe("owner@example.com");
    expect(forwarded).not.toHaveProperty("COMPOSIO_API_KEY");
    expect(forwarded).not.toHaveProperty("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
    expect(forwarded).not.toHaveProperty("FROCKBOT_AUTHORIZATION_STATE_SECRET");
  });
});

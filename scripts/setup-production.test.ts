/// <reference types="bun" />
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const productionEnvironment = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: "cloudflare-token",
  CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
  BETTER_AUTH_URL: "https://bot.frockbot.com",
  BETTER_AUTH_SECRET:
    "a87ad4f95378b32a7954573d8f0933e07bc99a6d3c58ae2b61d85fd43ac424eb",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  FROCKBOT_ADMIN_EMAILS: "owner@example.com",
  SPRITES_TOKEN: "computer-host-token-production",
  COMPUTER_HOST_TOKEN: "computer-host-production",
  CREDENTIAL_KEYRING:
    '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
  ROUTINE_HOOK_SECRET:
    "5c1b7b0e5b0b4d1a9e6f3c2d8a7b6e5f4d3c2b1a0f9e8d7c6b5a4938271605f4",
  MACHINE_TOKEN_SECRET:
    "9f2c4a6e8d0b1357913579bdf02468ace13579bdf02468ace13579bdf02468ac",
  FCM_SERVICE_ACCOUNT: '{"project_id":"frockbot-test"}',
  STRIPE_SECRET_KEY: "sk_test_production",
  STRIPE_WEBHOOK_SECRET: "whsec_production",
  STRIPE_MONTHLY_PRICE_ID: "price_production_monthly",
  // Required since plan step 8: a Turn's `plugin_check` and
  // `plugin_publish` both call the build service with it.
  APPLET_BUILD_TOKEN:
    "8b7a6959483726150e9d8c7b6a5948372615f0e9d8c7b6a5948372615f0e9d8c",
  // Required with voice (docs/voice.md): the hosted product must dictate
  // and hold a conversation with no User configuration, so neither key is
  // optional.
  OPENAI_API_KEY: "sk-production-openai",
  GEMINI_API_KEY: "gemini-production",
  // Required with enforced Turn supervision: no Turn runs without Jev.
  JEV_API_KEY: "jev-production",
};

type WorkflowStep = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
};

/**
 * Runs one workflow step's shell as Actions would, from the repository root
 * unless the step moves it. Async, so a timeout fails the test as a timeout
 * rather than killing the step and reporting its exit code as `null`.
 */
async function runWorkflowStep(
  step: WorkflowStep,
  options: { env: Record<string, string | undefined>; cwd?: string },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  if (!step.run) throw new Error(`"${step.name}" has no run script`);
  const child = Bun.spawn(["bash", "-c", step.run], {
    cwd: repositoryRoot,
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * A runner for the deploy steps, whose `bunx` copies the `--secrets-file` it
 * is handed to `capture` and fails every other command.
 */
async function deployRunner(): Promise<{
  directory: string;
  capture: string;
  env: Record<string, string | undefined>;
}> {
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
  return {
    directory,
    capture,
    env: {
      ...productionEnvironment,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runner,
      WORKFLOW_CAPTURE: capture,
      // The deploy step runs from `apps/cloudflare`, so it reaches the
      // secrets manifest through the workspace rather than a relative path.
      GITHUB_WORKSPACE: repositoryRoot,
    },
  };
}

describe("production setup", () => {
  test("provisions only active production integrations", async () => {
    const { exitCode, stdout, stderr, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\ncomputer-host-token-production\n\n",
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "Checking environment secrets in timoconnellaus/frockbot…",
    );
    expect(stdout).toContain(
      "Stage 6/6 · GitHub: verify production configuration",
    );
    // The AI Gateway token is optional: skipping it has to leave the run
    // green and say what stops working, not write an empty secret that a
    // `--secrets-file` deploy would then push over a good one.
    expect(stdout).toContain(
      "No AI Gateway token set; Frock AI Auto will not work until one is provided.",
    );
    expect(calls).not.toContain(
      "secret set FROCK_AI_GATEWAY_TOKEN --repo timoconnellaus/frockbot --env production",
    );
    expect(calls).toContain(
      "secret set SPRITES_TOKEN --repo timoconnellaus/frockbot --env production",
    );
    expect(calls).toContain(
      "secret-value:SPRITES_TOKEN:computer-host-token-production",
    );
    expect(calls).toContain(
      "secret set CREDENTIAL_KEYRING --repo timoconnellaus/frockbot --env production",
    );
    expect(
      calls.some((call) => call.startsWith("secret-value:CREDENTIAL_KEYRING:")),
    ).toBe(true);
  });

  test("aborts when the production keyring cannot be inspected", async () => {
    const { exitCode, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\ncomputer-host-token-production\n\n",
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
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\ncomputer-host-token-production\n\n",
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

  // One test per run of the workflow's shell: each run starts Bun once or
  // twice, and a dozen of them in one test outlasted bun's 5-second timeout
  // whenever the pre-push hook ran format and typecheck beside the unit tier.
  describe("forwards active secrets to the deploy", () => {
    let deploymentSteps: WorkflowStep[] = [];

    beforeAll(async () => {
      const source = await Bun.file(
        new URL("../.github/workflows/release.yml", import.meta.url),
      ).text();
      const workflow = Bun.YAML.parse(source) as {
        jobs: { "deploy-backend": { steps: WorkflowStep[] } };
      };
      deploymentSteps = workflow.jobs["deploy-backend"].steps;
    });

    function step(name: string): WorkflowStep {
      const found = deploymentSteps.find(
        (candidate) => candidate.name === name,
      );
      if (!found) throw new Error(`deploy-backend has no "${name}" step`);
      return found;
    }

    test("wires each secret into the steps that read it", () => {
      const validation = step("Validate deployment configuration");
      const computerHost = step("Deploy computer host");
      const deploy = step("Deploy Worker");
      expect(computerHost.env?.SPRITES_TOKEN).toBe(
        "${{ secrets.SPRITES_TOKEN }}",
      );
      // The shared Computer host holds its own vendor credential and re-checks
      // the service token; both are its secrets and neither is the app Worker's.
      expect(computerHost.env?.COMPUTER_HOST_TOKEN).toBe(
        "${{ secrets.COMPUTER_HOST_TOKEN }}",
      );
      expect(validation.env?.COMPUTER_HOST_TOKEN).toBe(
        "${{ secrets.COMPUTER_HOST_TOKEN }}",
      );
      // The host must be current before the app version that binds to it
      // (ADR 0004, two-Worker deploy ordering).
      const order = deploymentSteps.map((candidate) => candidate.name);
      expect(order.indexOf("Deploy computer host")).toBeLessThan(
        order.indexOf("Deploy Worker"),
      );
      expect(deploy.env?.SPRITES_TOKEN).toBe("${{ secrets.SPRITES_TOKEN }}");
      expect(validation.env?.CREDENTIAL_KEYRING).toBe(
        "${{ secrets.CREDENTIAL_KEYRING }}",
      );
      expect(deploy.env?.CREDENTIAL_KEYRING).toBe(
        "${{ secrets.CREDENTIAL_KEYRING }}",
      );
      // Every Routine webhook key is signed with it, so a deploy that forgot it
      // would leave the door verifying nothing.
      expect(validation.env?.ROUTINE_HOOK_SECRET).toBe(
        "${{ secrets.ROUTINE_HOOK_SECRET }}",
      );
      expect(deploy.env?.ROUTINE_HOOK_SECRET).toBe(
        "${{ secrets.ROUTINE_HOOK_SECRET }}",
      );
      // The names the secrets file carries come from the manifest now, not from
      // a list written out inside this workflow, so the deploy step is checked
      // for the manifest and the forwarded file is checked for the values.
      expect(deploy.run).toContain(
        'check-production-secrets.ts" write-secrets-file',
      );
      // Every registered-machine token and pairing code is signed with it, so a
      // deploy that forgot it would leave the enrollment door answering 503.
      expect(validation.env?.MACHINE_TOKEN_SECRET).toBe(
        "${{ secrets.MACHINE_TOKEN_SECRET }}",
      );
      expect(deploy.env?.MACHINE_TOKEN_SECRET).toBe(
        "${{ secrets.MACHINE_TOKEN_SECRET }}",
      );
      expect(validation.env?.FROCKBOT_ADMIN_EMAILS).toBe(
        "${{ secrets.FROCKBOT_ADMIN_EMAILS }}",
      );
      expect(deploy.env?.FROCKBOT_ADMIN_EMAILS).toBe(
        "${{ secrets.FROCKBOT_ADMIN_EMAILS }}",
      );
    });

    test("validation accepts a complete production configuration", async () => {
      const { exitCode } = await runWorkflowStep(
        step("Validate deployment configuration"),
        { env: productionEnvironment },
      );
      expect(exitCode).toBe(0);
    });

    test.each(["SPRITES_TOKEN", "ROUTINE_HOOK_SECRET", "MACHINE_TOKEN_SECRET"])(
      "validation names a missing %s",
      async (name) => {
        const { exitCode, stderr } = await runWorkflowStep(
          step("Validate deployment configuration"),
          { env: { ...productionEnvironment, [name]: "" } },
        );
        expect(exitCode).toBe(1);
        expect(stderr).toContain(`Missing production configuration: ${name}`);
      },
    );

    test.each([
      ["that is not JSON", "not-json"],
      [
        "naming a current key it lacks",
        '{"schemaVersion":1,"currentKeyId":"missing","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
      ],
      [
        "naming an inherited property as its current key",
        '{"schemaVersion":1,"currentKeyId":"toString","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
      ],
      [
        "whose key is shorter than 32 bytes",
        '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"c2hvcnQ"}}',
      ],
    ])("validation rejects a credential keyring %s", async (_, keyring) => {
      const { exitCode } = await runWorkflowStep(
        step("Validate deployment configuration"),
        { env: { ...productionEnvironment, CREDENTIAL_KEYRING: keyring } },
      );
      expect(exitCode).not.toBe(0);
    });

    test("deploys the computer host with only its own secrets", async () => {
      const { directory, capture, env } = await deployRunner();
      const { exitCode } = await runWorkflowStep(step("Deploy computer host"), {
        cwd: directory,
        env,
      });
      expect(exitCode).toBe(0);
      const hostSecrets = JSON.parse(await Bun.file(capture).text()) as Record<
        string,
        string
      >;
      expect(hostSecrets.SPRITES_TOKEN).toBe("computer-host-token-production");
      expect(hostSecrets.COMPUTER_HOST_TOKEN).toBe("computer-host-production");
      // That credential belongs to the host and to the app Worker's provider
      // gate; nothing else the host holds reaches anywhere else.
      expect(Object.keys(hostSecrets).sort()).toEqual([
        "COMPUTER_HOST_TOKEN",
        "SPRITES_TOKEN",
      ]);
    });

    test("deploys the Worker with the manifest's secrets", async () => {
      const { directory, capture, env } = await deployRunner();
      const { exitCode } = await runWorkflowStep(step("Deploy Worker"), {
        cwd: directory,
        env,
      });
      expect(exitCode).toBe(0);
      // Wrangler parses the secrets file as JSON before it tries dotenv, and
      // dotenv would keep the backslash escapes inside a double-quoted value —
      // a keyring forwarded that way reached production mangled. So the file
      // must be one JSON object, read exactly as Wrangler reads it.
      const forwarded = JSON.parse(await Bun.file(capture).text()) as Record<
        string,
        string
      >;
      expect(forwarded.SPRITES_TOKEN).toBe("computer-host-token-production");
      expect(forwarded.CREDENTIAL_KEYRING).toBe(
        productionEnvironment.CREDENTIAL_KEYRING,
      );
      expect(forwarded.FROCKBOT_ADMIN_EMAILS).toBe("owner@example.com");
      expect(forwarded.ROUTINE_HOOK_SECRET).toBe(
        productionEnvironment.ROUTINE_HOOK_SECRET,
      );
      expect(forwarded.MACHINE_TOKEN_SECRET).toBe(
        productionEnvironment.MACHINE_TOKEN_SECRET,
      );
      expect(forwarded.APPLET_BUILD_TOKEN).toBe(
        productionEnvironment.APPLET_BUILD_TOKEN,
      );
    });
  });
});

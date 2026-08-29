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

async function runProductionSetup(stdin: string): Promise<{
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
if [[ "$1 $2" == "secret set" ]]; then
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
  test("the wizard provisions dedicated backend environment secrets", async () => {
    const { exitCode, stdout, stderr, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\ngmail-config\ncomposio-key\nindependent-authorization-state-secret\nsprites-production\n\n",
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
      "secret set FROCKBOT_AUTHORIZATION_STATE_SECRET --repo timoconnellaus/frockbot --env production",
    );
    expect(calls).toContain(
      "secret-value:FROCKBOT_AUTHORIZATION_STATE_SECRET:independent-authorization-state-secret",
    );
    expect(calls).toContain(
      "secret set SPRITES_TOKEN --repo timoconnellaus/frockbot --env production",
    );
    expect(calls).toContain("secret-value:SPRITES_TOKEN:sprites-production");
  });

  test("the wizard rejects a weak authorization-state secret", async () => {
    const { exitCode, stdout, calls } = await runProductionSetup(
      "\ncloudflare-token\n\ngoogle-client\ngoogle-secret\ngmail-config\ncomposio-key\ntoo-short\n",
    );

    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "The Connection authorization-state secret must be at least 32 characters",
    );
    expect(calls).not.toContain(
      "secret set FROCKBOT_AUTHORIZATION_STATE_SECRET --repo timoconnellaus/frockbot --env production",
    );
  });

  test("the deploy workflow forwards dedicated backend secrets through Wrangler", async () => {
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
    expect(validation?.env?.FROCKBOT_AUTHORIZATION_STATE_SECRET).toBe(
      "${{ secrets.FROCKBOT_AUTHORIZATION_STATE_SECRET }}",
    );
    expect(deploy?.env?.FROCKBOT_AUTHORIZATION_STATE_SECRET).toBe(
      "${{ secrets.FROCKBOT_AUTHORIZATION_STATE_SECRET }}",
    );
    expect(deploy?.env?.SPRITES_TOKEN).toBe("${{ secrets.SPRITES_TOKEN }}");

    const productionEnvironment = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
      CLOUDFLARE_D1_DATABASE_ID: "cloudflare-database",
      BETTER_AUTH_URL: "https://bot.frockbot.com",
      BETTER_AUTH_SECRET: "auth-secret",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      COMPOSIO_API_KEY: "composio-key",
      COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
      FROCKBOT_AUTHORIZATION_STATE_SECRET:
        "independent-authorization-state-secret",
      SPRITES_TOKEN: "sprites-production",
    };
    const validConfiguration = Bun.spawnSync(
      ["bash", "-c", validation?.run ?? ""],
      { env: productionEnvironment, stdout: "pipe", stderr: "pipe" },
    );
    expect(validConfiguration.exitCode).toBe(0);

    const weakConfiguration = Bun.spawnSync(
      ["bash", "-c", validation?.run ?? ""],
      {
        env: {
          ...productionEnvironment,
          FROCKBOT_AUTHORIZATION_STATE_SECRET: "too-short",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(weakConfiguration.exitCode).toBe(1);
    expect(weakConfiguration.stderr.toString()).toContain(
      "FROCKBOT_AUTHORIZATION_STATE_SECRET must be at least 32 characters",
    );

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
    expect(execution.stderr.toString()).toBe("");
    const forwarded = Object.fromEntries(
      (await Bun.file(capture).text())
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [
            line.slice(0, separator),
            JSON.parse(line.slice(separator + 1)),
          ];
        }),
    );
    expect(forwarded.FROCKBOT_AUTHORIZATION_STATE_SECRET).toBe(
      "independent-authorization-state-secret",
    );
    expect(forwarded.SPRITES_TOKEN).toBe("sprites-production");
    expect(forwarded).not.toHaveProperty("SPRITE_TOKEN");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT_V1 } from "./deployment-config/profile.ts";
import { validateProfileV1 } from "./deployment-config/profile.ts";
import { PUBLISHED_IMAGE_REGISTRY_V1 as GENERATOR_REGISTRY_V1 } from "./deployment-config/generate.ts";
import {
  accessApplicationsV1,
  accessBuildSecretNamesV1,
  accessDashboardStepsV1,
  accountChoiceV1,
  accountRefusalV1,
  applicationArtifactKeyV1,
  artifactHostnameV1,
  chosenAccountV1,
  CONFIGURED_AS_VARS_V1,
  credentialKeyringV1,
  DELIBERATELY_UNSET_V1,
  formatMintedSecretsV1,
  HUMAN_SECRETS_V1,
  imageTagV1,
  MEMORY_INDEX_PRESET_V1,
  MINTED_SECRETS_V1,
  mintPlanV1,
  parseMintedSecretsV1,
  parseWhoamiAccountsV1,
  PUBLISHED_IMAGE_REGISTRY_V1,
  releaseAssetNamesV1,
  deploymentResourcesV1,
  simpleProfileV1,
  UNISSUED_ACCESS_AUD_V1,
} from "./setup/plan.ts";
import { commandLineV1, createDryRunRunnerV1 } from "./setup/runner.ts";
import { parseCredentialKeyringV1 } from "../core/connection/index.ts";

const ANSWERS = {
  prefix: "example",
  accountId: "1".repeat(32),
  appHostname: "bot.example.com",
  adminEmails: ["someone@example.com"],
  accessTeamDomain: "example.cloudflareaccess.com",
  region: "enam",
  imageTag: "0.7.20",
};

describe("the account step", () => {
  test("reads the accounts out of wrangler whoami's table", () => {
    // `whoami` has no JSON mode; this is the shape it prints.
    const stdout = [
      "Getting User settings...",
      "👋 You are logged in with an OAuth Token.",
      "┌──────────────────────┬──────────────────────────────────┐",
      "│ Account Name         │ Account ID                       │",
      "├──────────────────────┼──────────────────────────────────┤",
      `│ Someone's Account    │ ${"a".repeat(32)} │`,
      "├──────────────────────┼──────────────────────────────────┤",
      `│ A Second Account     │ ${"b".repeat(32)} │`,
      "└──────────────────────┴──────────────────────────────────┘",
    ].join("\n");
    expect(parseWhoamiAccountsV1(stdout)).toEqual([
      { name: "Someone's Account", id: "a".repeat(32) },
      { name: "A Second Account", id: "b".repeat(32) },
    ]);
  });

  test("takes the only account, asks when there are several", () => {
    const one = [{ name: "One", id: "a".repeat(32) }];
    const two = [...one, { name: "Two", id: "b".repeat(32) }];
    expect(accountChoiceV1(one, undefined)).toEqual({
      kind: "chosen",
      account: one[0]!,
    });
    expect(accountChoiceV1(two, undefined)).toEqual({
      kind: "ask",
      accounts: two,
    });
    expect(accountChoiceV1(two, "b".repeat(32))).toEqual({
      kind: "chosen",
      account: two[1]!,
    });
    expect(accountChoiceV1(two, "Two")).toEqual({
      kind: "chosen",
      account: two[1]!,
    });
    expect(accountChoiceV1(two, "nothing")).toMatchObject({ kind: "failure" });
    expect(accountChoiceV1([], undefined)).toMatchObject({ kind: "failure" });
  });

  test("every leg of the choice ends in an account or a reason", () => {
    expect(() =>
      chosenAccountV1({ kind: "failure", reason: "no token" }),
    ).toThrow(/no token/);
    expect(() =>
      chosenAccountV1({
        kind: "ask",
        accounts: [
          { name: "One", id: "a".repeat(32) },
          { name: "Two", id: "b".repeat(32) },
        ],
      }),
    ).toThrow(/--account/);
  });

  test("refuses the hosted account unless told twice", () => {
    const hosted = (
      JSON.parse(
        readFileSync(join(REPO_ROOT_V1, "deployments", "hosted.json"), "utf8"),
      ) as { accountId: string }
    ).accountId;
    // The refusal exists because installing beside a live deployment creates
    // Workers in somebody's production account.
    expect(accountRefusalV1(hosted, hosted, false)?.reason).toContain(
      "--allow-hosted-account",
    );
    expect(accountRefusalV1(hosted, hosted, true)).toBeUndefined();
    expect(accountRefusalV1("c".repeat(32), hosted, false)).toBeUndefined();
  });
});

describe("the profile the installer writes", () => {
  const profile = simpleProfileV1(ANSWERS);

  test("meets the schema every other profile meets", () => {
    expect(() =>
      validateProfileV1(profile, "the installer's profile"),
    ).not.toThrow();
  });

  test("builds the Access Package, pulls its images, and names no gateway", () => {
    expect(profile.authPackage).toBe("access");
    expect(profile.images).toEqual({
      source: "registry",
      registry: PUBLISHED_IMAGE_REGISTRY_V1,
      tag: "0.7.20",
    });
    // No AI Gateway: the Worker takes the `AI` binding, where Auto resolves to a
    // concrete Workers AI model instead of the hosted dynamic route.
    expect(profile.aiGateway).toBeUndefined();
    // No marketing site and no admin portal: there is no admin operation left
    // when the Access policy is the allowlist.
    expect(Object.keys(profile.workers ?? {})).toEqual([
      "app",
      "computerHost",
      "appletBuild",
    ]);
    expect(profile.d1DatabaseId).toBeUndefined();
  });

  test("derives the artifact origin from the app's own hostname", () => {
    // The gateway derives the pairing from the `ui.` prefix in three places; a
    // hostname of any other shape serves pages whose socket it refuses.
    expect(profile.artifactHostname).toBe("ui.bot.example.com");
    expect(artifactHostnameV1("bot.example.com")).toBe("ui.bot.example.com");
  });

  test("names the registry the generator and release.yml agree on", () => {
    expect(PUBLISHED_IMAGE_REGISTRY_V1).toBe(GENERATOR_REGISTRY_V1);
  });

  test("carries an unissued audience until Access has issued one", () => {
    expect(profile.access?.aud).toBe(UNISSUED_ACCESS_AUD_V1);
    expect(
      simpleProfileV1({ ...ANSWERS, accessAud: "d".repeat(64) }).access?.aud,
    ).toBe("d".repeat(64));
  });
});

describe("which release a checkout installs", () => {
  test("a tag pins the images and the assets to it", () => {
    expect(imageTagV1("v0.7.20", "0.0.1")).toEqual({ tag: "0.7.20" });
    expect(imageTagV1("0.7.20", undefined)).toEqual({ tag: "0.7.20" });
  });

  test("a checkout off a tag falls back to latest, loudly", () => {
    // Pulling `latest` means the images and the release assets are whatever the
    // newest release happens to be, which is not a thing to do quietly.
    const answer = imageTagV1(undefined, "0.0.1");
    expect(answer.tag).toBe("latest");
    expect(answer.warning).toContain("not on a release tag");
    expect(imageTagV1("v0.7.20-3-gabc", "0.0.1").tag).toBe("latest");
  });

  test("the asset names are the ones release.yml attaches", () => {
    const workflow = readFileSync(
      join(REPO_ROOT_V1, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const assets = releaseAssetNamesV1("$VERSION");
    // A name that drifted would download nothing and deploy a Worker with no
    // client and an artifact hash pointing at an empty bucket.
    expect(workflow).toContain(assets.webClient);
    expect(workflow).toContain(assets.applicationArtifact);
  });

  test("the artifact's R2 key is its own sha256, as the release deploy writes it", () => {
    expect(applicationArtifactKeyV1("e".repeat(64))).toBe(
      `applications/${"e".repeat(64)}.mjs`,
    );
  });
});

describe("the resources a deployment needs", () => {
  test("two buckets and one index, named from the prefix", () => {
    expect(deploymentResourcesV1(simpleProfileV1(ANSWERS))).toEqual({
      buckets: ["example-application-artifacts", "example-memory-files"],
      memoryIndex: "example-memory",
      applicationArtifactsBucket: "example-application-artifacts",
    });
  });

  test("a profile that names its resources gets those, not the derived ones", () => {
    // The generator binds what the profile names, so creating a derived name
    // would create a bucket nothing opens.
    expect(
      deploymentResourcesV1({
        ...simpleProfileV1(ANSWERS),
        resources: { applicationArtifactsBucket: "named-by-hand" },
      }),
    ).toMatchObject({
      applicationArtifactsBucket: "named-by-hand",
      buckets: ["named-by-hand", "example-memory-files"],
    });
  });

  test("the index shape is the embedding model the memory Package uses", () => {
    // An index with any other dimensions or metric rejects every vector it
    // writes; `main.yml` creates staging's the same way.
    expect(MEMORY_INDEX_PRESET_V1).toBe("@cf/baai/bge-base-en-v1.5");
    expect(
      readFileSync(
        join(REPO_ROOT_V1, ".github", "workflows", "main.yml"),
        "utf8",
      ),
    ).toContain(MEMORY_INDEX_PRESET_V1);
  });
});

describe("minting the internal secrets", () => {
  test("mints every name the first time", () => {
    const plan = mintPlanV1({});
    expect(plan.mint.map((secret) => secret.name)).toEqual(
      MINTED_SECRETS_V1.map((secret) => secret.name),
    );
    expect(plan.keep).toEqual([]);
  });

  test("a second run mints nothing", () => {
    // Which is the whole of idempotence here: each of these signs or decrypts
    // durable state, so a second value invalidates what the first protects.
    const recorded = Object.fromEntries(
      MINTED_SECRETS_V1.map((secret) => [secret.name, "already"]),
    );
    const plan = mintPlanV1(recorded);
    expect(plan.mint).toEqual([]);
    expect(plan.keep).toEqual(MINTED_SECRETS_V1.map((secret) => secret.name));
  });

  test("a partial record mints only what is missing", () => {
    const plan = mintPlanV1({
      CREDENTIAL_KEYRING: "kept",
      // Blank counts as absent: a record half-written is a record with a hole.
      ROUTINE_HOOK_SECRET: "   ",
    });
    expect(plan.keep).toEqual(["CREDENTIAL_KEYRING"]);
    expect(plan.mint.map((secret) => secret.name)).toContain(
      "ROUTINE_HOOK_SECRET",
    );
    expect(plan.mint.map((secret) => secret.name)).not.toContain(
      "CREDENTIAL_KEYRING",
    );
  });

  test("the keyring is the shape the Worker's parser reads", () => {
    const keyring = parseCredentialKeyringV1(credentialKeyringV1());
    expect(keyring.schemaVersion).toBe(1);
    expect(Object.keys(keyring.keys)).toEqual([keyring.currentKeyId]);
  });

  test("the record round-trips, comments and all", () => {
    const values = {
      CREDENTIAL_KEYRING: credentialKeyringV1(),
      COMPUTER_HOST_TOKEN: "f".repeat(64),
    };
    const written = formatMintedSecretsV1(values);
    expect(written).toContain("mode 0600");
    // The keyring is JSON with `=` inside it; only the first `=` separates.
    expect(parseMintedSecretsV1(written)).toEqual(values);
    expect(parseMintedSecretsV1(undefined)).toEqual({});
  });

  test("every minted secret reaches every Worker that reads it", () => {
    const placement = Object.fromEntries(
      MINTED_SECRETS_V1.map((secret) => [secret.name, secret.workers]),
    );
    // The two shared secrets are the pairs: each is presented by the app Worker
    // and checked by the Worker it calls.
    expect(placement.COMPUTER_HOST_TOKEN).toEqual(["app", "computerHost"]);
    expect(placement.APPLET_BUILD_TOKEN).toEqual(["app", "appletBuild"]);
    expect(placement.NATIVE_TOKEN_SECRET).toEqual(["app"]);
  });
});

describe("the keys only a deployer has", () => {
  test("the Computer's token is the one that is required", () => {
    const required = HUMAN_SECRETS_V1.filter((secret) => secret.required);
    expect(required.map((secret) => secret.name)).toEqual(["SPRITES_TOKEN"]);
    expect(required[0]!.where).toContain("fly.io");
  });

  test("every optional key says what it enables", () => {
    for (const secret of HUMAN_SECRETS_V1) {
      expect(secret.enables.length).toBeGreaterThan(10);
      expect(secret.workers.length).toBeGreaterThan(0);
    }
  });

  test("the installer covers every secret the Access build's Worker expects", () => {
    // Read off the same manifest the hosted release is checked against, so a
    // secret the Worker starts reading cannot be one the installer never sets.
    const asked = new Set([
      ...MINTED_SECRETS_V1.map((secret) => secret.name),
      ...HUMAN_SECRETS_V1.map((secret) => secret.name),
      "FROCKBOT_ADMIN_EMAILS",
    ]);
    expect(
      accessBuildSecretNamesV1().filter((name) => !asked.has(name)),
    ).toEqual([]);
  });

  test("it never sets as a secret what the config carries as a var", () => {
    // Wrangler refuses a name that is both; the generator writes these two.
    for (const name of CONFIGURED_AS_VARS_V1) {
      expect(accessBuildSecretNamesV1()).not.toContain(name);
    }
    expect(CONFIGURED_AS_VARS_V1).toEqual(["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  });

  test("it asks for no Stripe key and no Gateway bearer, and says why", () => {
    // Billing is switched by STRIPE_SECRET_KEY, which the simple installer never
    // sets: nothing is gated, and a self-hoster who sets one gets billing.
    expect(DELIBERATELY_UNSET_V1).toContain("STRIPE_SECRET_KEY");
    expect(DELIBERATELY_UNSET_V1).toContain("FROCK_AI_GATEWAY_TOKEN");
    const asked = [
      ...MINTED_SECRETS_V1.map((secret) => secret.name),
      ...HUMAN_SECRETS_V1.map((secret) => secret.name),
    ];
    for (const name of DELIBERATELY_UNSET_V1) expect(asked).not.toContain(name);
  });

  test("the hosted build's own names are never asked for", () => {
    // A simple deployment has no better-auth and no Google client, and asking
    // for either would be asking for a secret its Worker cannot read.
    const asked = [
      ...MINTED_SECRETS_V1.map((secret) => secret.name),
      ...HUMAN_SECRETS_V1.map((secret) => secret.name),
    ];
    for (const name of [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]) {
      expect(asked).not.toContain(name);
      expect(accessBuildSecretNamesV1()).not.toContain(name);
    }
  });
});

describe("the Access applications", () => {
  const applications = accessApplicationsV1("bot.example.com", "example");

  test("protects the app and lets /api reach the Worker", () => {
    expect(applications).toHaveLength(2);
    expect(applications[0]).toMatchObject({
      destination: "bot.example.com",
      decision: "allow",
    });
    // Without the bypass, a native bearer request and an Applet viewer socket
    // would both be answered by Access instead of by the Worker.
    expect(applications[1]).toMatchObject({
      destination: "bot.example.com/api",
      decision: "bypass",
    });
  });

  test("leaves the artifact origin outside Access altogether", () => {
    const artifact = artifactHostnameV1("bot.example.com");
    for (const application of applications) {
      expect(application.destination.startsWith(artifact)).toBe(false);
    }
    expect(
      accessDashboardStepsV1(applications, "example.cloudflareaccess.com", [
        "someone@example.com",
      ]).join(" "),
    ).toContain(artifact);
  });

  test("the dashboard steps name the team, both applications and the AUD", () => {
    const steps = accessDashboardStepsV1(
      applications,
      "example.cloudflareaccess.com",
      ["someone@example.com"],
    ).join("\n");
    expect(steps).toContain("example.cloudflareaccess.com");
    expect(steps).toContain("someone@example.com");
    expect(steps).toContain("bot.example.com/api");
    expect(steps).toContain("Bypass");
    expect(steps).toContain("AUD");
  });
});

describe("the dry run", () => {
  test("prints a command instead of running it, and never its stdin", () => {
    const said: string[] = [];
    const runner = createDryRunRunnerV1((line) => said.push(line));
    expect(runner.dryRun).toBe(true);
    const printed = commandLineV1({
      cmd: ["bunx", "wrangler", "secret", "put", "SPRITES_TOKEN"],
      stdin: "the-actual-token",
      redactedStdin: "the SPRITES_TOKEN value",
    });
    expect(printed).toContain("the SPRITES_TOKEN value");
    expect(printed).not.toContain("the-actual-token");
  });

  test("answers every probe as absent, so it prints a whole first install", async () => {
    const runner = createDryRunRunnerV1(() => {});
    const probe = await runner.run({
      cmd: ["bunx", "wrangler", "vectorize", "get", "x"],
    });
    expect(probe.exitCode).not.toBe(0);
    const answered = await runner.run(
      { cmd: ["git", "describe"] },
      {
        exitCode: 0,
        stdout: "v1.2.3",
        stderr: "",
      },
    );
    expect(answered.stdout).toBe("v1.2.3");
    expect(runner.recorded).toEqual([
      "bunx wrangler vectorize get x",
      "git describe",
    ]);
  });

  test("prints a file it would write, and deletes nothing", () => {
    const runner = createDryRunRunnerV1(() => {});
    runner.writeFile("/tmp/frockbot-not-written", "value", 0o600);
    runner.removeFile("/tmp/frockbot-not-written");
    expect(runner.recorded).toEqual([
      "write /tmp/frockbot-not-written",
      "remove /tmp/frockbot-not-written",
    ]);
    // The point of the record: nothing reached the filesystem.
    expect(runner.readFile("/tmp/frockbot-not-written")).toBeUndefined();
  });

  test("makes no network call of its own", async () => {
    const runner = createDryRunRunnerV1(() => {});
    const answer = await runner.request({
      method: "POST",
      url: "https://api.cloudflare.com/client/v4/accounts/x/access/apps",
      token: "unused",
    });
    expect(answer.status).toBe(404);
    expect(runner.recorded).toEqual([
      "POST https://api.cloudflare.com/client/v4/accounts/x/access/apps",
    ]);
  });
});

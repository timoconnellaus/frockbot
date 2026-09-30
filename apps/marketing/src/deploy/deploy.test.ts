import { describe, expect, test } from "bun:test";
import { accountChecksV1 } from "./checks";
import { CloudflareApiV1 } from "./cloudflare-api";
import { NotYetV1, STEP_RUNNERS_V1, type InstallRecordV1 } from "./deployer";
import { FakeCloudflareV1, storedZipV1 } from "./fake-cloudflare.test-support";
import { decodeReleaseManifestV1, isNewerVersionV1 } from "./manifest";
import { choosePageV1, escapeHtmlV1, progressPageV1 } from "./pages";
import {
  DEPLOY_STEPS_V1,
  dueMigrationsV1,
  installNameProblemV1,
  normalizeInstallNameV1,
  progressPercentV1,
  suggestedInstallNameV1,
} from "./plan";
import {
  latestDeployableVersionV1,
  releaseManifestV1,
  sha256HexV1,
} from "./release";
import { handleDeployRequestV1 } from "./routes";
import { readZipV1 } from "./zip";

const encode = (text: string) => new TextEncoder().encode(text);

interface ReleaseOptions {
  version: string;
  migrations: { tag: string; newSqliteClasses?: string[] }[];
  secrets: { name: string; shape: "hex" | "keyring" }[];
  d1Migrations: string[];
  client: Record<string, string>;
}

/** Publishes a release in the fake's GitHub, and returns its manifest. */
async function publishRelease(cf: FakeCloudflareV1, options: ReleaseOptions) {
  const files: Record<string, Uint8Array<ArrayBuffer>> = {};
  const file = async (asset: string, bytes: Uint8Array<ArrayBuffer>) => {
    files[asset] = bytes;
    return { asset, sha256: await sha256HexV1(bytes) };
  };
  const manifest = {
    schemaVersion: 1,
    version: options.version,
    highlights: `Things in ${options.version}.`,
    resources: {
      r2Buckets: ["application-artifacts", "memory-files"],
      kvNamespaces: ["cache"],
      d1Databases: [
        {
          role: "auth",
          migrations: await Promise.all(
            options.d1Migrations.map(async (name) => ({
              name,
              ...(await file(
                `${name}.sql`,
                encode(
                  `CREATE TABLE IF NOT EXISTS ${name.replace(/\W/g, "_")} (id TEXT);`,
                ),
              )),
            })),
          ),
        },
      ],
      vectorizeIndexes: [{ role: "memory", dimensions: 768, metric: "cosine" }],
      analyticsDatasets: ["events"],
    },
    workers: [
      {
        role: "app",
        mainModule: "index.js",
        modules: [
          {
            name: "index.js",
            type: "esm",
            ...(await file(
              `app-${options.version}.js`,
              encode(`export default {}; // ${options.version}`),
            )),
          },
        ],
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        bindings: [
          { type: "ai", name: "AI" },
          { type: "worker_loader", name: "USER_APPLICATIONS" },
          { type: "assets", name: "ASSETS" },
          {
            type: "durable_object_namespace",
            name: "BOT_STATES",
            className: "BotState",
          },
          { type: "r2_bucket", name: "MEMORY_FILES", bucket: "memory-files" },
          {
            type: "r2_bucket",
            name: "APPLICATION_ARTIFACTS",
            bucket: "application-artifacts",
          },
          { type: "kv_namespace", name: "CACHE", namespace: "cache" },
          { type: "d1", name: "AUTH_DB", database: "auth" },
          { type: "vectorize", name: "MEMORY_INDEX", index: "memory" },
          { type: "analytics_engine", name: "ANALYTICS", dataset: "events" },
          { type: "access_team_domain", name: "ACCESS_TEAM_DOMAIN" },
          { type: "access_aud", name: "ACCESS_AUD" },
          { type: "owner_email", name: "FROCKBOT_ADMIN_EMAILS" },
          { type: "install_origin", name: "PUBLIC_ORIGIN" },
          { type: "plain_text", name: "DEFAULT_APPLICATION_HASH", text: "abc" },
        ],
        migrations: options.migrations,
        secrets: options.secrets,
        assets: {
          ...(await file(
            `web-${options.version}.zip`,
            storedZipV1(options.client),
          )),
          htmlHandling: "none",
          notFoundHandling: "none",
        },
        r2Objects: [
          {
            bucket: "application-artifacts",
            key: "applications/abc.mjs",
            contentType: "application/javascript",
            ...(await file(
              `artifact-${options.version}.mjs`,
              encode("export const app = 1;"),
            )),
          },
        ],
      },
    ],
  };
  await cf.publish(options.version, files, manifest);
  return decodeReleaseManifestV1(manifest);
}

const FIRST: ReleaseOptions = {
  version: "0.48.2",
  migrations: [
    { tag: "v1", newSqliteClasses: ["BotState"] },
    { tag: "v2", newSqliteClasses: ["UserConfiguration"] },
  ],
  secrets: [
    { name: "CREDENTIAL_KEYRING", shape: "keyring" },
    { name: "ROUTINE_HOOK_SECRET", shape: "hex" },
  ],
  d1Migrations: ["0001_init"],
  client: { "index.html": "<!doctype html>", "main.dart.js": "main()" },
};

const SECOND: ReleaseOptions = {
  version: "0.49.0",
  migrations: [
    ...FIRST.migrations,
    { tag: "v3", newSqliteClasses: ["GroupChat"] },
  ],
  secrets: [...FIRST.secrets, { name: "MACHINE_TOKEN_SECRET", shape: "hex" }],
  d1Migrations: ["0001_init", "0002_more"],
  client: { "index.html": "<!doctype html>", "main.dart.js": "main(2)" },
};

function newInstall(cf: FakeCloudflareV1): InstallRecordV1 {
  return {
    name: "tims-frockbot",
    accountId: cf.accountId,
    accountName: cf.accountName,
    workersSubdomain: cf.subdomain!,
    ownerEmail: "tim@example.com",
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
  };
}

async function runAll(
  cf: FakeCloudflareV1,
  version: string,
  install: InstallRecordV1,
) {
  const manifest = await releaseManifestV1(version, cf.fetch as typeof fetch);
  const context = {
    api: new CloudflareApiV1("token", cf.fetch),
    manifest,
    fetcher: cf.fetch as typeof fetch,
    now: () => new Date("2026-09-30T00:00:00Z"),
  };
  let current = install;
  for (const step of DEPLOY_STEPS_V1)
    current = await STEP_RUNNERS_V1[step](context, current);
  return current;
}

describe("release manifest", () => {
  test("names every resource a binding points at", () => {
    expect(() =>
      decodeReleaseManifestV1({
        schemaVersion: 1,
        version: "1.0.0",
        resources: {},
        workers: [
          {
            role: "app",
            mainModule: "index.js",
            modules: [
              {
                name: "index.js",
                type: "esm",
                asset: "a.js",
                sha256: "0".repeat(64),
              },
            ],
            compatibilityDate: "2026-08-27",
            bindings: [{ type: "r2_bucket", name: "FILES", bucket: "files" }],
          },
        ],
      }),
    ).toThrow(/resources.r2Buckets does not declare/);
  });

  test("refuses a binding type it doesn't know rather than deploying without it", () => {
    expect(() =>
      decodeReleaseManifestV1({
        schemaVersion: 1,
        version: "1.0.0",
        resources: {},
        workers: [
          {
            role: "app",
            mainModule: "index.js",
            modules: [
              {
                name: "index.js",
                type: "esm",
                asset: "a.js",
                sha256: "0".repeat(64),
              },
            ],
            compatibilityDate: "2026-08-27",
            bindings: [{ type: "hyperdrive", name: "DB" }],
          },
        ],
      }),
    ).toThrow(/not a binding this deployer knows/);
  });

  test("keeps asset names inside the release", () => {
    expect(() =>
      decodeReleaseManifestV1({
        schemaVersion: 1,
        version: "1.0.0",
        resources: {},
        workers: [
          {
            role: "app",
            mainModule: "index.js",
            modules: [
              {
                name: "index.js",
                type: "esm",
                asset: "../../evil.js",
                sha256: "0".repeat(64),
              },
            ],
            compatibilityDate: "2026-08-27",
          },
        ],
      }),
    ).toThrow(/malformed/);
  });

  test("compares versions numerically", () => {
    expect(isNewerVersionV1("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersionV1("0.9.9", "0.10.0")).toBe(false);
    expect(isNewerVersionV1("1.0.0", "1.0.0")).toBe(false);
  });
});

describe("plan", () => {
  test("install names fit every resource and a DNS label", () => {
    expect(installNameProblemV1("tims-frockbot")).toBeUndefined();
    expect(installNameProblemV1("Tims")).toBeDefined();
    expect(installNameProblemV1("a--b")).toBeDefined();
    expect(installNameProblemV1("x".repeat(41))).toBeDefined();
    expect(normalizeInstallNameV1("  My Frock_Bot!! ")).toBe("my-frock-bot");
    expect(suggestedInstallNameV1("tim@example.com")).toBe("tim-frockbot");
  });

  test("sends only the Durable Object migrations still due", () => {
    const migrations = SECOND.migrations;
    expect(dueMigrationsV1(migrations, undefined)).toEqual({
      new_tag: "v3",
      steps: [
        { new_sqlite_classes: ["BotState"] },
        { new_sqlite_classes: ["UserConfiguration"] },
        { new_sqlite_classes: ["GroupChat"] },
      ],
    });
    expect(dueMigrationsV1(migrations, "v2")).toEqual({
      old_tag: "v2",
      new_tag: "v3",
      steps: [{ new_sqlite_classes: ["GroupChat"] }],
    });
    expect(dueMigrationsV1(migrations, "v3")).toBeUndefined();
    expect(() => dueMigrationsV1(migrations, "v9")).toThrow(/could lose data/);
  });

  test("the bar counts a running step as half", () => {
    expect(
      progressPercentV1([
        { id: "storage", state: "done" },
        { id: "sign-in", state: "running" },
        { id: "release", state: "waiting" },
        { id: "workers-ai", state: "waiting" },
      ]),
    ).toBe(38);
  });
});

describe("zip", () => {
  test("reads the files of a stored archive", async () => {
    const entries = await readZipV1(
      storedZipV1({ "index.html": "hi", "assets/a.js": "x" }),
    );
    expect(
      entries.map((e) => [e.path, new TextDecoder().decode(e.bytes)]),
    ).toEqual([
      ["index.html", "hi"],
      ["assets/a.js", "x"],
    ]);
  });

  test("refuses a path that climbs out", async () => {
    await expect(readZipV1(storedZipV1({ "../evil": "x" }))).rejects.toThrow(
      /unsafe path/,
    );
  });
});

describe("account checks", () => {
  test("pass on an account that has everything", async () => {
    const cf = new FakeCloudflareV1();
    const checks = await accountChecksV1(
      new CloudflareApiV1("token", cf.fetch),
      cf.accountId,
    );
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ["workers-paid", "ok"],
      ["r2", "ok"],
      ["workers-ai", "ok"],
      ["zero-trust", "ok"],
    ]);
    // The plan probe leaves nothing behind.
    expect(cf.scripts.size).toBe(0);
    expect(cf.deletedScripts).toHaveLength(1);
  });

  test("show the fix for a free plan, R2 off and no Zero Trust", async () => {
    const cf = new FakeCloudflareV1();
    cf.workersPaid = false;
    cf.r2Enabled = false;
    cf.zeroTrust = false;
    const checks = await accountChecksV1(
      new CloudflareApiV1("token", cf.fetch),
      cf.accountId,
    );
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId["workers-paid"]!.state).toBe("fix");
    expect(byId["workers-paid"]!.fixUrl).toBe(
      `https://dash.cloudflare.com/${cf.accountId}/workers/plans`,
    );
    expect(byId["r2"]!.state).toBe("fix");
    expect(byId["zero-trust"]!.state).toBe("fix");
    expect(byId["zero-trust"]!.detail).toContain("choose the Free plan");
    expect(byId["workers-ai"]!.state).toBe("ok");
  });

  test("Zero Trust on with no Access organization yet still passes; the deploy creates it", async () => {
    const cf = new FakeCloudflareV1();
    cf.organization = null;
    const checks = await accountChecksV1(
      new CloudflareApiV1("token", cf.fetch),
      cf.accountId,
    );
    expect(checks.find((c) => c.id === "zero-trust")!.state).toBe("ok");
  });
});

describe("deploy and update", () => {
  test("a first deploy creates the install behind Access, reachable only once guarded", async () => {
    const cf = new FakeCloudflareV1();
    cf.organization = null;
    await publishRelease(cf, FIRST);
    expect(await latestDeployableVersionV1(cf.fetch as typeof fetch)).toBe(
      "0.48.2",
    );

    const install = await runAll(cf, "0.48.2", newInstall(cf));

    expect([...cf.buckets].sort()).toEqual([
      "tims-frockbot-application-artifacts",
      "tims-frockbot-memory-files",
    ]);
    expect(cf.indexes.get("tims-frockbot-memory")).toEqual({
      dimensions: 768,
      metric: "cosine",
    });
    expect(cf.d1.get("tims-frockbot-auth")!.migrations).toEqual(["0001_init"]);
    expect(
      cf.objects.has(
        "tims-frockbot-application-artifacts/applications/abc.mjs",
      ),
    ).toBe(true);

    // The organization was made, and the two applications: Allow for the owner, Bypass for /api.
    expect(cf.organization!.auth_domain).toMatch(/\.cloudflareaccess\.com$/);
    expect(cf.accessApps.map((a) => a.domain)).toEqual([
      "tims-frockbot.tim-oconnell.workers.dev",
      "tims-frockbot.tim-oconnell.workers.dev/api",
    ]);
    expect(JSON.stringify(cf.accessApps[0]!.policies)).toContain(
      "tim@example.com",
    );
    expect(JSON.stringify(cf.accessApps[1]!.policies)).toContain("bypass");

    // Access existed before the Worker was uploaded, and workers.dev came last.
    const createApp = cf.calls.indexOf(
      `POST /accounts/${cf.accountId}/access/apps`,
    );
    const upload = cf.calls.indexOf(
      `PUT /accounts/${cf.accountId}/workers/scripts/tims-frockbot`,
    );
    const enable = cf.calls.indexOf(
      `POST /accounts/${cf.accountId}/workers/scripts/tims-frockbot/subdomain`,
    );
    expect(createApp).toBeGreaterThan(-1);
    expect(createApp).toBeLessThan(upload);
    expect(upload).toBeLessThan(enable);

    const script = cf.scripts.get("tims-frockbot")!;
    expect(script.migrationTag).toBe("v2");
    expect(Object.keys(script.secrets).sort()).toEqual([
      "CREDENTIAL_KEYRING",
      "ROUTINE_HOOK_SECRET",
    ]);
    const bindings = script.metadata.bindings as {
      type: string;
      name: string;
      text?: string;
    }[];
    const text = (name: string) => bindings.find((b) => b.name === name)?.text;
    expect(text("ACCESS_AUD")).toBe(install.accessAud!);
    expect(text("ACCESS_TEAM_DOMAIN")).toBe(cf.organization!.auth_domain);
    expect(text("FROCKBOT_ADMIN_EMAILS")).toBe("tim@example.com");
    expect(text("PUBLIC_ORIGIN")).toBe(
      "https://tims-frockbot.tim-oconnell.workers.dev",
    );
    expect(bindings.find((b) => b.name === "AUTH_DB")).toMatchObject({
      type: "d1",
      id: "d1-1",
    });
    expect((script.metadata.assets as { jwt: string }).jwt).toBe(
      "complete-jwt",
    );
    expect(script.workersDev).toBe(true);
  });

  test("an update keeps the data: same names, due migrations, secrets never re-minted", async () => {
    const cf = new FakeCloudflareV1();
    await publishRelease(cf, FIRST);
    const install = await runAll(cf, "0.48.2", newInstall(cf));
    const firstSecrets = { ...cf.scripts.get("tims-frockbot")!.secrets };
    const firstAssets = cf.assetHashes.size;

    await publishRelease(cf, SECOND);
    expect(await latestDeployableVersionV1(cf.fetch as typeof fetch)).toBe(
      "0.49.0",
    );
    const before = cf.calls.length;
    await runAll(cf, "0.49.0", { ...install, version: "0.48.2" });

    const script = cf.scripts.get("tims-frockbot")!;
    expect(script.uploads).toBe(2);
    expect(script.migrationTag).toBe("v3");
    expect((script.metadata.migrations as { old_tag: string }).old_tag).toBe(
      "v2",
    );
    expect(script.secrets.CREDENTIAL_KEYRING).toBe(
      firstSecrets.CREDENTIAL_KEYRING!,
    );
    expect(script.secrets.ROUTINE_HOOK_SECRET).toBe(
      firstSecrets.ROUTINE_HOOK_SECRET!,
    );
    expect(script.secrets.MACHINE_TOKEN_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(cf.d1.get("tims-frockbot-auth")!.migrations).toEqual([
      "0001_init",
      "0002_more",
    ]);
    // Converged rather than stacked: the same two Access applications, the same stores.
    expect(cf.accessApps).toHaveLength(2);
    expect(cf.buckets.size).toBe(2);
    expect(cf.kv.size).toBe(1);
    expect(cf.d1.size).toBe(1);
    expect(
      cf.calls
        .slice(before)
        .some((c) => c.startsWith("POST") && c.endsWith("/r2/buckets")),
    ).toBe(false);
    // Only the changed client file was uploaded again.
    expect(cf.assetHashes.size).toBe(firstAssets + 1);
  });

  test("the first check waits for workers.dev, and fails an install Access isn't guarding", async () => {
    const cf = new FakeCloudflareV1();
    await publishRelease(cf, FIRST);
    await runAll(cf, "0.48.2", newInstall(cf));
    const context = {
      api: new CloudflareApiV1("token", cf.fetch),
      manifest: await releaseManifestV1("0.48.2", cf.fetch as typeof fetch),
      fetcher: cf.fetch as typeof fetch,
      now: () => new Date(),
    };
    const install = {
      ...newInstall(cf),
      accessAud: "x",
      accessTeamDomain: "t",
    };
    cf.installAnswers = "down";
    await expect(
      STEP_RUNNERS_V1["first-check"](context, install),
    ).rejects.toBeInstanceOf(NotYetV1);
    cf.installAnswers = "open";
    await expect(
      STEP_RUNNERS_V1["first-check"](context, install),
    ).rejects.toThrow(/Access isn’t in front/);
  });

  test("Jev missing from Workers AI stops the deploy with the fix", async () => {
    const cf = new FakeCloudflareV1();
    cf.aiModels = ["@cf/meta/llama-3.1-8b-instruct"];
    await publishRelease(cf, FIRST);
    await expect(runAll(cf, "0.48.2", newInstall(cf))).rejects.toThrow(
      /Open Workers AI/,
    );
  });

  test("a tampered release file is refused", async () => {
    const cf = new FakeCloudflareV1();
    await publishRelease(cf, FIRST);
    cf.releases.get("0.48.2")!["app-0.48.2.js"] = encode(
      "export default { evil: true };",
    );
    await expect(runAll(cf, "0.48.2", newInstall(cf))).rejects.toThrow(
      /doesn't match its manifest/,
    );
    expect(cf.scripts.has("tims-frockbot")).toBe(false);
  });
});

describe("pages and routes", () => {
  const env = (withClient: boolean) =>
    ({
      DEPLOY_ACCOUNTS: {} as never,
      ...(withClient
        ? {
            CLOUDFLARE_OAUTH_CLIENT_ID: "id",
            CLOUDFLARE_OAUTH_CLIENT_SECRET: "secret",
          }
        : {}),
    }) as Parameters<typeof handleDeployRequestV1>[1];

  test("without a registered client, /deploy points at the repository", async () => {
    const response = await handleDeployRequestV1(
      new Request("https://frockbot.com/deploy"),
      env(false),
    );
    expect(await response.text()).toContain("Use the repository");
  });

  test("the start page signs in with Cloudflare", async () => {
    const response = await handleDeployRequestV1(
      new Request("https://frockbot.com/deploy"),
      env(true),
    );
    const body = await response.text();
    expect(body).toContain('href="/deploy/sign-in"');
    expect(body).not.toContain("<script>");
  });

  test("sign-in sends the person to Cloudflare with PKCE and the deploy scopes", async () => {
    const response = await handleDeployRequestV1(
      new Request("https://frockbot.com/deploy/sign-in"),
      env(true),
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://frockbot.com/deploy/callback",
    );
    expect(location.searchParams.get("scope")).toContain(
      "workers-scripts.write",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("a callback whose state doesn't match is refused", async () => {
    const response = await handleDeployRequestV1(
      new Request("https://frockbot.com/deploy/callback?code=c&state=wrong", {
        headers: { cookie: "__Host-frockbot_deploy_oauth=right.verifier" },
      }),
      env(true),
    );
    expect(await response.text()).toContain("expired");
  });

  test("a form posted from another site is refused", async () => {
    const response = await handleDeployRequestV1(
      new Request("https://frockbot.com/deploy/start", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "name=x&accountId=y",
      }),
      env(true),
    );
    expect(response.status).toBe(403);
  });

  test("escapes what the person typed", async () => {
    const response = choosePageV1({
      email: "tim@example.com",
      account: { id: "a", name: "<b>Tim</b>" },
      name: '"><script>x</script>',
      workersSubdomain: "sub",
      checks: [],
      canDeploy: false,
      version: "1.0.0",
    });
    const body = await response.text();
    expect(body).not.toContain("<script>x");
    expect(body).toContain(escapeHtmlV1("<b>Tim</b>"));
  });

  test("the Deploying page stays live only while the deploy runs", async () => {
    const install = newInstall(new FakeCloudflareV1());
    const job = {
      id: "j",
      kind: "deploy" as const,
      installKey: "k",
      version: "0.48.2",
      steps: DEPLOY_STEPS_V1.map((id, i) => ({
        id,
        state: i === 0 ? ("done" as const) : ("waiting" as const),
      })),
      startedAt: "2026-09-30T00:00:00Z",
    };
    expect(
      await progressPageV1({ ...job, state: "running" }, install).text(),
    ).toContain('data-live="true"');
    const failed = await progressPageV1(
      { ...job, state: "failed", error: "x" },
      install,
    ).text();
    expect(failed).not.toContain('data-live="true"');
    expect(failed).toContain("Try again");
  });
});

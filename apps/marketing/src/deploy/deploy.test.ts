import { describe, expect, test } from "bun:test";
import { accountChecksV1 } from "./checks";
import { CloudflareApiV1 } from "./cloudflare-api";
import {
  NotYetV1,
  STEP_RUNNERS_V1,
  type DeployContextV1,
  type InstallRecordV1,
} from "./deployer";
import {
  FakeCloudflareV1,
  MemoryBucketV1,
  bufferedDigestSinkV1,
  publishTestBundleV1,
  tarGzV1,
} from "./fake-cloudflare.test-support";
import { choosePageV1, escapeHtmlV1, progressPageV1 } from "./pages";
import {
  DEPLOY_STEPS_V1,
  installNameProblemV1,
  isNewerVersionV1,
  normalizeInstallNameV1,
  progressPercentV1,
  suggestedInstallNameV1,
} from "./plan";
import {
  latestDeployableVersionV1,
  readTarV1,
  releaseManifestV1,
  stageBundleV1,
} from "./release";
import { handleDeployRequestV1 } from "./routes";

const encode = (text: string) => new TextEncoder().encode(text);

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

async function contextFor(
  cf: FakeCloudflareV1,
  version: string,
  bundles = new MemoryBucketV1(),
): Promise<DeployContextV1> {
  return {
    api: new CloudflareApiV1("token", cf.fetch),
    token: "token",
    manifest: await releaseManifestV1(version, cf.fetch as typeof fetch),
    bundles,
    fetcher: cf.fetch as typeof fetch,
    now: () => new Date("2026-09-30T00:00:00Z"),
    digestSink: bufferedDigestSinkV1,
  };
}

async function runAll(
  cf: FakeCloudflareV1,
  version: string,
  install: InstallRecordV1,
  bundles = new MemoryBucketV1(),
) {
  const context = await contextFor(cf, version, bundles);
  let current = install;
  for (const step of DEPLOY_STEPS_V1) {
    current = await STEP_RUNNERS_V1[step](context, current);
  }
  return current;
}

describe("plan", () => {
  test("install names fit every resource and a DNS label", () => {
    expect(installNameProblemV1("tims-frockbot")).toBeUndefined();
    expect(installNameProblemV1("Tims")).toBeDefined();
    expect(installNameProblemV1("a--b")).toBeDefined();
    expect(installNameProblemV1("x".repeat(41))).toBeDefined();
    expect(normalizeInstallNameV1("  My Frock_Bot!! ")).toBe("my-frock-bot");
    expect(suggestedInstallNameV1("tim@example.com")).toBe("tim-frockbot");
  });

  test("compares versions numerically", () => {
    expect(isNewerVersionV1("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersionV1("0.9.9", "0.10.0")).toBe(false);
    expect(isNewerVersionV1("1.0.0", "1.0.0")).toBe(false);
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

describe("staging a release", () => {
  test("reads GNU tar: ./ paths, long names, and nothing that climbs out", async () => {
    const long = `assets/${"deep/".repeat(30)}main.js`;
    const seen: string[] = [];
    const archive = await tarGzV1({
      "a.txt": encode("a"),
      [long]: encode("b"),
    });
    await readTarV1(
      new Blob([archive as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream("gzip")),
      async (path, bytes) => {
        seen.push(`${path}=${new TextDecoder().decode(bytes)}`);
      },
    );
    expect(seen).toEqual(["a.txt=a", `${long}=b`]);
    const evil = await tarGzV1({ "../evil": encode("x") });
    await expect(
      readTarV1(
        new Blob([evil as Uint8Array<ArrayBuffer>])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
        async () => {},
      ),
    ).rejects.toThrow(/unsafe path/);
  });

  test("streams a release into the bucket once, and refuses one whose archive isn't the manifest's", async () => {
    const cf = new FakeCloudflareV1();
    const manifest = await publishTestBundleV1(cf, {
      version: "0.9.3",
      appMigrations: ["v1"],
    });
    expect(await latestDeployableVersionV1(cf.fetch as typeof fetch)).toBe(
      "0.9.3",
    );
    const bucket = new MemoryBucketV1();
    const options = {
      fetcher: cf.fetch as typeof fetch,
      digestSink: bufferedDigestSinkV1,
    };
    await stageBundleV1(bucket, manifest, options);
    await stageBundleV1(bucket, manifest, options);
    expect(cf.downloads.filter((d) => d.endsWith(".tar.gz"))).toHaveLength(1);
    expect(
      bucket.objects.has("bundles/0.9.3/files/application-artifact.mjs"),
    ).toBe(true);

    const tampered = new MemoryBucketV1();
    await expect(
      stageBundleV1(
        tampered,
        {
          ...manifest,
          archive: { ...manifest.archive, sha256: "0".repeat(64) },
        },
        options,
      ),
    ).rejects.toThrow(/doesn't match/);
    expect(
      [...tampered.objects.keys()].some((k) => k.includes("complete")),
    ).toBe(false);
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
  test("a first deploy puts the install on workers.dev behind Access, through the bundle's deployer", async () => {
    const cf = new FakeCloudflareV1();
    cf.organization = null;
    await publishTestBundleV1(cf, {
      version: "0.9.3",
      appMigrations: ["v1", "v2"],
      installVars: ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "APP_ORIGIN"],
    });
    const install = await runAll(cf, "0.9.3", newInstall(cf));

    expect([...cf.buckets].sort()).toEqual([
      "tims-frockbot-application-artifacts",
      "tims-frockbot-memory-files",
    ]);
    expect(cf.indexes.get("tims-frockbot-memory")).toEqual({
      dimensions: 768,
      metric: "cosine",
    });
    // The organization was made, and the applications: Allow for the owner, Bypass for /api and discovery.
    expect(cf.organization!.auth_domain).toMatch(/\.cloudflareaccess\.com$/);
    expect(cf.accessApps.map((a) => a.domain)).toEqual([
      "tims-frockbot.tim-oconnell.workers.dev",
      "tims-frockbot.tim-oconnell.workers.dev/api",
      "tims-frockbot.tim-oconnell.workers.dev/.well-known/frockbot.json",
    ]);
    expect(JSON.stringify(cf.accessApps[0]!.policies)).toContain(
      "tim@example.com",
    );

    // Access existed before anything was uploaded; workers.dev, no domain, no Computer host.
    const createApp = cf.calls.indexOf(
      `POST /accounts/${cf.accountId}/access/apps`,
    );
    const firstUpload = cf.calls.findIndex((c) =>
      c.startsWith(`PUT /accounts/${cf.accountId}/workers/scripts/`),
    );
    expect(createApp).toBeGreaterThan(-1);
    expect(createApp).toBeLessThan(firstUpload);
    expect([...cf.scripts.keys()].sort()).toEqual([
      "tims-frockbot",
      "tims-frockbot-applet-build",
    ]);
    expect(cf.calls.some((c) => c.includes("/domains/records"))).toBe(false);
    const app = cf.scripts.get("tims-frockbot")!;
    expect(app.workersDev).toBe(true);
    expect(app.migrationTag).toBe("v2");
    const bindings = app.metadata.bindings as {
      type: string;
      name: string;
      text?: string;
    }[];
    const text = (name: string) => bindings.find((b) => b.name === name)?.text;
    expect(text("ACCESS_AUD")).toBe(install.accessAud!);
    expect(text("ACCESS_TEAM_DOMAIN")).toBe(cf.organization!.auth_domain);
    expect(text("APP_ORIGIN")).toBe(
      "https://tims-frockbot.tim-oconnell.workers.dev",
    );
    expect(bindings.some((b) => b.name === "COMPUTER_HOST")).toBe(false);

    // Minted once, shared where the bundle says, and the owner is the admin.
    expect(Object.keys(app.secrets).sort()).toEqual([
      "APPLET_BUILD_TOKEN",
      "CREDENTIAL_KEYRING",
      "FROCKBOT_ADMIN_EMAILS",
      "WEB_PUSH_VAPID_KEYS",
    ]);
    expect(app.secrets.FROCKBOT_ADMIN_EMAILS).toBe("tim@example.com");
    expect(
      cf.scripts.get("tims-frockbot-applet-build")!.secrets.APPLET_BUILD_TOKEN,
    ).toBe(app.secrets.APPLET_BUILD_TOKEN!);
    expect(JSON.parse(app.secrets.WEB_PUSH_VAPID_KEYS!).subject).toBe(
      "https://tims-frockbot.tim-oconnell.workers.dev",
    );
    expect(cf.containers.map((c) => c.name)).toEqual([
      "tims-frockbot-applet-build-appletbuildcontainer",
    ]);
  });

  test("an update keeps the data: the same install, the next migrations, secrets never re-minted", async () => {
    const cf = new FakeCloudflareV1();
    const bundles = new MemoryBucketV1();
    await publishTestBundleV1(cf, { version: "0.9.3", appMigrations: ["v1"] });
    const install = await runAll(cf, "0.9.3", newInstall(cf), bundles);
    const first = { ...cf.scripts.get("tims-frockbot")!.secrets };

    await publishTestBundleV1(cf, {
      version: "0.9.4",
      appMigrations: ["v1", "v2"],
      client: { "index.html": "<!doctype html>", "main.js": "main(2)" },
    });
    expect(await latestDeployableVersionV1(cf.fetch as typeof fetch)).toBe(
      "0.9.4",
    );
    await runAll(cf, "0.9.4", { ...install, version: "0.9.3" }, bundles);

    const app = cf.scripts.get("tims-frockbot")!;
    expect(app.uploads).toBe(2);
    expect(app.migrationTag).toBe("v2");
    expect((app.metadata.migrations as { old_tag: string }).old_tag).toBe("v1");
    expect(app.secrets).toEqual(first);
    const sent = (app.metadata.bindings as { type: string; name: string }[])
      .filter((b) => b.type === "secret_text")
      .map((b) => b.name);
    expect(sent).toEqual(["FROCKBOT_ADMIN_EMAILS"]);
    expect(cf.accessApps).toHaveLength(3);
    expect(cf.buckets.size).toBe(2);
  });

  test("a first deploy that stopped between Workers converges on retry", async () => {
    const cf = new FakeCloudflareV1();
    await publishTestBundleV1(cf, { version: "0.9.3", appMigrations: ["v1"] });
    // The build service took a token, and the app upload never happened.
    cf.scripts.set("tims-frockbot-applet-build", {
      metadata: {},
      secrets: { APPLET_BUILD_TOKEN: "orphaned" },
      migrationTag: "v1",
      workersDev: false,
      uploads: 1,
    });
    cf.namespaces.push({
      id: "ns-b",
      script: "tims-frockbot-applet-build",
      class: "AppletBuildContainer",
    });
    await runAll(cf, "0.9.3", newInstall(cf));
    const token = cf.scripts.get("tims-frockbot")!.secrets.APPLET_BUILD_TOKEN;
    expect(token).not.toBe("orphaned");
    expect(
      cf.scripts.get("tims-frockbot-applet-build")!.secrets.APPLET_BUILD_TOKEN,
    ).toBe(token!);
  });

  test("the first check waits for workers.dev, and fails an install Access isn't guarding", async () => {
    const cf = new FakeCloudflareV1();
    await publishTestBundleV1(cf, { version: "0.9.3", appMigrations: ["v1"] });
    await runAll(cf, "0.9.3", newInstall(cf));
    const context = await contextFor(cf, "0.9.3");
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
    await publishTestBundleV1(cf, { version: "0.9.3", appMigrations: ["v1"] });
    await expect(runAll(cf, "0.9.3", newInstall(cf))).rejects.toThrow(
      /Open Workers AI/,
    );
  });

  test("a module whose staged bytes aren't the manifest's is refused before upload", async () => {
    const cf = new FakeCloudflareV1();
    await publishTestBundleV1(cf, { version: "0.9.3", appMigrations: ["v1"] });
    const bundles = new MemoryBucketV1();
    const context = await contextFor(cf, "0.9.3", bundles);
    let install = await STEP_RUNNERS_V1.storage(context, newInstall(cf));
    install = await STEP_RUNNERS_V1["sign-in"](context, install);
    bundles.objects.set(
      "bundles/0.9.3/files/workers/app/index.js",
      encode("export default { evil: true };"),
    );
    await expect(STEP_RUNNERS_V1.release(context, install)).rejects.toThrow(
      /hashes to/,
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

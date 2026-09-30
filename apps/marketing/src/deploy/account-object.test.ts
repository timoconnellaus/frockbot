import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { FakeCloudflareV1 } from "./fake-cloudflare.test-support";
import { CLOUDFLARE_REVOKE_URL_V1, CLOUDFLARE_TOKEN_URL_V1 } from "./oauth";

// The object's base class is the runtime's; a stand-in holding `ctx` and `env`
// is all the object uses of it.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

let DeployAccount: typeof import("./account-object").DeployAccount;
beforeAll(async () => {
  ({ DeployAccount } = await import("./account-object"));
});

class MemoryStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map(
      [...this.data.entries()].filter(([k]) => k.startsWith(prefix)) as [
        string,
        T,
      ][],
    );
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The fake account, plus Cloudflare's token endpoint rotating refresh tokens. */
function world() {
  const cf = new FakeCloudflareV1();
  const live = new Set(["refresh-0"]);
  let issued = 0;
  const revoked: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === CLOUDFLARE_TOKEN_URL_V1) {
      const body = new URLSearchParams(String(init?.body));
      const presented = body.get("refresh_token")!;
      if (!live.delete(presented)) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      issued += 1;
      live.add(`refresh-${issued}`);
      return Response.json({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: 3600,
      });
    }
    if (url === CLOUDFLARE_REVOKE_URL_V1) {
      revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return new Response(null, { status: 200 });
    }
    return cf.fetch(input, init);
  };
  globalThis.fetch = fetcher as typeof fetch;
  const storage = new MemoryStorage();
  const object = new DeployAccount({ storage } as never, {
    DEPLOY_ACCOUNTS: {} as never,
    CLOUDFLARE_OAUTH_CLIENT_ID: "id",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "secret",
  });
  const expired = {
    accessToken: "access-0",
    refreshToken: "refresh-0",
    expiresAt: 0,
  };
  return { cf, storage, object, expired, revoked, issued: () => issued };
}

async function publishMinimalRelease(cf: FakeCloudflareV1) {
  const js = new TextEncoder().encode("export default {};");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", js))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await cf.publish(
    "1.0.0",
    { "app.js": js },
    {
      schemaVersion: 1,
      version: "1.0.0",
      resources: { r2Buckets: ["files"] },
      workers: [
        {
          role: "app",
          mainModule: "index.js",
          modules: [
            { name: "index.js", type: "esm", asset: "app.js", sha256: digest },
          ],
          compatibilityDate: "2026-08-27",
          bindings: [
            { type: "r2_bucket", name: "FILES", bucket: "files" },
            { type: "access_aud", name: "ACCESS_AUD" },
            { type: "access_team_domain", name: "ACCESS_TEAM_DOMAIN" },
          ],
          migrations: [{ tag: "v1", newSqliteClasses: ["BotState"] }],
          secrets: [{ name: "ROUTINE_HOOK_SECRET", shape: "hex" }],
        },
      ],
    },
  );
}

async function runAlarms(
  object: InstanceType<typeof DeployAccount>,
  storage: MemoryStorage,
) {
  for (let i = 0; i < 20; i += 1) {
    const job = (await storage.get<{ state: string }>("job"))!;
    if (job.state !== "running") return job;
    await object.alarm();
  }
  throw new Error("The deploy never settled");
}

describe("DeployAccount", () => {
  test("a deploy runs by alarm on the session's grant, refreshed once and shared", async () => {
    const { cf, storage, object, expired, issued } = world();
    await publishMinimalRelease(cf);
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      expired,
    );
    // The checks refresh the lapsed token; the deploy then uses the same grant.
    const checks = await object.checks(secret, cf.accountId);
    expect(checks!.every((c) => c.state === "ok")).toBe(true);
    expect(issued()).toBe(1);

    const started = await object.startDeploy(
      secret,
      cf.accountId,
      "tims-frockbot",
      "1.0.0",
    );
    expect(started.ok).toBe(true);
    // A cookie's worth of state never reaches the page.
    expect(JSON.stringify(started)).not.toContain("access-");

    const job = (await runAlarms(object, storage)) as {
      state: string;
      error?: string;
    };
    expect(job).toMatchObject({ state: "done" });
    expect(cf.scripts.get("tims-frockbot")!.workersDev).toBe(true);
    const status = await object.status(secret);
    expect(status!.installs[0]).toMatchObject({
      name: "tims-frockbot",
      version: "1.0.0",
    });
    // The session can still act after the deploy: its grant was never invalidated.
    expect(await object.checks(secret, cf.accountId)).not.toBeNull();
  });

  test("a deploy refuses to start before every check passed", async () => {
    const { cf, object, expired } = world();
    cf.zeroTrust = false;
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      expired,
    );
    await object.checks(secret, cf.accountId);
    const started = await object.startDeploy(
      secret,
      cf.accountId,
      "tims-frockbot",
      "1.0.0",
    );
    expect(started).toEqual({
      ok: false,
      problem: "Every account check has to pass first.",
    });
  });

  test("signing out mid-deploy leaves the deploy its grant, then drops it", async () => {
    const { cf, storage, object, expired, revoked } = world();
    await publishMinimalRelease(cf);
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      expired,
    );
    await object.checks(secret, cf.accountId);
    await object.startDeploy(secret, cf.accountId, "tims-frockbot", "1.0.0");
    await object.endSession(secret);
    expect(revoked).toEqual([]);
    expect(await object.status(secret)).toBeNull();

    expect(await runAlarms(object, storage)).toMatchObject({ state: "done" });
    expect([...storage.data.keys()].some((k) => k.startsWith("grant:"))).toBe(
      false,
    );
    expect(revoked).toHaveLength(1);
  });

  test("a failed step can be tried again from where it stopped", async () => {
    const { cf, storage, object, expired } = world();
    await publishMinimalRelease(cf);
    cf.aiModels = [];
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      expired,
    );
    cf.aiModels = ["x"];
    await object.checks(secret, cf.accountId);
    await object.startDeploy(secret, cf.accountId, "tims-frockbot", "1.0.0");
    const failed = (await runAlarms(object, storage)) as {
      state: string;
      steps: { id: string; state: string }[];
    };
    expect(failed.state).toBe("failed");
    expect(failed.steps.find((s) => s.state === "failed")!.id).toBe(
      "workers-ai",
    );
    const uploads = cf.scripts.get("tims-frockbot")!.uploads;

    cf.aiModels = ["typesafe/jev"];
    expect((await object.retry(secret)).ok).toBe(true);
    expect(await runAlarms(object, storage)).toMatchObject({ state: "done" });
    // Picked up at Jev: the release wasn't uploaded again.
    expect(cf.scripts.get("tims-frockbot")!.uploads).toBe(uploads);
  });
});

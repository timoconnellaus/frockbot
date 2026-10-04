import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  FakeCloudflareV1,
  MemoryBucketV1,
  bufferedDigestSinkV1,
  publishTestBundleV1,
} from "./fake-cloudflare.test-support";
import { CLOUDFLARE_REVOKE_URL_V1 } from "./oauth";
import { suggestedWorkersSubdomainV1 } from "./plan";

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

// Workers' streaming digest, which staging takes the archive's sha256 with.
(crypto as unknown as { DigestStream: unknown }).DigestStream = class {
  constructor() {
    const sink = bufferedDigestSinkV1();
    return Object.assign(sink.writable, { digest: sink.digest });
  }
};

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

/** The fake account, plus Cloudflare's revoke endpoint. */
function world() {
  const cf = new FakeCloudflareV1();
  const revoked: string[] = [];
  // Like workerd's global fetch, refuses to be called as another object's method.
  const fetcher = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    const url = String(input instanceof Request ? input.url : input);
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
    DEPLOY_BUNDLES: new MemoryBucketV1() as unknown as R2Bucket,
    CLOUDFLARE_OAUTH_CLIENT_ID: "id",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "secret",
  });
  const grant = {
    accessToken: "access-0",
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  return { cf, storage, object, grant, revoked };
}

async function publishMinimalRelease(cf: FakeCloudflareV1) {
  await publishTestBundleV1(cf, { version: "1.0.0", appMigrations: ["v1"] });
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
  test("a deploy runs by alarm on the session's grant, revoked when it finishes", async () => {
    const { cf, storage, object, grant, revoked } = world();
    await publishMinimalRelease(cf);
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      grant,
    );
    const checks = await object.checks(secret, cf.accountId);
    expect(checks!.every((c) => c.state === "ok")).toBe(true);

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
    // The page can still show the result, but Cloudflare access ended with
    // the deploy: an update needs a new sign-in.
    expect(status!.signedIn).toBe(false);
    expect(revoked).toEqual(["access-0"]);
    expect([...storage.data.keys()].some((k) => k.startsWith("grant:"))).toBe(
      false,
    );
    expect(
      await object.startUpdate(
        secret,
        `${cf.accountId}/tims-frockbot`,
        "1.0.0",
      ),
    ).toEqual({
      ok: false,
      problem: "Your Cloudflare sign-in has ended. Sign in again.",
    });
  });

  test("a sign-in whose access token lapsed can't reach the account", async () => {
    const { cf, object, grant } = world();
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      { ...grant, expiresAt: Date.now() - 1 },
    );
    expect((await object.status(secret))!.signedIn).toBe(false);
    await expect(object.checks(secret, cf.accountId)).rejects.toThrow(
      "sign-in has ended",
    );
  });

  test("a deploy won't start on an access token too close to lapsing to finish", async () => {
    const { cf, storage, object, grant } = world();
    await publishMinimalRelease(cf);
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      { ...grant, expiresAt: Date.now() + 2 * 60 * 1000 },
    );
    const checks = await object.checks(secret, cf.accountId);
    expect(checks!.every((c) => c.state === "ok")).toBe(true);
    expect((await object.status(secret))!.signedIn).toBe(false);
    expect(
      await object.startDeploy(secret, cf.accountId, "tims-frockbot", "1.0.0"),
    ).toEqual({
      ok: false,
      problem: "Your Cloudflare sign-in has ended. Sign in again.",
    });
    expect(await storage.get("job")).toBeUndefined();
    expect(cf.scripts.size).toBe(0);
  });

  test("reloading Choose reuses the checks; Check again reads the account afresh", async () => {
    const { cf, object, grant } = world();
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      grant,
    );
    cf.zeroTrust = false;
    await object.checks(secret, cf.accountId);
    await object.checks(secret, cf.accountId);
    // One reading: the plan probe and the Jev probe.
    expect(cf.deletedScripts).toHaveLength(2);
    cf.zeroTrust = true;
    const again = await object.checks(secret, cf.accountId, true);
    expect(cf.deletedScripts).toHaveLength(4);
    expect(again!.every((c) => c.state === "ok")).toBe(true);
  });

  test("an account with no workers.dev subdomain gets the one its deploy would make, for the Jev probe", async () => {
    const { cf, object, grant } = world();
    cf.subdomain = null;
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      grant,
    );
    const checks = await object.checks(secret, cf.accountId);
    expect(checks!.find((c) => c.id === "workers-ai")!.state).toBe("ok");
    expect(cf.subdomain as string | null).toBe(
      suggestedWorkersSubdomainV1(cf.accountName, cf.accountId),
    );
  });

  test("a deploy refuses to start before every check passed", async () => {
    const { cf, object, grant } = world();
    cf.zeroTrust = false;
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      grant,
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
    const { cf, storage, object, grant, revoked } = world();
    await publishMinimalRelease(cf);
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      grant,
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
    const { cf, storage, object, grant } = world();
    await publishMinimalRelease(cf);
    const secret = await object.startSession(
      { id: "user-1", email: "tim@example.com" },
      [{ id: cf.accountId, name: cf.accountName }],
      grant,
    );
    await object.checks(secret, cf.accountId);
    await object.startDeploy(secret, cf.accountId, "tims-frockbot", "1.0.0");
    // Workers AI stops running Jev between the check and the deploy's own look.
    cf.jev = "5018: Account not allowed for private model";
    const failed = (await runAlarms(object, storage)) as {
      state: string;
      steps: { id: string; state: string }[];
    };
    expect(failed.state).toBe("failed");
    expect(failed.steps.find((s) => s.state === "failed")!.id).toBe(
      "workers-ai",
    );
    const uploads = cf.scripts.get("tims-frockbot")!.uploads;

    cf.jev = "answers";
    expect((await object.retry(secret)).ok).toBe(true);
    expect(await runAlarms(object, storage)).toMatchObject({ state: "done" });
    // Picked up at Jev: the release wasn't uploaded again.
    expect(cf.scripts.get("tims-frockbot")!.uploads).toBe(uploads);
  });
});

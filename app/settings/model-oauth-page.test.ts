import { afterEach, describe, expect, test } from "bun:test";
import type {
  CredentialStorage,
  CredentialTransaction,
  PreparedApiKeyCredential,
} from "@frockbot/app/credentials/user";
import type {
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import type { ConnectionCommandV1 } from "@frockbot/core/connection";
import type { OllamaUserBackendHost } from "@frockbot/providers/ollama-cloud/user";
import { ModelOAuthUserV1 } from "../../providers/catalog/oauth-user.js";
import { createSettingsBackendContribution } from "./backend.js";

class Storage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;
  async get<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string | Record<string, unknown>, value?: T) {
    for (const [name, entry] of typeof key === "string"
      ? [[key, value]]
      : Object.entries(key))
      this.values.set(name as string, entry);
  }
  async delete(key: string) {
    return this.values.delete(key);
  }
  async transaction<T>(
    callback: (
      storage: UserSettingsTransaction & CredentialTransaction,
    ) => Promise<T>,
  ) {
    return callback(this);
  }
  async getAlarm() {
    return this.alarm ?? null;
  }
  async setAlarm(value: number | Date) {
    this.alarm = Number(value);
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fixture() {
  const storage = new Storage();
  const clock = { now: 1_000_000 };
  const sealed = new WeakMap<object, string>();
  const credentials = {
    async prepareApiKey(input: {
      accountId: string;
      connectionId: string;
      packageId: string;
      generation: string;
      apiKey: string;
    }) {
      const prepared = {
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: input.packageId,
        generation: input.generation,
        envelope: {},
      } as PreparedApiKeyCredential;
      sealed.set(prepared.envelope, input.apiKey);
      return prepared;
    },
    async openPreparedSecret(input: PreparedApiKeyCredential) {
      const value = sealed.get(input.envelope);
      if (value === undefined) throw new Error("sealed value unavailable");
      return value;
    },
  } as unknown as OllamaUserBackendHost["credentials"];
  const manager = new ModelOAuthUserV1(
    "xai",
    {
      storage,
      credentials,
      settings: {
        isPackageInstalled: async (accountId: string, packageId: string) =>
          accountId === "account-1" && packageId === "provider-xai",
        read: async (accountId: string) => {
          if (accountId !== "account-1") throw new Error("unknown account");
          return {};
        },
      } as unknown as OllamaUserBackendHost["settings"],
      now: () => clock.now,
    },
    async (_accountId: string, attemptId: string) => ({
      schemaVersion: 1,
      commandId: `install-${attemptId}`,
      connectionId: `connection-${attemptId}`,
      status: "applied",
    }),
  );
  const contribution = createSettingsBackendContribution({
    executeConnection: (userId, command) =>
      manager.execute(
        userId,
        command as Extract<ConnectionCommandV1, { type: "connection/oauth" }>,
      ),
    lookupConnectionCommand: async () => undefined,
    listCompositionGenerations: async () => {
      throw new Error("unused");
    },
    getCompositionGeneration: async () => undefined,
    revertComposition: async () => {
      throw new Error("unused");
    },
  });
  return { contribution, clock };
}

function mockDeviceAndToken(): void {
  const responses = [
    Response.json({
      device_code: "DEVICE-TOKEN-SECRET",
      user_code: "PUBLIC-CODE",
      verification_uri: "https://auth.x.ai/activate",
      expires_in: 900,
      interval: 1,
    }),
    Response.json({
      access_token: "ACCESS-TOKEN-SECRET",
      refresh_token: "REFRESH-TOKEN-SECRET",
      expires_in: 300,
    }),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected OAuth request");
    return next;
  }) as unknown as typeof fetch;
}

async function start(
  contribution: ReturnType<typeof createSettingsBackendContribution>,
  commandId = "attempt-1",
) {
  const url = new URL(
    "https://frockbot.test/api/plugins/provider-xai/connections",
  );
  const response = await contribution.route(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        type: "connection/start",
        commandId,
        connectionTypeId: "xai-oauth",
        alias: "Primary",
      }),
    }),
    url,
    { userId: "account-1", client: "browser" },
  );
  expect(response?.status).toBe(200);
  return (await response!.json()) as { redirectUrl: string; expiresAt: string };
}

async function progress(
  contribution: ReturnType<typeof createSettingsBackendContribution>,
  body: Record<string, unknown>,
) {
  const url = new URL("https://frockbot.test/api/model-oauth/progress");
  return contribution.publicRoute!(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    { client: "browser" },
  );
}

describe("public model sign-in route", () => {
  test("requires the attempt capability and rejects it after expiry", async () => {
    const { contribution, clock } = fixture();
    mockDeviceAndToken();
    const authorization = await start(contribution);
    const redirect = new URL(authorization.redirectUrl);
    expect(redirect.search).toBe("");
    const parameters = new URLSearchParams(redirect.hash.slice(1));
    const browserKey = parameters.get("browserKey")!;
    expect(browserKey.length).toBeGreaterThanOrEqual(64);

    for (const body of [
      {
        userId: "account-1",
        packageId: "provider-xai",
        attemptId: "attempt-1",
        action: "check",
      },
      {
        userId: "account-1",
        packageId: "provider-xai",
        attemptId: "attempt-1",
        browserKey: "x".repeat(64),
        action: "check",
      },
      {
        userId: "other-account",
        packageId: "provider-xai",
        attemptId: "attempt-1",
        browserKey,
        action: "check",
      },
    ]) {
      const response = await progress(contribution, body);
      expect(response?.status).toBe(400);
      expect((await response!.json()) as { error: string }).toEqual({
        error:
          "Sign-in link is invalid, expired, or could not finish. Start a new sign-in in FrockBot.",
      });
    }

    clock.now = Date.parse(authorization.expiresAt);
    const expired = await progress(contribution, {
      userId: "account-1",
      packageId: "provider-xai",
      attemptId: "attempt-1",
      browserKey,
      action: "check",
    });
    expect(expired?.status).toBe(400);
  });

  test("returns public progress and completion without provider tokens", async () => {
    const { contribution, clock } = fixture();
    mockDeviceAndToken();
    const authorization = await start(contribution);
    const redirect = new URL(authorization.redirectUrl);
    expect(redirect.search).toBe("");
    const parameters = new URLSearchParams(redirect.hash.slice(1));
    const body = {
      userId: "account-1",
      packageId: "provider-xai",
      attemptId: "attempt-1",
      browserKey: parameters.get("browserKey")!,
      action: "check",
    };

    let response = await progress(contribution, body);
    expect(response?.status).toBe(200);
    let text = await response!.text();
    expect(text).toContain('"status":"waiting"');
    expect(text).not.toContain("browserKey");
    expect(text).not.toContain("DEVICE-TOKEN-SECRET");

    clock.now = 1_001_000;
    response = await progress(contribution, body);
    expect(response?.status).toBe(200);
    text = await response!.text();
    expect(text).toContain('"status":"ready"');
    expect(text).not.toContain("ACCESS-TOKEN-SECRET");
    expect(text).not.toContain("REFRESH-TOKEN-SECRET");
    expect(text).not.toContain("browserKey");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "@frockbot/app/credentials/user";
import type {
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import { createUserSettingsBackendContribution } from "@frockbot/app/settings/user";
import type { ConnectionCommandReceiptV1 } from "@frockbot/core/connection";
import type { OllamaUserBackendHost } from "../ollama-cloud/user.js";
import {
  catalogProviderDefinitionsV1,
  catalogProvidersV1,
} from "./definition.js";
import { providerModelsV1 } from "./models.js";
import { decodeOAuthTokenV1 } from "./oauth-protocol.js";
import { ModelOAuthUserV1 } from "./oauth-user.js";
import { createCatalogConnectionOwnerV1 } from "./user.js";

class MemoryStorage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else
      for (const [key, entry] of Object.entries(keyOrEntries))
        this.values.set(key, entry);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  async transaction<T>(
    callback: (
      storage: UserSettingsTransaction & CredentialTransaction,
    ) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm ?? null);
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = Number(scheduledTime);
    return Promise.resolve();
  }
}

function keyring(): string {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 31);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId: "primary",
    keys: { primary: key },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponses(responses: Response[]): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected OAuth request to ${url}`);
    return next;
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fixture(provider: "xai" | "openrouter", initialNow = 1_000_000) {
  const storage = new MemoryStorage();
  const clock = { now: initialNow };
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: keyring(),
    now: () => clock.now,
  });
  const installed: Array<{
    accountId: string;
    attemptId: string;
    label: string;
    secret: string;
  }> = [];
  const host = {
    storage,
    credentials,
    settings: {
      isPackageInstalled: async (accountId: string, packageId: string) =>
        accountId === "account-1" && packageId === `provider-${provider}`,
      read: async (accountId: string) => {
        if (accountId !== "account-1") throw new Error("unknown account");
        return {};
      },
    } as unknown as OllamaUserBackendHost["settings"],
    now: () => clock.now,
  } satisfies OllamaUserBackendHost;
  const install = async (
    accountId: string,
    attemptId: string,
    label: string,
    secret: string,
  ): Promise<ConnectionCommandReceiptV1> => {
    installed.push({ accountId, attemptId, label, secret });
    return {
      schemaVersion: 1,
      commandId: `install-${attemptId}`,
      connectionId: `connection-${attemptId}`,
      status: "applied",
    };
  };
  return {
    storage,
    clock,
    credentials,
    installed,
    manager: new ModelOAuthUserV1(provider, host, install),
    reconstruct: () => new ModelOAuthUserV1(provider, host, install),
  };
}

function startCommand(provider: "xai" | "openrouter") {
  return {
    schemaVersion: 1 as const,
    type: "connection/oauth" as const,
    action: "start" as const,
    commandId: "start-attempt-1",
    packageId: `provider-${provider}`,
    attemptId: "attempt-1",
    label: "Primary account",
    ...(provider === "openrouter"
      ? { callbackUrl: "https://app.example/oauth/callback" }
      : {}),
  };
}

describe("durable model OAuth manager", () => {
  test("stores pending device authorization encrypted and exposes no device secret", async () => {
    const fixtureState = fixture("xai");
    mockResponses([
      json({
        device_code: "DEVICE-CODE-SECRET",
        user_code: "PUBLIC-CODE",
        verification_uri: "https://auth.x.ai/activate",
        expires_in: 900,
        interval: 2,
      }),
    ]);

    const receipt = await fixtureState.manager.execute(
      "account-1",
      startCommand("xai"),
    );

    expect(receipt.oauth).toMatchObject({
      attemptId: "attempt-1",
      status: "waiting",
      authorizationUrl: "https://auth.x.ai/activate",
      userCode: "PUBLIC-CODE",
      pollAfterMs: 2_000,
    });
    const durable = JSON.stringify([...fixtureState.storage.values]);
    expect(durable).not.toContain("DEVICE-CODE-SECRET");
    expect(durable).not.toContain("pkce-verifier");
    expect(durable).toContain("ciphertext");
    expect(fixtureState.storage.alarm).toBe(1_002_000);
  });

  test("creates and leases an OAuth connection through the catalog owner", async () => {
    const storage = new MemoryStorage();
    const clock = { now: 1_000_000 };
    const provider = catalogProvidersV1.find(
      (candidate) => candidate.id === "xai",
    )!;
    const definition = catalogProviderDefinitionsV1.find(
      (candidate) => candidate.id === "provider-xai",
    )!;
    const settings = createUserSettingsBackendContribution({
      storage,
      availablePackages: [
        {
          packageId: definition.id,
          version: "0.0.1",
          connectionTypes: definition.connectionTypes,
        },
      ],
    });
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "account-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-provider-xai",
        expectedRevision: 0,
        packageId: "provider-xai",
        version: "0.0.1",
      },
    });
    const credentials = createCredentialUserBackendContribution({
      storage,
      keyring: keyring(),
      now: () => clock.now,
    });
    const owner = createCatalogConnectionOwnerV1(provider, {
      storage,
      settings,
      credentials: credentials as OllamaUserBackendHost["credentials"],
      now: () => clock.now,
      randomId: () => crypto.randomUUID(),
    });
    mockResponses([
      json({
        device_code: "DEVICE-CODE-SECRET",
        user_code: "PUBLIC-CODE",
        verification_uri: "https://auth.x.ai/activate",
        expires_in: 900,
        interval: 1,
      }),
      json({
        access_token: "ACCESS-TOKEN-SECRET",
        refresh_token: "REFRESH-TOKEN-SECRET",
        expires_in: 300,
      }),
    ]);

    const started = await owner.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/oauth",
      action: "start",
      commandId: "start-xai",
      packageId: "provider-xai",
      attemptId: "attempt-xai",
      label: "Primary",
    });
    expect(started.oauth?.browserKey).toBeDefined();
    clock.now = 1_001_000;
    const completed = await owner.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/oauth",
      action: "check",
      commandId: "check-xai",
      packageId: "provider-xai",
      attemptId: "attempt-xai",
      browserKey: started.oauth!.browserKey,
    });
    expect(completed.oauth?.status).toBe("ready");

    const connection = await settings.getConnection(
      "account-1",
      completed.connectionId,
    );
    expect(connection).toMatchObject({
      connectionTypeId: "xai-oauth",
      providerType: "xai",
      state: "ready",
    });
    const providerModelId = providerModelsV1("xai")[0]!.id;
    const lease = await owner.leaseModelCredential({
      accountId: "account-1",
      connectionId: completed.connectionId,
      providerModelId,
      effectId: "model-effect-1",
      connectionGeneration: connection!.generation!,
    });
    const storedSecret = await credentials.openLease({
      accountId: "account-1",
      packageId: "provider-xai",
      lease,
    });
    expect(decodeOAuthTokenV1(storedSecret)).toEqual({
      access: "ACCESS-TOKEN-SECRET",
      refresh: "REFRESH-TOKEN-SECRET",
      expires: 1_301_000,
    });
    expect(JSON.stringify([...storage.values])).not.toContain(
      "ACCESS-TOKEN-SECRET",
    );
  });

  test("fails closed when reconstructed after polling intent was recorded", async () => {
    const fixtureState = fixture("xai");
    const calls = mockResponses([
      json({
        device_code: "DEVICE-CODE-SECRET",
        user_code: "PUBLIC-CODE",
        verification_uri: "https://auth.x.ai/activate",
        expires_in: 900,
        interval: 1,
      }),
    ]);
    await fixtureState.manager.execute("account-1", startCommand("xai"));
    const key = "model-oauth:xai:attempt:attempt-1";
    const waiting = fixtureState.storage.values.get(key) as Record<
      string,
      unknown
    >;
    fixtureState.storage.values.set(key, { ...waiting, state: "polling" });

    const receipt = await fixtureState.reconstruct().execute("account-1", {
      ...startCommand("xai"),
      action: "check",
      commandId: "check-after-restart",
    });

    expect(receipt).toMatchObject({
      status: "failed",
      oauth: {
        attemptId: "attempt-1",
        status: "failed",
        message: "Sign-in could not finish. Start a new sign-in.",
      },
    });
    expect(calls).toHaveLength(1);
    expect(fixtureState.installed).toHaveLength(0);
    expect(fixtureState.storage.values.get(key)).toMatchObject({
      state: "failed",
      sealed: undefined,
      public: undefined,
    });
  });

  test("resumes a due waiting attempt from the alarm and installs one token", async () => {
    const fixtureState = fixture("xai");
    mockResponses([
      json({
        device_code: "DEVICE-CODE-SECRET",
        user_code: "PUBLIC-CODE",
        verification_uri: "https://auth.x.ai/activate",
        expires_in: 900,
        interval: 1,
      }),
      json({
        access_token: "ACCESS-TOKEN-SECRET",
        refresh_token: "REFRESH-TOKEN-SECRET",
        expires_in: 300,
      }),
    ]);
    await fixtureState.manager.execute("account-1", startCommand("xai"));
    fixtureState.clock.now = 1_001_000;

    await fixtureState.reconstruct().alarm();

    expect(fixtureState.installed).toHaveLength(1);
    const installed = fixtureState.installed[0]!;
    expect(installed).toMatchObject({
      accountId: "account-1",
      attemptId: "attempt-1",
      label: "Primary account",
    });
    expect(decodeOAuthTokenV1(installed.secret)).toEqual({
      access: "ACCESS-TOKEN-SECRET",
      refresh: "REFRESH-TOKEN-SECRET",
      expires: 1_301_000,
    });
    const durable = JSON.stringify([...fixtureState.storage.values]);
    expect(durable).not.toContain("ACCESS-TOKEN-SECRET");
    expect(durable).not.toContain("REFRESH-TOKEN-SECRET");
    expect(
      fixtureState.storage.values.get("model-oauth:xai:attempt:attempt-1"),
    ).toMatchObject({ state: "ready", connectionId: "connection-attempt-1" });
  });

  test("resumes an interrupted installing state from its alarm exactly once", async () => {
    const fixtureState = fixture("xai");
    mockResponses([
      json({
        device_code: "DEVICE-CODE-SECRET",
        user_code: "PUBLIC-CODE",
        verification_uri: "https://auth.x.ai/activate",
        expires_in: 900,
        interval: 1,
      }),
    ]);
    await fixtureState.manager.execute("account-1", startCommand("xai"));
    const key = "model-oauth:xai:attempt:attempt-1";
    const waiting = fixtureState.storage.values.get(key) as Record<
      string,
      unknown
    >;
    const sealed = await fixtureState.credentials.prepareApiKey({
      accountId: "account-1",
      connectionId: "attempt-1",
      packageId: "provider-xai",
      generation: "attempt-1",
      apiKey: JSON.stringify({
        access: "ACCESS-TOKEN-SECRET",
        refresh: "REFRESH-TOKEN-SECRET",
        expires: 1_300_000,
      }),
    });
    fixtureState.storage.values.set(key, {
      ...waiting,
      state: "installing",
      sealed,
      public: undefined,
    });
    fixtureState.clock.now = 1_060_000;

    const reconstructed = fixtureState.reconstruct();
    await reconstructed.alarm();
    await reconstructed.alarm();

    expect(fixtureState.installed).toHaveLength(1);
    expect(fixtureState.storage.values.get(key)).toMatchObject({
      state: "ready",
      connectionId: "connection-attempt-1",
      sealed: undefined,
    });
  });

  test("cancels an unfinished callback attempt without exchanging or installing", async () => {
    const fixtureState = fixture("openrouter");
    const calls = mockResponses([]);
    await fixtureState.manager.execute("account-1", startCommand("openrouter"));

    const receipt = await fixtureState.manager.execute("account-1", {
      ...startCommand("openrouter"),
      action: "cancel",
      commandId: "cancel-attempt-1",
    });

    expect(receipt).toMatchObject({
      status: "applied",
      oauth: { attemptId: "attempt-1", status: "cancelled" },
    });
    expect(calls).toHaveLength(0);
    expect(fixtureState.installed).toHaveLength(0);
    const stored = fixtureState.storage.values.get(
      "model-oauth:openrouter:attempt:attempt-1",
    ) as Record<string, unknown>;
    expect(stored.state).toBe("cancelled");
    expect(stored.sealed).toBeUndefined();
    expect(stored.public).toBeUndefined();
  });
});

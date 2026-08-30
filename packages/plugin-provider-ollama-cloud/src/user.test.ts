import { describe, expect, test } from "bun:test";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "@frockbot/plugin-credentials/user";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import { OllamaCloudClient, type OllamaFetch } from "./client.js";
import {
  createOllamaCloudUserBackendContribution,
  type OllamaUserBackendHost,
} from "./user.js";

class MemoryStorage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;
  failNextKey?: string;
  failNextEntriesContaining?: string;
  failNextGetKey?: string;
  armGetFailureAfterEntriesContaining?: string;

  get<T>(key: string): Promise<T | undefined> {
    if (this.failNextGetKey === key) {
      this.failNextGetKey = undefined;
      return Promise.reject(new Error("injected storage read failure"));
    }
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      if (this.failNextKey === keyOrEntries) {
        this.failNextKey = undefined;
        return Promise.reject(new Error("injected storage failure"));
      }
      this.values.set(keyOrEntries, value);
    } else {
      if (
        this.failNextEntriesContaining &&
        Object.hasOwn(keyOrEntries, this.failNextEntriesContaining)
      ) {
        this.failNextEntriesContaining = undefined;
        return Promise.reject(new Error("injected storage failure"));
      }
      for (const [key, entry] of Object.entries(keyOrEntries))
        this.values.set(key, entry);
      if (
        this.armGetFailureAfterEntriesContaining &&
        Object.hasOwn(keyOrEntries, this.armGetFailureAfterEntriesContaining)
      ) {
        this.armGetFailureAfterEntriesContaining = undefined;
        this.failNextGetKey = "user-configuration";
      }
    }
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
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
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

async function fixture(fetchOverride?: OllamaFetch) {
  const storage = new MemoryStorage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [
      { packageId: "provider-ollama-cloud", version: "0.0.1" },
    ],
  });
  await settings.executeConfiguration({
    schemaVersion: 1,
    userId: "account-1",
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-1",
      expectedRevision: 0,
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
    },
  });
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: keyring(),
    now: () => Date.parse("2026-08-30T00:00:00.000Z"),
  });
  let rejectCatalog = false;
  const client = new OllamaCloudClient({
    fetch:
      fetchOverride ??
      (async (input) => {
        if (rejectCatalog) return new Response("invalid", { status: 401 });
        const url = String(input);
        return url.endsWith("/tags")
          ? Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] })
          : Response.json({ capabilities: ["tools", "thinking"] });
      }),
  });
  let id = 0;
  const ollama = createOllamaCloudUserBackendContribution({
    storage,
    settings,
    credentials: credentials as unknown as OllamaUserBackendHost["credentials"],
    client,
    now: () => Date.parse("2026-08-30T00:00:00.000Z"),
    randomId: () => `id-${++id}`,
  });
  return {
    storage,
    settings,
    credentials,
    ollama,
    rejectCatalog: () => {
      rejectCatalog = true;
    },
  };
}

describe("Ollama Cloud User Contribution", () => {
  test("rejects malformed durable account, command, and pending records", async () => {
    const accountFixture = await fixture();
    accountFixture.storage.values.set("ollama-connection-account", {
      accountId: "account-1",
    });
    await expect(
      accountFixture.ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: "connect-malformed-account",
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        label: "Work",
        apiKey: "secret",
      }),
    ).rejects.toThrow("Stored Ollama account is invalid");

    const commandFixture = await fixture();
    const command = {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-malformed-command",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "secret",
    } as const;
    await commandFixture.ollama.executeConnection("account-1", command);
    const commandKey = `ollama-connection-command:${command.commandId}`;
    commandFixture.storage.values.set(commandKey, {
      ...(commandFixture.storage.values.get(commandKey) as Record<
        string,
        unknown
      >),
      unexpected: true,
    });
    await expect(
      commandFixture.ollama.executeConnection("account-1", command),
    ).rejects.toThrow("Stored Ollama command is invalid");

    const pendingFixture = await fixture();
    pendingFixture.storage.values.set("ollama-pending-connection-commands", [
      { commandId: "invalid" },
    ]);
    await expect(pendingFixture.ollama.alarm()).rejects.toThrow(
      "commandId is invalid",
    );
  });

  test("creates multiple account-scoped Connections with write-only credentials", async () => {
    const { storage, settings, ollama } = await fixture();

    const result = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "ollama-secret",
    });

    expect(result.status).toBe("applied");
    const connection = (await settings.read("account-1")).connections[0];
    expect(connection).toMatchObject({
      connectionId: result.connectionId,
      displayName: "Work",
      state: "ready",
      providerType: "ollama-cloud",
      authorization: { credential: { configured: true, writable: true } },
      modelCatalog: {
        state: "fresh",
        models: [{ providerModelId: "glm-5.3-flash:cloud" }],
      },
    });
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      "ollama-secret",
    );
  });

  test("atomically admits the command, Connection, and encrypted credential", async () => {
    const { storage, settings, ollama } = await fixture();
    storage.failNextEntriesContaining =
      "ollama-connection-command:connect-atomic";
    const command = {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-atomic",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Atomic",
      apiKey: "valid-key",
    } as const;

    await expect(
      ollama.executeConnection("account-1", command),
    ).rejects.toThrow("injected storage failure");
    expect((await settings.read("account-1")).connections).toEqual([]);

    await expect(
      ollama.executeConnection("account-1", command),
    ).resolves.toMatchObject({
      status: "applied",
    });
  });

  test("keeps the active generation when rotation validation fails", async () => {
    const { settings, ollama, rejectCatalog } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "valid-key",
    });
    const before = (await settings.read("account-1")).connections[0];
    rejectCatalog();

    const rotated = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-1",
      connectionId: created.connectionId,
      apiKey: "invalid-key",
    });

    expect(rotated.status).toBe("failed");
    expect((await settings.read("account-1")).connections[0]).toMatchObject({
      state: "ready",
      generation: before?.generation,
    });
  });

  test("atomically promotes credentials with their Connection generation", async () => {
    const { storage, settings, credentials, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "old-key",
    });
    const before = (await settings.read("account-1")).connections[0];
    if (!before?.generation) throw new Error("active generation is missing");
    storage.failNextKey = "user-configuration";

    const rotated = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-atomic",
      connectionId: created.connectionId,
      apiKey: "new-key",
    });
    const lease = await credentials.lease({
      accountId: "account-1",
      connectionId: created.connectionId,
      packageId: "provider-ollama-cloud",
      effectId: "effect-after-failure",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });

    expect(rotated.status).toBe("failed");
    expect(lease.credentialGeneration).toBe(before.generation);
    expect((await settings.read("account-1")).connections[0]?.generation).toBe(
      before.generation,
    );
  });

  test("replays successful activation when receipt finalization fails", async () => {
    let storage: MemoryStorage | undefined;
    const fixtureValue = await fixture(async (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (
        authorization === "Bearer new-key" &&
        String(input).endsWith("/tags")
      ) {
        storage!.failNextEntriesContaining =
          "ollama-connection-command:rotate-finalize";
      }
      return String(input).endsWith("/tags")
        ? Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] })
        : Response.json({ capabilities: ["tools"] });
    });
    storage = fixtureValue.storage;
    const { settings, ollama } = fixtureValue;
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "old-key",
    });
    const command = {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-finalize",
      connectionId: created.connectionId,
      apiKey: "new-key",
    } as const;

    await expect(
      ollama.executeConnection("account-1", command),
    ).rejects.toThrow("injected storage failure");
    const promoted = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    expect(promoted?.state).toBe("ready");
    await expect(
      ollama.executeConnection("account-1", command),
    ).resolves.toMatchObject({ status: "applied" });
  });

  test("preserves the first terminal receipt across concurrent delivery", async () => {
    const firstCatalogStarted = Promise.withResolvers<void>();
    const secondCatalogStarted = Promise.withResolvers<void>();
    const firstCatalogResponse = Promise.withResolvers<Response>();
    const secondCatalogResponse = Promise.withResolvers<Response>();
    let catalogRequests = 0;
    const { ollama } = await fixture((input) => {
      if (!String(input).endsWith("/tags")) {
        return Promise.resolve(Response.json({ capabilities: ["tools"] }));
      }
      catalogRequests += 1;
      if (catalogRequests === 1) {
        firstCatalogStarted.resolve();
        return firstCatalogResponse.promise;
      }
      secondCatalogStarted.resolve();
      return secondCatalogResponse.promise;
    });
    const command = {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-concurrent",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "secret",
    } as const;

    const first = ollama.executeConnection("account-1", command);
    await firstCatalogStarted.promise;
    const second = ollama.executeConnection("account-1", command);
    await secondCatalogStarted.promise;
    firstCatalogResponse.resolve(
      Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
    );
    const applied = await first;
    secondCatalogResponse.resolve(
      Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
    );

    expect(applied.status).toBe("applied");
    await expect(second).resolves.toEqual(applied);
  });

  test("preserves disabled state across credential rotation", async () => {
    const { settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "old-key",
    });
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "disable-1",
      connectionId: created.connectionId,
      enabled: false,
    });

    const rotated = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-disabled",
      connectionId: created.connectionId,
      apiKey: "new-key",
    });

    expect(rotated.status).toBe("applied");
    expect((await settings.read("account-1")).connections[0]?.state).toBe(
      "disabled",
    );
  });

  test("does not reactivate a Connection disconnected during authorization", async () => {
    const catalogStarted = Promise.withResolvers<void>();
    const catalogResponse = Promise.withResolvers<Response>();
    const { settings, ollama } = await fixture(async (input) => {
      if (String(input).endsWith("/tags")) {
        catalogStarted.resolve();
        return catalogResponse.promise;
      }
      return Response.json({ capabilities: ["tools"] });
    });
    const creating = ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-race",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Race",
      apiKey: "valid-key",
    });
    await catalogStarted.promise;

    const disconnected = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "disconnect-race",
      connectionId: "connection-id-1",
      revokeUpstream: false,
    });
    catalogResponse.resolve(
      Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
    );

    expect(disconnected.status).toBe("applied");
    expect((await creating).status).toBe("failed");
    expect(
      await settings.getConnection("account-1", "connection-id-1"),
    ).toMatchObject({ state: "revoked" });
  });

  test("fails an interrupted disconnect after credential rotation", async () => {
    const { storage, settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "old-key",
    });
    storage.armGetFailureAfterEntriesContaining =
      "ollama-connection-command:disconnect-stale";
    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "disconnect-stale",
        connectionId: created.connectionId,
        revokeUpstream: false,
      }),
    ).rejects.toThrow("injected storage read failure");

    const rotated = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-after-disconnect",
      connectionId: created.connectionId,
      apiKey: "new-key",
    });
    const afterRotation = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    if (!afterRotation?.generation) {
      throw new Error("rotated generation is missing");
    }
    await ollama.alarm();

    expect(rotated.status).toBe("applied");
    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({
      state: "ready",
      generation: afterRotation.generation,
    });
  });

  test("does not project a stale catalog across credential rotation", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const refreshResponse = Promise.withResolvers<Response>();
    let oldTagRequests = 0;
    const { settings, ollama } = await fixture(async (input, init) => {
      if (!String(input).endsWith("/tags")) {
        return Response.json({ capabilities: ["tools"] });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer old-key") {
        oldTagRequests += 1;
        if (oldTagRequests === 2) {
          refreshStarted.resolve();
          return refreshResponse.promise;
        }
        return Response.json({ models: [{ model: "old-model:cloud" }] });
      }
      return Response.json({ models: [{ model: "new-model:cloud" }] });
    });
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "old-key",
    });
    const refreshing = ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/refresh-models",
      commandId: "refresh-stale",
      connectionId: created.connectionId,
    });
    await refreshStarted.promise;
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-during-refresh",
      connectionId: created.connectionId,
      apiKey: "new-key",
    });
    refreshResponse.resolve(
      Response.json({ models: [{ model: "stale-model:cloud" }] }),
    );

    expect((await refreshing).status).toBe("failed");
    expect(
      (await settings.getConnection("account-1", created.connectionId))
        ?.modelCatalog?.models,
    ).toContainEqual(
      expect.objectContaining({ providerModelId: "new-model:cloud" }),
    );
  });

  test("terminally fails an admitted create whose credential was never sealed", async () => {
    const { storage, settings, ollama } = await fixture();
    storage.values.set("ollama-connection-account", "account-1");
    storage.values.set("ollama-pending-connection-commands", [
      "connect-crashed",
    ]);
    storage.values.set("ollama-connection-command:connect-crashed", {
      schemaVersion: 1,
      commandId: "connect-crashed",
      fingerprint: "admitted",
      accountId: "account-1",
      connectionId: "connection-crashed",
      credentialGeneration: "generation-crashed",
      operation: "connection/create-api-key",
      label: "Recovered",
    });

    await ollama.alarm();

    expect(
      await settings.getConnection("account-1", "connection-crashed"),
    ).toMatchObject({ state: "failed", displayName: "Recovered" });
    expect(storage.values.get("ollama-pending-connection-commands")).toEqual(
      [],
    );
  });

  test("rejects exact model authorization when Connection state changes", async () => {
    const resolutionStarted = Promise.withResolvers<void>();
    const resolutionResponse = Promise.withResolvers<Response>();
    const { settings, ollama } = await fixture(async (input, init) => {
      if (String(input).endsWith("/tags")) {
        return Response.json({
          models: [{ model: "glm-5.3-flash:cloud" }],
        });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === "new-model:cloud") {
        resolutionStarted.resolve();
        return resolutionResponse.promise;
      }
      return Response.json({ capabilities: ["tools"] });
    });
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "valid-key",
    });
    const connection = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    if (!connection?.generation) throw new Error("generation is missing");
    const authorization = ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "new-model:cloud",
      effectId: "effect-race",
      connectionGeneration: connection.generation,
    });
    await resolutionStarted.promise;
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "disable-race",
      connectionId: created.connectionId,
      enabled: false,
    });
    resolutionResponse.resolve(Response.json({ capabilities: ["tools"] }));

    await expect(authorization).rejects.toThrow(
      "Connection changed before model authorization",
    );
  });

  test("advances catalog generation after exact model resolution", async () => {
    const { settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "valid-key",
    });
    const before = await settings.getConnection(
      "account-1",
      created.connectionId,
    );

    if (!before?.generation) throw new Error("generation is missing");
    await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "new-model:cloud",
      effectId: "effect-resolution",
      connectionGeneration: before.generation,
    });
    const after = await settings.getConnection(
      "account-1",
      created.connectionId,
    );

    expect(after?.modelCatalog?.generation).not.toBe(
      before?.modelCatalog?.generation,
    );
    expect(after?.modelCatalog?.models).toContainEqual(
      expect.objectContaining({ providerModelId: "new-model:cloud" }),
    );
  });

  test("rejects a journaled credential generation after rotation", async () => {
    const { settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "old-key",
    });
    const before = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    if (!before?.generation) throw new Error("generation is missing");
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "rotate-before-lease",
      connectionId: created.connectionId,
      apiKey: "new-key",
    });

    await expect(
      ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: "glm-5.3-flash:cloud",
        effectId: "journaled-effect",
        connectionGeneration: before.generation,
      }),
    ).rejects.toThrow("Connection changed before model authorization");
  });

  test("blocks new leases after Package disable while preserving replay", async () => {
    let providerRequests = 0;
    const { settings, ollama } = await fixture((input) => {
      providerRequests += 1;
      return Promise.resolve(
        String(input).endsWith("/tags")
          ? Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] })
          : Response.json({ capabilities: ["tools"] }),
      );
    });
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "valid-key",
    });
    const connection = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    if (!connection?.generation) throw new Error("generation is missing");
    const first = await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "glm-5.3-flash:cloud",
      effectId: "effect-before-disable",
      connectionGeneration: connection.generation,
    });
    const current = await settings.read("account-1");
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "account-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "disable-package",
        expectedRevision: current.revision,
        packageId: "provider-ollama-cloud",
        enabled: false,
      },
    });
    const requestsBeforeAuthorization = providerRequests;

    await expect(
      ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: "glm-5.3-flash:cloud",
        effectId: "effect-before-disable",
        connectionGeneration: connection.generation,
      }),
    ).resolves.toEqual(first);
    await expect(
      ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: "glm-5.3-flash:cloud",
        effectId: "effect-after-disable",
        connectionGeneration: connection.generation,
      }),
    ).rejects.toThrow("Ollama Cloud Package is not installed and enabled");
    await expect(
      ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: "uncatalogued:cloud",
        effectId: "exact-after-disable",
        connectionGeneration: connection.generation,
      }),
    ).rejects.toThrow("Ollama Cloud Package is not installed and enabled");
    expect(providerRequests).toBe(requestsBeforeAuthorization);
  });

  test("pins one credential lease to the exact model effect", async () => {
    const { settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "valid-key",
    });

    const connection = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    if (!connection?.generation) throw new Error("generation is missing");
    const first = await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "glm-5.3-flash:cloud",
      effectId: "effect-1",
      connectionGeneration: connection.generation,
    });
    const replay = await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "glm-5.3-flash:cloud",
      effectId: "effect-1",
      connectionGeneration: connection.generation,
    });

    expect(replay).toEqual(first);
  });
});

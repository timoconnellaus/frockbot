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
  armEntriesFailureAfterKey?: {
    key: string;
    entry: string;
  };

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
      if (this.armEntriesFailureAfterKey?.key === keyOrEntries) {
        this.failNextEntriesContaining = this.armEntriesFailureAfterKey.entry;
        this.armEntriesFailureAfterKey = undefined;
      }
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

async function fixture(
  fetchOverride?: OllamaFetch,
  now: () => number = () => Date.parse("2026-08-30T00:00:00.000Z"),
) {
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
    now,
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
    now,
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
      safeMetadata: { creationCommandId: "connect-1" },
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

  test("projects durable Connection command receipts for hosted recovery", async () => {
    const { ollama } = await fixture();
    const receipt = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-receipt-lookup",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "valid-key",
    });

    await expect(
      ollama.lookupConnectionCommand("account-1", "connect-receipt-lookup"),
    ).resolves.toEqual(receipt);
    await expect(
      ollama.lookupConnectionCommand("account-1", "unknown-command"),
    ).resolves.toBeUndefined();
  });

  test("compacts command history without expiring idempotency", async () => {
    const { settings, storage, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-receipt-retention",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "valid-key",
    });
    for (let index = 0; index < 257; index += 1) {
      await ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: `label-retention-${index}`,
        connectionId: created.connectionId,
        label: `Label ${index}`,
      });
    }

    await expect(
      ollama.lookupConnectionCommand("account-1", "connect-receipt-retention"),
    ).resolves.toEqual(created);
    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: "connect-receipt-retention",
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        label: "Original",
        apiKey: "valid-key",
      }),
    ).resolves.toEqual(created);
    expect((await settings.read("account-1")).connections).toHaveLength(1);
    expect(
      storage.values.get("ollama-connection-command:connect-receipt-retention"),
    ).toEqual({
      schemaVersion: 1,
      commandId: "connect-receipt-retention",
      fingerprint: expect.any(String),
      accountId: "account-1",
      connectionId: created.connectionId,
      operation: "connection/create-api-key",
      receipt: created,
      completedAt: expect.any(Number),
    });
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith("ollama-connection-command:"),
      ),
    ).toHaveLength(258);
  });

  test("bounds pending command admission before durable recovery grows", async () => {
    const { storage, settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-pending-limit",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "valid-key",
    });
    storage.values.set(
      "ollama-pending-connection-commands",
      Array.from({ length: 64 }, (_, index) => `pending-${index}`),
    );

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: "label-over-capacity",
        connectionId: created.connectionId,
        label: "Changed",
      }),
    ).rejects.toThrow("Ollama Connection command capacity reached");
    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ displayName: "Original" });
    expect(
      storage.values.has("ollama-connection-command:label-over-capacity"),
    ).toBe(false);
  });

  test("recovers one pending command per alarm", async () => {
    const { storage, settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-pending-recovery",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "valid-key",
    });
    const connection = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    if (!connection?.generation) throw new Error("generation is missing");
    storage.values.set("ollama-pending-connection-commands", [
      "pending-label-1",
      "pending-label-2",
    ]);
    for (const [index, commandId] of [
      "pending-label-1",
      "pending-label-2",
    ].entries()) {
      storage.values.set(`ollama-connection-command:${commandId}`, {
        schemaVersion: 1,
        commandId,
        fingerprint: `fingerprint-${index}`,
        accountId: "account-1",
        connectionId: created.connectionId,
        expectedGeneration: connection.generation,
        operation: "connection/update-label",
        label: `Recovered ${index + 1}`,
      });
    }

    await ollama.alarm();
    await expect(
      ollama.lookupConnectionCommand("account-1", "pending-label-1"),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      ollama.lookupConnectionCommand("account-1", "pending-label-2"),
    ).resolves.toBeUndefined();
    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ displayName: "Recovered 1" });

    await ollama.alarm();
    await expect(
      ollama.lookupConnectionCommand("account-1", "pending-label-2"),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ displayName: "Recovered 2" });
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
      expectedGeneration: before.generation,
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

  test("single-flights concurrent delivery through one validation effect", async () => {
    const catalogStarted = Promise.withResolvers<void>();
    const catalogResponse = Promise.withResolvers<Response>();
    let catalogRequests = 0;
    const { ollama } = await fixture((input) => {
      if (!String(input).endsWith("/tags")) {
        return Promise.resolve(Response.json({ capabilities: ["tools"] }));
      }
      catalogRequests += 1;
      catalogStarted.resolve();
      return catalogResponse.promise;
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
    await catalogStarted.promise;
    const second = ollama.executeConnection("account-1", command);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(catalogRequests).toBe(1);
    catalogResponse.resolve(
      Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
    );
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

    expect(catalogRequests).toBe(1);
    expect(firstReceipt.status).toBe("applied");
    expect(secondReceipt).toEqual(firstReceipt);
  });

  test("does not let recovered mutations reverse newer commands", async () => {
    const { storage, settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-sequenced",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "key",
    });
    storage.failNextKey = "user-configuration";
    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: "label-older",
        connectionId: created.connectionId,
        label: "Older",
      }),
    ).rejects.toThrow("injected storage failure");

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: "label-newer",
        connectionId: created.connectionId,
        label: "Newer",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await ollama.alarm();

    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ displayName: "Newer" });
    expect(
      storage.values.get("ollama-connection-command:label-older"),
    ).toMatchObject({ receipt: { status: "failed" } });
  });

  test("recovers a committed sequenced mutation as applied", async () => {
    const { storage, settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-committed-label",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "key",
    });
    storage.armEntriesFailureAfterKey = {
      key: "user-configuration",
      entry: "ollama-connection-command:label-committed",
    };

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: "label-committed",
        connectionId: created.connectionId,
        label: "Committed",
      }),
    ).rejects.toThrow("injected storage failure");
    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ displayName: "Committed" });

    await ollama.alarm();

    expect(
      storage.values.get("ollama-connection-command:label-committed"),
    ).toMatchObject({ receipt: { status: "applied" } });
  });

  test("recovers independent mutations with per-field ordering", async () => {
    const { storage, settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-independent-sequences",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "key",
    });
    storage.failNextKey = "user-configuration";
    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/set-enabled",
        commandId: "disable-older",
        connectionId: created.connectionId,
        enabled: false,
      }),
    ).rejects.toThrow("injected storage failure");
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/update-label",
      commandId: "label-independent",
      connectionId: created.connectionId,
      label: "Renamed",
    });

    await ollama.alarm();

    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ displayName: "Renamed", state: "disabled" });
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

  test("rejects disconnect while a Bot assignment depends on the Connection", async () => {
    const { settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-dependent",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "key",
    });
    await settings.claimConnectionDependency(
      "account-1",
      created.connectionId,
      "bot-1",
      "assignment-1",
      {
        schemaVersion: 1,
        packageId: "provider-ollama-cloud",
        packageVersion: "0.0.1",
        capabilityId: "ollama-cloud-models",
        connectionTypeIds: ["ollama-cloud-account"],
      },
    );

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "disconnect-dependent",
        connectionId: created.connectionId,
        revokeUpstream: false,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(
      await settings.getConnection("account-1", created.connectionId),
    ).toMatchObject({ state: "ready" });
  });

  test("does not reactivate a Connection disconnected during authorization", async () => {
    const catalogStarted = Promise.withResolvers<void>();
    const catalogResponse = Promise.withResolvers<Response>();
    let catalogRequests = 0;
    const { settings, credentials, ollama } = await fixture(async (input) => {
      if (String(input).endsWith("/tags")) {
        catalogRequests += 1;
        if (catalogRequests === 1) {
          catalogStarted.resolve();
          return catalogResponse.promise;
        }
        return Response.json({
          models: [{ model: "glm-5.3-flash:cloud" }],
        });
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
    const replacement = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-replacement",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Replacement",
      apiKey: "replacement-key",
    });
    catalogResponse.resolve(
      Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
    );

    expect(disconnected.status).toBe("applied");
    expect(replacement.status).toBe("applied");
    expect((await creating).status).toBe("failed");
    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: "connect-race",
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        label: "Race",
        apiKey: "valid-key",
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect((await settings.read("account-1")).connections).toMatchObject([
      { connectionId: replacement.connectionId, state: "ready" },
    ]);
    await expect(
      credentials.readStagedApiKey({
        accountId: "account-1",
        connectionId: "connection-id-1",
        packageId: "provider-ollama-cloud",
        generation: "id-2",
      }),
    ).rejects.toThrow("Credential generation is unavailable");
  });

  test("cancels pending credential rotation before revocation", async () => {
    const rotationStarted = Promise.withResolvers<void>();
    const rotationResponse = Promise.withResolvers<Response>();
    let catalogRequests = 0;
    const { settings, credentials, ollama } = await fixture(async (input) => {
      if (String(input).endsWith("/tags")) {
        catalogRequests += 1;
        if (catalogRequests === 2) {
          rotationStarted.resolve();
          return rotationResponse.promise;
        }
        return Response.json({
          models: [{ model: "glm-5.3-flash:cloud" }],
        });
      }
      return Response.json({ capabilities: ["tools"] });
    });
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-before-pending-rotation",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Original",
      apiKey: "original-key",
    });
    const rotating = ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: "pending-rotation",
      connectionId: created.connectionId,
      apiKey: "pending-key",
    });
    await rotationStarted.promise;

    const disconnected = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "disconnect-pending-rotation",
      connectionId: created.connectionId,
      revokeUpstream: false,
    });
    rotationResponse.resolve(
      Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
    );

    expect(disconnected.status).toBe("applied");
    expect((await rotating).status).toBe("failed");
    const revoked = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    expect(revoked).toMatchObject({
      state: "revoked",
      authorization: {
        credential: { configured: false },
      },
    });
    expect(
      Object.hasOwn(revoked?.authorization?.credential ?? {}, "generation"),
    ).toBe(false);
    await expect(
      credentials.readStagedApiKey({
        accountId: "account-1",
        connectionId: created.connectionId,
        packageId: "provider-ollama-cloud",
        generation: "id-3",
      }),
    ).rejects.toThrow("Credential generation is unavailable");
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

  test("rejects catalog refresh before provider access without authority", async () => {
    let currentTime = Date.parse("2026-08-30T00:00:00.000Z");
    let providerRequests = 0;
    const { settings, ollama } = await fixture(
      (input) => {
        providerRequests += 1;
        return Promise.resolve(
          String(input).endsWith("/tags")
            ? Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] })
            : Response.json({ capabilities: ["tools"] }),
        );
      },
      () => currentTime,
    );
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-refresh-authority",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "key",
    });
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "disable-connection",
      connectionId: created.connectionId,
      enabled: false,
    });
    const beforeDisabledRefresh = providerRequests;

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "refresh-disabled-connection",
        connectionId: created.connectionId,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(providerRequests).toBe(beforeDisabledRefresh);

    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "enable-connection",
      connectionId: created.connectionId,
      enabled: true,
    });
    const current = await settings.read("account-1");
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "account-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "disable-package-before-refresh",
        expectedRevision: current.revision,
        packageId: "provider-ollama-cloud",
        enabled: false,
      },
    });
    const beforePackageRefresh = providerRequests;
    const refreshAfter = (
      await settings.getConnection("account-1", created.connectionId)
    )?.modelCatalog?.refreshAfter;
    if (!refreshAfter) throw new Error("refresh deadline is missing");
    currentTime = Date.parse(refreshAfter);
    await ollama.alarm();
    expect(providerRequests).toBe(beforePackageRefresh);

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "refresh-disabled-package",
        connectionId: created.connectionId,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(providerRequests).toBe(beforePackageRefresh);
  });

  test("retries catalog lease settlement without repeating the catalog read", async () => {
    let catalogRequests = 0;
    const { credentials, ollama } = await fixture(async (input) => {
      if (String(input).endsWith("/tags")) {
        catalogRequests += 1;
        return Response.json({
          models: [{ model: "glm-5.3-flash:cloud" }],
        });
      }
      return Response.json({ capabilities: ["tools"] });
    });
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-settlement-retry",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "key",
    });
    const beforeRefresh = catalogRequests;
    const settle = credentials.settle.bind(credentials);
    let settlementFailures = 1;
    credentials.settle = (input) => {
      if (settlementFailures > 0) {
        settlementFailures -= 1;
        return Promise.reject(new Error("settlement unavailable"));
      }
      return settle(input);
    };

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "refresh-settlement-retry",
        connectionId: created.connectionId,
      }),
    ).rejects.toThrow("settlement unavailable");
    expect(catalogRequests).toBe(beforeRefresh + 1);
    await expect(
      ollama.lookupConnectionCommand("account-1", "refresh-settlement-retry"),
    ).resolves.toBeUndefined();

    await ollama.alarm();

    expect(catalogRequests).toBe(beforeRefresh + 1);
    await expect(
      ollama.lookupConnectionCommand("account-1", "refresh-settlement-retry"),
    ).resolves.toMatchObject({ status: "applied" });
  });

  test("commits catalog outcomes atomically with settlement recovery", async () => {
    let storageRef: MemoryStorage | undefined;
    let failOutcomeCommit = false;
    let catalogRequests = 0;
    const fixtureValue = await fixture(async (input) => {
      if (String(input).endsWith("/tags")) {
        catalogRequests += 1;
        if (failOutcomeCommit) {
          storageRef!.failNextKey =
            "ollama-connection-command:refresh-atomic-outcome";
          failOutcomeCommit = false;
        }
        return Response.json({
          models: [{ model: `model-${catalogRequests}:cloud` }],
        });
      }
      return Response.json({ capabilities: ["tools"] });
    });
    const { storage, settings, ollama } = fixtureValue;
    storageRef = storage;
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-atomic-outcome",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "key",
    });
    const before = await settings.getConnection(
      "account-1",
      created.connectionId,
    );
    failOutcomeCommit = true;

    await expect(
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "refresh-atomic-outcome",
        connectionId: created.connectionId,
      }),
    ).rejects.toThrow("injected storage failure");

    expect(
      (await settings.getConnection("account-1", created.connectionId))
        ?.modelCatalog?.generation,
    ).toBe(before?.modelCatalog?.generation);
    await ollama.alarm();
    expect(catalogRequests).toBe(3);
    await expect(
      ollama.lookupConnectionCommand("account-1", "refresh-atomic-outcome"),
    ).resolves.toMatchObject({ status: "applied" });
  });

  test("compacts automatic refresh commands into one durable receipt", async () => {
    let currentTime = Date.parse("2026-08-30T00:00:00.000Z");
    const { storage, settings, ollama } = await fixture(
      undefined,
      () => currentTime,
    );
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-refresh-compaction",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Personal",
      apiKey: "key",
    });
    const firstDeadline = (
      await settings.getConnection("account-1", created.connectionId)
    )?.modelCatalog?.refreshAfter;
    if (!firstDeadline) throw new Error("refresh deadline is missing");
    currentTime = Date.parse(firstDeadline);

    await ollama.alarm();
    const receiptKey = `ollama-refresh-receipt:${created.connectionId}`;
    const firstReceipt = storage.values.get(receiptKey) as
      { commandId: string; status: string } | undefined;
    expect(firstReceipt?.status).toBe("applied");
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith("ollama-connection-command:refresh-"),
      ),
    ).toEqual([]);

    const secondDeadline = (
      await settings.getConnection("account-1", created.connectionId)
    )?.modelCatalog?.refreshAfter;
    if (!secondDeadline) throw new Error("refresh deadline is missing");
    currentTime = Date.parse(secondDeadline);
    await ollama.alarm();
    const secondReceipt = storage.values.get(receiptKey) as
      { commandId: string; status: string } | undefined;

    expect(secondReceipt?.status).toBe("applied");
    expect(secondReceipt?.commandId).not.toBe(firstReceipt?.commandId);
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith("ollama-refresh-receipt:"),
      ),
    ).toEqual([receiptKey]);
  });

  test("refreshes one due Connection per recovery alarm", async () => {
    let currentTime = Date.parse("2026-08-30T00:00:00.000Z");
    let catalogRequests = 0;
    const { settings, ollama } = await fixture(
      async (input) => {
        if (String(input).endsWith("/tags")) {
          catalogRequests += 1;
          return Response.json({
            models: [{ model: "glm-5.3-flash:cloud" }],
          });
        }
        return Response.json({ capabilities: ["tools"] });
      },
      () => currentTime,
    );
    for (const suffix of ["one", "two"]) {
      await ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: `connect-alarm-${suffix}`,
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        label: suffix,
        apiKey: `${suffix}-key`,
      });
    }
    const refreshAfter = (await settings.read("account-1")).connections[0]
      ?.modelCatalog?.refreshAfter;
    if (!refreshAfter) throw new Error("refresh deadline is missing");
    currentTime = Date.parse(refreshAfter);

    await ollama.alarm();
    expect(catalogRequests).toBe(3);
    await ollama.alarm();
    expect(catalogRequests).toBe(4);
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

  test("settles a failed exact-resolution lease from model outcome recovery", async () => {
    const { settings, credentials, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-resolution-settlement",
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
    const settle = credentials.settle.bind(credentials);
    let failResolutionSettlement = true;
    credentials.settle = (input) => {
      if (
        failResolutionSettlement &&
        input.effectId === "resolve:resolution-outcome"
      ) {
        failResolutionSettlement = false;
        return Promise.reject(new Error("settlement unavailable"));
      }
      return settle(input);
    };

    await expect(
      ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: "uncatalogued:cloud",
        effectId: "resolution-outcome",
        connectionGeneration: connection.generation,
      }),
    ).rejects.toThrow("settlement unavailable");
    await expect(
      credentials.replayLease({
        accountId: "account-1",
        connectionId: created.connectionId,
        packageId: "provider-ollama-cloud",
        effectId: "resolve:resolution-outcome",
      }),
    ).resolves.toBeDefined();

    await ollama.settleModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      effectId: "resolution-outcome",
    });

    await expect(
      credentials.replayLease({
        accountId: "account-1",
        connectionId: created.connectionId,
        packageId: "provider-ollama-cloud",
        effectId: "resolve:resolution-outcome",
      }),
    ).resolves.toBeUndefined();
  });

  test("bounds retained exact models while preserving discovered models", async () => {
    const { settings, ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-model-retention",
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

    for (let index = 0; index < 105; index += 1) {
      const effectId = `exact-retention-${index}`;
      await ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: `exact-${index}:cloud`,
        effectId,
        connectionGeneration: connection.generation,
      });
      await ollama.settleModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        effectId,
      });
    }
    const models = (
      await settings.getConnection("account-1", created.connectionId)
    )?.modelCatalog?.models;

    expect(models).toHaveLength(100);
    expect(models).toContainEqual(
      expect.objectContaining({ providerModelId: "glm-5.3-flash:cloud" }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({ providerModelId: "exact-104:cloud" }),
    );
    expect(models).not.toContainEqual(
      expect.objectContaining({ providerModelId: "exact-0:cloud" }),
    );
  });

  test("reserves exact-model capacity in a full discovered catalog", async () => {
    let showRequests = 0;
    const { settings, ollama } = await fixture((input) => {
      if (String(input).endsWith("/tags")) {
        return Promise.resolve(
          Response.json({
            models: Array.from({ length: 100 }, (_, index) => ({
              model: `discovered-${index}:cloud`,
            })),
          }),
        );
      }
      showRequests += 1;
      return Promise.resolve(Response.json({ capabilities: ["tools"] }));
    });
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-full-catalog",
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
    const baselineShowRequests = showRequests;

    for (const effectId of ["full-exact-1", "full-exact-2"]) {
      await ollama.leaseModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        providerModelId: "uncatalogued:cloud",
        effectId,
        connectionGeneration: connection.generation,
      });
      await ollama.settleModelCredential({
        accountId: "account-1",
        connectionId: created.connectionId,
        effectId,
      });
    }
    const models = (
      await settings.getConnection("account-1", created.connectionId)
    )?.modelCatalog?.models;

    expect(showRequests - baselineShowRequests).toBe(1);
    expect(models).toHaveLength(91);
    expect(models).toContainEqual(
      expect.objectContaining({ providerModelId: "uncatalogued:cloud" }),
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
      ollama.executeConnection("account-1", {
        schemaVersion: 1,
        type: "connection/rotate-api-key",
        commandId: "rotate-disabled-package",
        connectionId: created.connectionId,
        apiKey: "replacement-key",
      }),
    ).rejects.toThrow("Connection changed before credential rotation");
    expect(
      (await settings.getConnection("account-1", created.connectionId))
        ?.generation,
    ).toBe(connection.generation);
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

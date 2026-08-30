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
import { OllamaCloudClient } from "./client.js";
import { createOllamaCloudUserBackendContribution } from "./user.js";

class MemoryStorage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;
  failNextKey?: string;
  failNextEntriesContaining?: string;

  get<T>(key: string): Promise<T | undefined> {
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

async function fixture() {
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
    fetch: async (input) => {
      if (rejectCatalog) return new Response("invalid", { status: 401 });
      const url = String(input);
      return url.endsWith("/tags")
        ? Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] })
        : Response.json({ capabilities: ["tools", "thinking"] });
    },
  });
  let id = 0;
  const ollama = createOllamaCloudUserBackendContribution({
    storage,
    settings,
    credentials,
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

  test("pins one credential lease to the exact model effect", async () => {
    const { ollama } = await fixture();
    const created = await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "valid-key",
    });

    const first = await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "glm-5.3-flash:cloud",
      effectId: "effect-1",
    });
    const replay = await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: created.connectionId,
      providerModelId: "glm-5.3-flash:cloud",
      effectId: "effect-1",
    });

    expect(replay).toEqual(first);
  });
});

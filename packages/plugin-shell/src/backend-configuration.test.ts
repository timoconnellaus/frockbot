import { describe, expect, test } from "bun:test";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import { createShellBotBackendContribution } from "./backend.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ) as Array<[string, T]>,
      ),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

function configuredUser(
  state: "ready" | "disabled" = "ready",
): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    profile: { name: "User" },
    packages: [
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        state: "installed",
      },
    ],
    connections: [
      {
        connectionId: "ollama-work",
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        displayName: "Work",
        state,
        generation: "connection-generation-1",
        providerType: "ollama-cloud",
        modelCatalog: {
          schemaVersion: 1,
          generation: "catalog-1",
          state: "fresh",
          models: [
            {
              providerModelId: "glm-5.3-flash:cloud",
              displayName: "GLM 5.3 Flash",
              capabilities: {
                tools: true,
                vision: false,
                reasoning: true,
              },
              source: "discovered",
            },
          ],
        },
        safeMetadata: {},
      },
    ],
  };
}

function subject(user: () => UserSettingsViewV1) {
  const storage = new MemoryStorage();
  const contribution = createShellBotBackendContribution({
    state: { storage } as unknown as DurableObjectState,
    env: {
      USER_CONFIGURATIONS: {
        idFromName: () => "user-1",
        get: () => ({
          readConfiguration: () => Promise.resolve(user()),
        }),
      },
    } as never,
    compileApplication: compileFoundationApplication,
  });
  return { storage, contribution };
}

describe("Bot settings authority", () => {
  test("rejects an unmaterialized Bot without writing durable state", async () => {
    const { storage, contribution } = subject(() => configuredUser());
    await expect(
      contribution.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "unknown",
      }),
    ).rejects.toThrow("not materialized");
    expect(storage.values.size).toBe(0);
  });

  test("materializes settings without Capability Assignment state", async () => {
    const { contribution } = subject(() => configuredUser());
    const settings = await contribution.materializeSettings(
      { userId: "user-1", botId: "primary" },
      { name: "Primary" },
    );
    expect(settings).toEqual({
      schemaVersion: 1,
      botId: "primary",
      revision: 0,
      profile: { name: "Primary" },
      notifications: { enabled: true },
      model: undefined,
    });
  });

  test("selects and unbinds a model as a plain Bot setting", async () => {
    const { contribution } = subject(() => configuredUser());
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });

    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        command: {
          schemaVersion: 1,
          type: "bot/select-model",
          commandId: "select-model",
          expectedRevision: 0,
          botId: identity.botId,
          model: {
            connectionId: "ollama-work",
            providerModelId: "glm-5.3-flash:cloud",
          },
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 1,
      model: {
        connectionId: "ollama-work",
        providerModelId: "glm-5.3-flash:cloud",
      },
    });

    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        command: {
          schemaVersion: 1,
          type: "bot/unbind-model",
          commandId: "unbind-model",
          expectedRevision: 1,
          botId: identity.botId,
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 2 });
    expect((await contribution.getSettings(identity)).model).toBeUndefined();
  });

  test("returns a declared rejection when the selected Connection is unavailable", async () => {
    const { contribution } = subject(() => configuredUser("disabled"));
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });
    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        command: {
          schemaVersion: 1,
          type: "bot/select-model",
          commandId: "select-model",
          expectedRevision: 0,
          botId: identity.botId,
          model: {
            connectionId: "ollama-work",
            providerModelId: "glm-5.3-flash:cloud",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      revision: 0,
      failure: "Connection is disabled",
    });
  });
});

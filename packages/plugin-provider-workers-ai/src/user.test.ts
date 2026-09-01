import { describe, expect, test } from "bun:test";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import {
  WORKERS_AI_CONNECTION_ID,
  WORKERS_AI_DEFAULT_MODEL,
  WORKERS_AI_PACKAGE_ID,
} from "./catalog.js";
import { createWorkersAiUserBackendContribution } from "./user.js";

class MemoryStorage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();

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
      this.values.set(keyOrEntries, value);
    } else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, entry);
      }
    }
    return Promise.resolve();
  }

  async transaction<T>(
    callback: (storage: UserSettingsTransaction) => Promise<T>,
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
}

function fixture() {
  const storage = new MemoryStorage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [{ packageId: WORKERS_AI_PACKAGE_ID, version: "0.0.1" }],
  });
  const workersAi = createWorkersAiUserBackendContribution({
    storage,
    settings,
  });
  settings.registerConfigurationReadBootstrap(workersAi);
  return { storage, settings, workersAi };
}

describe("Workers AI User Contribution", () => {
  test("ambiently installs, connects, and selects the default exactly once", async () => {
    const { settings } = fixture();
    const first = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "account-1",
    });

    expect(first).toMatchObject({
      revision: 3,
      packages: [{ packageId: WORKERS_AI_PACKAGE_ID, state: "installed" }],
      connections: [
        {
          connectionId: WORKERS_AI_CONNECTION_ID,
          state: "ready",
          providerType: "workers-ai",
          authorization: {
            kind: "ambient-native",
            credential: { configured: true, writable: false },
          },
          modelCatalog: {
            state: "fresh",
            models: [
              {
                providerModelId: WORKERS_AI_DEFAULT_MODEL,
                displayName: "DeepSeek V4 Flash",
              },
            ],
          },
        },
      ],
      newBotModelTemplate: {
        connectionId: WORKERS_AI_CONNECTION_ID,
        providerModelId: WORKERS_AI_DEFAULT_MODEL,
      },
      newBotModelTemplateSource: "auto",
    });

    const second = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "account-1",
    });
    expect(second).toEqual(first);
  });

  test("does not replace a User-chosen default", async () => {
    const { settings } = fixture();
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "account-1",
      command: {
        schemaVersion: 1,
        type: "user/set-new-bot-model",
        commandId: "user-choice",
        expectedRevision: 0,
        model: {
          connectionId: "chosen-connection",
          providerModelId: "chosen-model",
        },
        source: "user",
      },
    });

    const view = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "account-1",
    });
    expect(view.newBotModelTemplate).toEqual({
      connectionId: "chosen-connection",
      providerModelId: "chosen-model",
    });
    expect(view.newBotModelTemplateSource).toBe("user");
  });

  test("does not replace a User's explicit choice to have no default", async () => {
    const { settings } = fixture();
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "account-1",
      command: {
        schemaVersion: 1,
        type: "user/set-new-bot-model",
        commandId: "user-choice-none",
        expectedRevision: 0,
        source: "user",
      },
    });

    const view = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "account-1",
    });
    expect(view.newBotModelTemplate).toBeUndefined();
    expect(view.newBotModelTemplateSource).toBe("user");
  });

  test("fails closed on a corrupt Package-owned bootstrap marker", async () => {
    const { storage, settings } = fixture();
    storage.values.set("provider-workers-ai:bootstrap-v1", {
      schemaVersion: 1,
      userId: "account-1",
      unexpected: true,
    });
    await expect(
      settings.readConfiguration({ schemaVersion: 1, userId: "account-1" }),
    ).rejects.toThrow("Stored Workers AI bootstrap marker is invalid");
  });
});

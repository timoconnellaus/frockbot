import { describe, expect, test } from "bun:test";
import type {
  ConnectionView,
  UserConfigurationCommandV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  FLOCK_AI_CONNECTION_ID,
  FLOCK_AI_DEFAULT_MODEL,
  FLOCK_AI_PACKAGE_ID,
} from "./catalog.js";
import { createFlockAiUserBackendContribution } from "./user.js";

interface TestTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

class MemoryStorage implements TestTransaction {
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
    callback: (storage: TestTransaction) => Promise<T>,
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

class FakeSettings {
  readonly commands: UserConfigurationCommandV1[] = [];
  private bootstrap:
    | { readonly packageId: string; bootstrap(userId: string): Promise<void> }
    | undefined;
  private state: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "User" },
    packages: [],
    connections: [],
  };

  registerConfigurationReadBootstrap(bootstrap: {
    readonly packageId: string;
    bootstrap(userId: string): Promise<void>;
  }): () => void {
    this.bootstrap = bootstrap;
    return () => {
      if (this.bootstrap === bootstrap) this.bootstrap = undefined;
    };
  }

  async readConfiguration(userId: string): Promise<UserSettingsViewV1> {
    await this.bootstrap?.bootstrap(userId);
    return structuredClone(this.state);
  }

  read(): Promise<UserSettingsViewV1> {
    return Promise.resolve(structuredClone(this.state));
  }

  executeConfigurationCommand(
    _userId: string,
    command: UserConfigurationCommandV1,
  ): Promise<unknown> {
    if (command.expectedRevision !== this.state.revision) {
      throw new Error("settings revision changed");
    }
    this.commands.push(structuredClone(command));
    if (command.type === "user/install-package") {
      if (
        !this.state.packages.some(
          (installation) => installation.packageId === command.packageId,
        )
      ) {
        this.state.packages.push({
          packageId: command.packageId,
          version: command.version,
          state: command.enabled === false ? "disabled" : "installed",
        });
        this.state.revision += 1;
      }
      return Promise.resolve(undefined);
    }
    if (command.type === "user/set-platform-model") {
      this.state.platformModel = structuredClone(command.model);
      this.state.revision += 1;
      return Promise.resolve(undefined);
    }
    throw new Error(`unexpected command ${command.type}`);
  }

  createConnection(
    _userId: string,
    connection: ConnectionView,
  ): Promise<ConnectionView> {
    const existing = this.state.connections.find(
      (candidate) => candidate.connectionId === connection.connectionId,
    );
    if (existing) return Promise.resolve(structuredClone(existing));
    this.state.connections.push(structuredClone(connection));
    this.state.revision += 1;
    return Promise.resolve(structuredClone(connection));
  }

  replaceConnection(
    _userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    connection: ConnectionView,
  ): Promise<ConnectionView> {
    const index = this.state.connections.findIndex(
      (candidate) => candidate.connectionId === connectionId,
    );
    if (
      index < 0 ||
      this.state.connections[index]?.generation !== expectedGeneration
    ) {
      throw new Error("Connection generation changed");
    }
    this.state.connections[index] = structuredClone(connection);
    this.state.revision += 1;
    return Promise.resolve(structuredClone(connection));
  }

  getConnection(
    _userId: string,
    connectionId: string,
  ): Promise<ConnectionView | undefined> {
    const connection = this.state.connections.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    return Promise.resolve(
      connection ? structuredClone(connection) : undefined,
    );
  }

  setPlatformModel(connectionId: string, providerModelId: string): void {
    this.state.platformModel = { connectionId, providerModelId };
    this.state.revision += 1;
  }

  seedFlockAiPackageValues(): void {
    this.state.packages.push({
      packageId: FLOCK_AI_PACKAGE_ID,
      version: "0.0.1",
      state: "installed",
      values: { userChoice: "keep-me" },
    });
  }
}

function fixture() {
  const storage = new MemoryStorage();
  const settings = new FakeSettings();
  const flockAi = createFlockAiUserBackendContribution({ storage, settings });
  settings.registerConfigurationReadBootstrap(flockAi);
  return { storage, settings };
}

describe("Flock AI User Contribution", () => {
  test("ambiently installs, connects, and sets Auto as the platform model exactly once", async () => {
    const { settings } = fixture();
    const first = await settings.readConfiguration("user-1");

    expect(first).toMatchObject({
      revision: 3,
      packages: [{ packageId: FLOCK_AI_PACKAGE_ID, state: "installed" }],
      connections: [
        {
          connectionId: FLOCK_AI_CONNECTION_ID,
          state: "ready",
          providerType: "flock-ai",
          authorization: {
            kind: "ambient-native",
            credential: { configured: true, writable: false },
          },
          modelCatalog: {
            state: "fresh",
            models: [
              {
                providerModelId: FLOCK_AI_DEFAULT_MODEL,
                displayName: "Auto (recommended)",
              },
              {
                providerModelId: "@flock/deepseek-ai/deepseek-v4-flash-0731",
                displayName: "DeepSeek V4 Flash",
              },
            ],
          },
        },
      ],
      platformModel: {
        connectionId: FLOCK_AI_CONNECTION_ID,
        providerModelId: FLOCK_AI_DEFAULT_MODEL,
      },
    });
    expect(
      settings.commands.filter(
        (command) => command.type === "user/set-platform-model",
      ),
    ).toHaveLength(1);

    const second = await settings.readConfiguration("user-1");
    expect(second).toEqual(first);
    expect(
      settings.commands.filter(
        (command) => command.type === "user/set-platform-model",
      ),
    ).toHaveLength(1);
  });

  test("does not overwrite the platform model on later reads", async () => {
    const { settings } = fixture();
    await settings.readConfiguration("user-1");
    settings.setPlatformModel("another-connection", "another-model");

    const second = await settings.readConfiguration("user-1");
    expect(second.platformModel).toEqual({
      connectionId: "another-connection",
      providerModelId: "another-model",
    });
    expect(
      settings.commands.filter(
        (command) => command.type === "user/set-platform-model",
      ),
    ).toHaveLength(1);
  });

  test("does not touch Package settings already written by the User", async () => {
    const { settings } = fixture();
    settings.seedFlockAiPackageValues();

    const view = await settings.readConfiguration("user-1");
    expect(view.packages).toContainEqual(
      expect.objectContaining({
        packageId: FLOCK_AI_PACKAGE_ID,
        values: { userChoice: "keep-me" },
      }),
    );
    expect(
      settings.commands.filter(
        (command) => command.type === "user/install-package",
      ),
    ).toHaveLength(0);
  });

  test("fails closed on a corrupt Package-owned bootstrap marker", async () => {
    const { storage, settings } = fixture();
    storage.values.set("provider-flock-ai:bootstrap-v1", {
      schemaVersion: 1,
      userId: "user-1",
      unexpected: true,
    });
    await expect(settings.readConfiguration("user-1")).rejects.toThrow(
      "Stored Flock AI bootstrap marker is invalid",
    );
  });
});

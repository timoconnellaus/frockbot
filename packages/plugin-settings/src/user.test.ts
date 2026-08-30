import { describe, expect, test } from "bun:test";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
} from "./user.js";

class MemoryStorage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function contribution(storage = new MemoryStorage()) {
  return createUserSettingsBackendContribution({
    storage,
    availablePackages: [
      { packageId: "flock", version: "0.0.1" },
      { packageId: "settings", version: "0.0.1" },
      { packageId: "provider-ollama-cloud", version: "0.0.1" },
    ],
  });
}

describe("User settings backend Contribution", () => {
  test("owns durable User configuration independently of providers", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);

    expect(
      await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" }),
    ).toEqual({
      schemaVersion: 1,
      revision: 0,
      profile: { name: "FrockBot user" },
      packages: [],
      connections: [],
    });

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "rename-user",
        expectedRevision: 0,
        profile: { name: "Tim" },
      },
    });

    expect(
      await storage.get<UserSettingsViewV1>("user-configuration"),
    ).toMatchObject({ revision: 1, profile: { name: "Tim" } });
  });

  test("admits only Packages declared by the immutable application", async () => {
    const settings = contribution();
    const install = {
      schemaVersion: 1 as const,
      userId: "user-1",
      command: {
        schemaVersion: 1 as const,
        type: "user/install-package" as const,
        commandId: "install-flock",
        expectedRevision: 0,
        packageId: "flock",
        version: "0.0.1",
      },
    };

    await expect(settings.executeConfiguration(install)).resolves.toMatchObject(
      {
        status: "applied",
        revision: 1,
      },
    );
    await expect(settings.executeConfiguration(install)).resolves.toMatchObject(
      {
        status: "applied",
        revision: 1,
      },
    );
    expect(await settings.isPackageInstalled("user-1", "flock")).toBe(true);

    await expect(
      settings.executeConfiguration({
        ...install,
        command: {
          ...install.command,
          commandId: "install-composio",
          expectedRevision: 1,
          packageId: "composio",
        },
      }),
    ).rejects.toThrow("Package is not available in this application");
  });

  test("coordinates Connection dependencies in provider-neutral User state", async () => {
    const settings = contribution();
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-ollama",
        expectedRevision: 0,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });
    await settings.createConnection("user-1", {
      connectionId: "ollama-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      state: "ready",
      providerType: "ollama-cloud",
      generation: "connection-generation",
      safeMetadata: {},
    });
    const requirement = {
      schemaVersion: 1 as const,
      packageId: "provider-ollama-cloud",
      packageVersion: "0.0.1",
      capabilityId: "ollama-cloud-models",
      connectionTypeIds: ["ollama-cloud-account"],
    };

    await expect(
      settings.claimConnectionDependency(
        "user-1",
        "ollama-1",
        "bot-1",
        "assignment-1",
        requirement,
      ),
    ).resolves.toBe(true);
    await expect(
      settings.acknowledgeConnectionDependency(
        "user-1",
        "ollama-1",
        "bot-1",
        "assignment-1",
      ),
    ).resolves.toBe(true);
    expect(
      (await settings.getConnection("user-1", "ollama-1"))?.safeMetadata,
    ).toMatchObject({
      dependentAssignments: [
        {
          botId: "bot-1",
          generation: "assignment-1",
          status: "acknowledged",
        },
      ],
    });
    await expect(
      settings.compensateConnectionDependency(
        "user-1",
        "ollama-1",
        "bot-1",
        "assignment-1",
      ),
    ).resolves.toBe(false);
  });

  test("compacts revoked Connections and bounds active Connections", async () => {
    const settings = contribution();
    await settings.read("user-1");
    const connection = (connectionId: string, state: "ready" | "revoked") =>
      ({
        connectionId,
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        displayName: connectionId,
        state,
        providerType: "ollama-cloud",
        generation: `generation-${connectionId}`,
        safeMetadata: {},
      }) as const;
    await settings.createConnection(
      "user-1",
      connection("revoked-1", "revoked"),
    );
    await settings.createConnection("user-1", connection("ready-0", "ready"));
    expect((await settings.read("user-1")).connections).toHaveLength(1);

    for (let index = 1; index < 100; index += 1) {
      await settings.createConnection(
        "user-1",
        connection(`ready-${index}`, "ready"),
      );
    }
    await expect(
      settings.createConnection(
        "user-1",
        connection("ready-over-limit", "ready"),
      ),
    ).rejects.toThrow("User Connection limit reached");
  });

  test("binds one durable state object to one User authority", async () => {
    const settings = contribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.readConfiguration({ schemaVersion: 1, userId: "user-2" }),
    ).rejects.toThrow("User authority does not match durable identity");
  });

  test("rejects corrupt durable settings and receipts at the storage seam", async () => {
    const corruptSettings = new MemoryStorage();
    await corruptSettings.put("user-configuration", { schemaVersion: 1 });
    await expect(
      contribution(corruptSettings).readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
      }),
    ).rejects.toThrow();

    const corruptReceipt = new MemoryStorage();
    await corruptReceipt.put("configuration-receipt:rename-user", {
      commandFingerprint: "invalid",
      receipt: { status: "applied" },
    });
    await expect(
      contribution(corruptReceipt).executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "rename-user",
          expectedRevision: 0,
          profile: { name: "Tim" },
        },
      }),
    ).rejects.toThrow();
  });
});

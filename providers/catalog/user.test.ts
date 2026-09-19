import { expect, test } from "bun:test";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "@frockbot/app/credentials/user";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import {
  modelConnectionLifecycleV1,
  type ModelConnectionUserBackendHostV1,
} from "../model-connections/user.js";
import { catalogProvidersV1 } from "./definition.js";
import { createCatalogConnectionOwnerV1 } from "./user.js";

class Storage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
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
    const before = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }
  async setAlarm() {}
}

test("provider connections isolate command receipts, credentials, and disabled authority", async () => {
  const storage = new Storage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: ["deepseek", "google"].map((id) => ({
      packageId: `provider-${id}`,
      version: "0.0.1",
    })),
  });
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: JSON.stringify({
      schemaVersion: 1,
      currentKeyId: "primary",
      keys: {
        primary: btoa("x".repeat(32))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
      },
    }),
  });
  const owners = [];
  for (const [index, id] of ["deepseek", "google"].entries()) {
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: `install-${id}`,
        expectedRevision: (await settings.read("user-1")).revision,
        packageId: `provider-${id}`,
        version: "0.0.1",
      },
    });
    const Contribution = modelConnectionLifecycleV1({
      packageId: `provider-${id}`,
      displayName: id,
      connectionTypeId: `${id}-account`,
      providerType: id,
      storagePrefix: `catalog-${id}`,
      createClient: () => {
        throw new Error("the test host client should win");
      },
    });
    const model = {
      providerModelId: "model",
      displayName: "Model",
      capabilities: { tools: true, vision: false, reasoning: false },
      source: "discovered" as const,
    };
    const owner = new Contribution({
      storage,
      settings,
      credentials:
        credentials as ModelConnectionUserBackendHostV1["credentials"],
      client: {
        async listModels() {
          return [model];
        },
        async resolveModel() {
          return model;
        },
        async probeInference() {},
      },
    });
    owners.push(owner);
    const command = {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "same-command-id",
      packageId: `provider-${id}`,
      connectionTypeId: `${id}-account`,
      label: id,
      apiKey: `${id}-secret`,
    };
    const receipt = await owner.executeConnection("user-1", command);
    expect(receipt.status).toBe("applied");
    expect(await owner.executeConnection("user-1", command)).toEqual(receipt);
  }
  const first = await owners[0]!.lookupConnectionCommand(
    "user-1",
    "same-command-id",
  );
  const second = await owners[1]!.lookupConnectionCommand(
    "user-1",
    "same-command-id",
  );
  expect(first?.connectionId).not.toBe(second?.connectionId);
  const connection = await settings.getConnection(
    "user-1",
    first!.connectionId!,
  );
  expect(connection?.providerType).toBe("deepseek");
  await expect(
    owners[1]!.leaseModelCredential({
      accountId: "user-1",
      connectionId: first!.connectionId!,
      providerModelId: "model",
      effectId: "wrong-provider",
      connectionGeneration: connection!.generation!,
    }),
  ).rejects.toThrow();
  await owners[0]!.executeConnection("user-1", {
    schemaVersion: 1,
    type: "connection/set-enabled",
    commandId: "disable",
    connectionId: first!.connectionId!,
    enabled: false,
  });
  await expect(
    owners[0]!.leaseModelCredential({
      accountId: "user-1",
      connectionId: first!.connectionId!,
      providerModelId: "model",
      effectId: "disabled",
      connectionGeneration: connection!.generation!,
    }),
  ).rejects.toThrow();
  expect(JSON.stringify([...storage.values])).not.toContain("deepseek-secret");
  expect(JSON.stringify([...storage.values])).not.toContain("google-secret");
});

test("a catalog provider owns its endpoint language and client selection", async () => {
  const provider = catalogProvidersV1.find(({ id }) => id === "deepseek")!;
  const storage = new Storage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [{ packageId: "provider-deepseek", version: "0.0.1" }],
  });
  await settings.executeConfiguration({
    schemaVersion: 1,
    userId: "user-1",
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-deepseek",
      expectedRevision: 0,
      packageId: "provider-deepseek",
      version: "0.0.1",
    },
  });
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: JSON.stringify({
      schemaVersion: 1,
      currentKeyId: "primary",
      keys: {
        primary: btoa("y".repeat(32))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
      },
    }),
  });
  const endpoints: Array<string | undefined> = [];
  const model = {
    providerModelId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    capabilities: { tools: true, vision: false, reasoning: false },
    source: "discovered" as const,
  };
  let id = 0;
  const owner = createCatalogConnectionOwnerV1(provider, {
    storage,
    settings,
    credentials: credentials as ModelConnectionUserBackendHostV1["credentials"],
    createClient: ({ apiBaseUrl }) => {
      endpoints.push(apiBaseUrl);
      return {
        async listModels() {
          return [model];
        },
        async resolveModel() {
          return model;
        },
        async probeInference() {},
      };
    },
    randomId: () => `catalog-id-${++id}`,
  });

  const accepted = await owner.executeConnection("user-1", {
    schemaVersion: 1,
    type: "connection/create-api-key",
    commandId: "connect-deepseek",
    packageId: "provider-deepseek",
    connectionTypeId: "deepseek-account",
    label: "Primary",
    apiKey: "secret",
    settings: { "api-base-url": "https://proxy.example/v1/" },
  });
  expect(accepted.status).toBe("applied");
  expect(endpoints).toContain("https://proxy.example/v1");

  const refused = await owner.executeConnection("user-1", {
    schemaVersion: 1,
    type: "connection/create-api-key",
    commandId: "connect-invalid-deepseek",
    packageId: "provider-deepseek",
    connectionTypeId: "deepseek-account",
    label: "Invalid",
    apiKey: "secret",
    settings: { "api-base-url": "not a URL" },
  });
  expect(refused.status).toBe("failed");
  const connection = await settings.getConnection(
    "user-1",
    refused.connectionId,
  );
  expect(connection?.failure).toContain("DeepSeek endpoint");
  expect(connection?.failure).not.toContain("Ollama");
});

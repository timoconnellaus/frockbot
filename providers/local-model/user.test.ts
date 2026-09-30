import { describe, expect, test } from "bun:test";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import {
  LOCAL_MODEL_OFFLINE_V1,
  type MachineModelRelayRequestV1,
} from "@frockbot/core/machine-protocol/relay";

import { providerLocalModelDefinitionV1 } from "./definition.js";
import {
  LocalModelUserBackendContribution,
  decodeLocalModelListV1,
  type LocalModelMachineV1,
} from "./user.js";

class Storage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string | Record<string, unknown>, value?: T) {
    for (const [name, entry] of typeof key === "string"
      ? [[key, value]]
      : Object.entries(key))
      this.values.set(name as string, structuredClone(entry));
  }
  async delete(key: string) {
    return this.values.delete(key);
  }
  async transaction<T>(
    callback: (storage: UserSettingsTransaction) => Promise<T>,
  ) {
    return callback(this);
  }
}

const MODELS = JSON.stringify({
  object: "list",
  data: [
    { id: "llama3.2:latest", object: "model" },
    { id: "qwen2.5:7b", object: "model" },
  ],
});

async function harness(
  options: {
    machines?: LocalModelMachineV1[];
    relay?: (request: MachineModelRelayRequestV1) => Promise<Response>;
  } = {},
) {
  const storage = new Storage();
  const definition = providerLocalModelDefinitionV1;
  const settings = createUserSettingsBackendContribution({
    storage,
    productName: "FrockBot",
    availablePackages: [
      {
        packageId: definition.id,
        version: "0.0.1",
        displayName: definition.displayName,
        dependencies: [],
        capabilities: definition.capabilities ?? [],
        connectionTypes: definition.connectionTypes ?? [],
      },
    ],
  });
  await settings.executeConfiguration({
    schemaVersion: 1,
    userId: "user-1",
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-local",
      expectedRevision: (await settings.read("user-1")).revision,
      packageId: definition.id,
      version: "0.0.1",
    },
  });
  const relayed: MachineModelRelayRequestV1[] = [];
  let ids = 0;
  const owner = new LocalModelUserBackendContribution({
    storage,
    settings,
    machines: async () =>
      options.machines ?? [
        { machineId: "mac-1", label: "Tim's MacBook", revoked: false },
      ],
    relay: async (request) => {
      relayed.push(request);
      return options.relay
        ? options.relay(request)
        : new Response(MODELS, { status: 200 });
    },
    randomId: () => `id-${++ids}`,
  });
  const connection = async (connectionId: string) =>
    (await settings.read("user-1")).connections.find(
      (candidate) => candidate.connectionId === connectionId,
    );
  return { owner, settings, relayed, connection };
}

function create(settings: Record<string, string>, commandId = "create-1") {
  return {
    schemaVersion: 1,
    type: "connection/create",
    commandId,
    packageId: "provider-local",
    connectionTypeId: "local-model",
    label: "Ollama on Tim's MacBook",
    settings,
  };
}

describe("local model connections", () => {
  test("adding one asks the Mac for its models and is ready", async () => {
    const { owner, relayed, connection } = await harness();
    const receipt = await owner.executeConnection(
      "user-1",
      create({ "machine-id": "mac-1", endpoint: "http://localhost:11434/v1/" }),
    );
    expect(receipt.status).toBe("applied");
    expect(relayed).toEqual([
      {
        machineId: "mac-1",
        relayId: expect.stringMatching(/^models:/),
        method: "GET",
        url: "http://localhost:11434/v1/models",
        body: null,
        firstByteMs: 15_000,
      },
    ]);
    const added = await connection(receipt.connectionId);
    expect(added).toMatchObject({
      state: "ready",
      providerType: "local",
      settings: {
        "machine-id": "mac-1",
        endpoint: "http://localhost:11434/v1",
      },
    });
    expect(added?.modelCatalog?.models.map((m) => m.providerModelId)).toEqual([
      "llama3.2:latest",
      "qwen2.5:7b",
    ]);
  });

  test("an endpoint off the Mac's loopback is refused without being asked", async () => {
    const { owner, relayed, connection } = await harness();
    const receipt = await owner.executeConnection(
      "user-1",
      create({
        "machine-id": "mac-1",
        endpoint: "http://192.168.1.4:11434/v1",
      }),
    );
    expect(receipt.status).toBe("failed");
    expect(relayed).toEqual([]);
    expect((await connection(receipt.connectionId))?.failure).toMatch(
      /must be on your Mac/,
    );
  });

  test("a Mac that is not the account's, or was revoked, is refused", async () => {
    const { owner, relayed } = await harness({
      machines: [{ machineId: "mac-1", label: "Old", revoked: true }],
    });
    for (const machineId of ["mac-1", "mac-9"]) {
      const receipt = await owner.executeConnection(
        "user-1",
        create(
          { "machine-id": machineId, endpoint: "http://localhost:11434/v1" },
          `create-${machineId}`,
        ),
      );
      expect(receipt.status).toBe("failed");
    }
    expect(relayed).toEqual([]);
  });

  test("an offline Mac fails the test with the sentence that says so", async () => {
    const { owner, connection } = await harness({
      relay: () => Promise.reject(new Error(LOCAL_MODEL_OFFLINE_V1)),
    });
    const receipt = await owner.executeConnection(
      "user-1",
      create({ "machine-id": "mac-1", endpoint: "http://localhost:11434/v1" }),
    );
    expect(receipt.status).toBe("failed");
    expect(await connection(receipt.connectionId)).toMatchObject({
      state: "failed",
      failure: LOCAL_MODEL_OFFLINE_V1,
    });
  });

  test("a working model that cannot refresh while the Mac sleeps stays usable", async () => {
    let offline = false;
    const { owner, connection } = await harness({
      relay: async () => {
        if (offline) throw new Error(LOCAL_MODEL_OFFLINE_V1);
        return new Response(MODELS);
      },
    });
    const { connectionId } = await owner.executeConnection(
      "user-1",
      create({ "machine-id": "mac-1", endpoint: "http://localhost:11434/v1" }),
    );
    offline = true;
    const refresh = await owner.executeConnection("user-1", {
      schemaVersion: 1,
      type: "connection/refresh-models",
      commandId: "refresh-1",
      connectionId,
    });
    expect(refresh.status).toBe("failed");
    const after = await connection(connectionId);
    expect(after?.state).toBe("ready");
    expect(after?.modelCatalog?.state).toBe("stale");
    expect(after?.modelCatalog?.models).toHaveLength(2);
  });

  test("a command is answered once by its id", async () => {
    const { owner, relayed } = await harness();
    const command = create({
      "machine-id": "mac-1",
      endpoint: "http://localhost:11434/v1",
    });
    const first = await owner.executeConnection("user-1", command);
    const second = await owner.executeConnection("user-1", command);
    expect(second).toEqual(first);
    expect(relayed).toHaveLength(1);
  });
});

describe("decodeLocalModelListV1", () => {
  test("an empty server says to download a model", () => {
    expect(() => decodeLocalModelListV1('{"data":[]}')).toThrow(/Download one/);
  });

  test("something that is not a model list says so", () => {
    expect(() => decodeLocalModelListV1("<html>")).toThrow(/wasn't JSON/);
    expect(() => decodeLocalModelListV1('{"models":[]}')).toThrow(
      /ending in \/v1/,
    );
  });
});

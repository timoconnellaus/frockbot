import { describe, expect, test } from "bun:test";
import { createFlockUserBackendContribution } from "./user.js";
import {
  FlockConflictError,
  randomSheepRecipeV1,
  type BotDirectoryViewV1,
} from "./shared.js";

class MemoryStorage {
  values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }
  put<T>(key: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
    return Promise.resolve();
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}
const settings = {
  schemaVersion: 1 as const,
  revision: 4,
  profile: { name: "User" },
  packages: [],
  connections: [],
  newBotModelTemplate: { connectionId: "provider", providerModelId: "model" },
};
function command(commandId = "create-1", expectedRevision = 0) {
  return {
    schemaVersion: 1 as const,
    type: "bot/create" as const,
    commandId,
    expectedRevision,
    botId: "alpha",
    name: "Alpha",
    sheep: randomSheepRecipeV1(() => 0),
  };
}

describe("Flock User contribution", () => {
  test("atomically admits, snapshots defaults, and replays duplicate delivery", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: (_storage, input) =>
        Promise.resolve({
          assignmentId: input.generation,
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: input.model.connectionId,
          state: "enabled",
        }),
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const first = await contribution.createBot("user-1", command());
    const replay = await contribution.createBot("user-1", command());
    expect(replay).toEqual(first);
    expect(await contribution.registration("alpha")).toMatchObject({
      schemaVersion: 1,
      initialName: "Alpha",
      registeredAt: "2026-08-29T00:00:00.000Z",
    });
    // A new Bot follows the User's default model instead of copying it, so
    // the registration seed carries no model and no claimed binding.
    expect(await contribution.registration("alpha")).toMatchObject({
      initialModel: undefined,
      initialModelBinding: undefined,
    });
    await expect(
      contribution.createBot("user-1", { ...command(), name: "Different" }),
    ).rejects.toThrow("command ID collision");
    await expect(
      contribution.createBot("user-1", {
        ...command("create-2", 0),
        botId: "beta",
      }),
    ).rejects.toBeInstanceOf(FlockConflictError);
  });

  test("admits a Bot while the User default model is unclaimable", async () => {
    const storage = new MemoryStorage();
    let claims = 0;
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: () => {
        claims += 1;
        return Promise.resolve(undefined);
      },
    });

    await expect(
      contribution.createBot("user-1", command()),
    ).resolves.toMatchObject({ status: "applied" });
    expect(claims).toBe(0);
    expect((await contribution.listBots()).bots).toMatchObject([
      { botId: "alpha", initialModel: undefined },
    ]);
  });

  test("rejects malformed durable directories and receipts at the storage seam", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: () => Promise.resolve(undefined),
    });
    await storage.put("flock:directory:v1", {
      schemaVersion: 1,
      revision: 0,
      bots: [],
      unknown: true,
    });
    await expect(contribution.listBots()).rejects.toThrow(
      "unknown or missing field",
    );
    storage.values.delete("flock:directory:v1");
    await storage.put("flock:create-receipt:create-1", {
      fingerprint: JSON.stringify(command()),
      receipt: { schemaVersion: 1, status: "applied" },
    });
    await expect(contribution.createBot("user-1", command())).rejects.toThrow(
      "unknown or missing field",
    );
  });

  test("durably rejects duplicate IDs and the bounded directory limit", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: (_storage, input) =>
        Promise.resolve({
          assignmentId: input.generation,
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: input.model.connectionId,
          state: "enabled",
        }),
    });
    await contribution.createBot("user-1", command());
    expect(
      await contribution.createBot("user-1", {
        ...command("duplicate", 1),
        botId: "alpha",
      }),
    ).toMatchObject({ status: "rejected", revision: 1 });
    const full: BotDirectoryViewV1 = {
      schemaVersion: 1,
      revision: 100,
      bots: Array.from({ length: 100 }, (_, index) => ({
        schemaVersion: 1,
        botId: `bot-${index}`,
        registeredAt: "2026-08-29T00:00:00.000Z",
        initialName: `Bot ${index}`,
        sheep: randomSheepRecipeV1(() => 0),
      })),
    };
    await storage.put("flock:directory:v1", full);
    expect(
      await contribution.createBot("user-1", {
        ...command("limit", 100),
        botId: "overflow",
      }),
    ).toMatchObject({
      status: "rejected",
      failure: "Bot directory limit reached",
    });
  });
});

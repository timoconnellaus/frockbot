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
  list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(prefix),
        ) as Array<[string, T]>,
      ),
    );
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  alarm: number | Date | undefined;
  setAlarm(timestamp: number | Date): Promise<void> {
    this.alarm = timestamp;
    return Promise.resolve();
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
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
    });
    const first = await contribution.createBot("user-1", command());
    const replay = await contribution.createBot("user-1", command());
    expect(replay).toEqual(first);
    expect(await contribution.registration("alpha")).toMatchObject({
      schemaVersion: 1,
      initialName: "Alpha",
      initialModel: settings.newBotModelTemplate,
      initialModelBinding: {
        assignment: {
          assignmentId: "create-1",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "provider",
          state: "enabled",
        },
        generation: "create-1",
      },
      registeredAt: "2026-08-29T00:00:00.000Z",
    });
    settings.newBotModelTemplate.providerModelId = "changed";
    expect(
      (await contribution.registration("alpha")).initialModel?.providerModelId,
    ).toBe("model");
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

  test("rejects a default model without a claimable Connection binding", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: () => Promise.resolve(undefined),
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
    });

    await expect(
      contribution.createBot("user-1", command()),
    ).resolves.toMatchObject({
      status: "rejected",
      failure: "Default model Connection is unavailable",
    });
    expect((await contribution.listBots()).bots).toEqual([]);
  });

  test("rejects malformed durable directories and receipts at the storage seam", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
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

  test("coordinates archive through durable intent and reconciles a lost response", async () => {
    const storage = new MemoryStorage();
    let botStatus: "active" | "archived" = "active";
    let calls = 0;
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: (_storage, input) =>
        Promise.resolve({
          assignmentId: input.generation,
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: input.model.connectionId,
          state: "enabled" as const,
        }),
      commandBotLifecycle: (_userId, lifecycleCommand) => {
        calls += 1;
        botStatus =
          lifecycleCommand.type === "bot/archive" ? "archived" : "active";
        return Promise.reject(new Error("response lost"));
      },
      readBotLifecycle: (_userId, botId) =>
        Promise.resolve({
          schemaVersion: 1,
          botId,
          status: botStatus,
          revision: calls,
        }),
    });
    await expect(
      contribution.executeLifecycle("user-1", {
        schemaVersion: 1,
        type: "bot/archive",
        commandId: "archive-missing",
        botId: "missing",
      }),
    ).rejects.toThrow("not registered");
    await contribution.createBot("user-1", command());
    const seedBefore = structuredClone(
      storage.values.get("flock:directory:v1"),
    );
    const archive = {
      schemaVersion: 1 as const,
      type: "bot/archive" as const,
      commandId: "archive-1",
      botId: "alpha",
    };
    expect(
      await contribution.executeLifecycle("user-1", archive),
    ).toMatchObject({
      status: "applied",
      lifecycle: { status: "archived" },
    });
    expect(
      await contribution.executeLifecycle("user-1", archive),
    ).toMatchObject({
      status: "applied",
    });
    expect(storage.values.get("flock:directory:v1")).toEqual(seedBefore);
    await expect(
      contribution.executeLifecycle("user-1", {
        ...archive,
        type: "bot/restore",
      }),
    ).rejects.toThrow("command ID collision");
    expect((await contribution.listBotLifecycles()).lifecycles).toEqual([
      { schemaVersion: 1, botId: "alpha", status: "archived", revision: 1 },
    ]);
  });

  test("resumes an uncertain lifecycle saga from its User alarm", async () => {
    const storage = new MemoryStorage();
    let recovered = false;
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: (_storage, input) =>
        Promise.resolve({
          assignmentId: input.generation,
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: input.model.connectionId,
          state: "enabled" as const,
        }),
      commandBotLifecycle: () => Promise.reject(new Error("response lost")),
      readBotLifecycle: (_userId, botId) =>
        recovered
          ? Promise.resolve({
              schemaVersion: 1,
              botId,
              status: "archived",
              revision: 1,
            })
          : Promise.reject(new Error("Bot unavailable")),
    });
    await contribution.createBot("user-1", command());
    const lifecycleCommand = {
      schemaVersion: 1 as const,
      type: "bot/archive" as const,
      commandId: "archive-alarm",
      botId: "alpha",
    };
    expect(
      await contribution.executeLifecycle("user-1", lifecycleCommand),
    ).toMatchObject({ status: "pending" });
    expect(storage.alarm).toBeDefined();
    await expect(
      contribution.executeLifecycle("user-1", {
        schemaVersion: 1,
        type: "bot/restore",
        commandId: "restore-too-soon",
        botId: "alpha",
      }),
    ).rejects.toThrow("operation retrying");
    recovered = true;
    const reconstructed = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      claimInitialModelBinding: (_storage, input) =>
        Promise.resolve({
          assignmentId: input.generation,
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: input.model.connectionId,
          state: "enabled" as const,
        }),
      commandBotLifecycle: () => Promise.reject(new Error("response lost")),
      readBotLifecycle: (_userId, botId) =>
        Promise.resolve({
          schemaVersion: 1,
          botId,
          status: "archived",
          revision: 1,
        }),
    });
    await reconstructed.alarm();
    expect(
      await reconstructed.executeLifecycle("user-1", lifecycleCommand),
    ).toMatchObject({ status: "applied", lifecycle: { status: "archived" } });
  });

  test("reconciles uncorrelated, pending, and wrong-target Bot replies", async () => {
    for (const variant of [
      "wrong-command",
      "pending",
      "wrong-target",
    ] as const) {
      const storage = new MemoryStorage();
      let marker: "active" | "archived" = "active";
      const lifecycleCommand = {
        schemaVersion: 1 as const,
        type: "bot/archive" as const,
        commandId: `archive-${variant}`,
        botId: "alpha",
      };
      const create = () =>
        createFlockUserBackendContribution({
          storage,
          readUserSettings: () => Promise.resolve(settings),
          claimInitialModelBinding: (_storage, input) =>
            Promise.resolve({
              assignmentId: input.generation,
              packageId: "provider-ollama-cloud",
              capabilityId: "ollama-cloud-models",
              connectionId: input.model.connectionId,
              state: "enabled" as const,
            }),
          commandBotLifecycle: () =>
            Promise.resolve({
              schemaVersion: 1,
              commandId:
                variant === "wrong-command"
                  ? "another-command"
                  : lifecycleCommand.commandId,
              botId: "alpha",
              status: variant === "pending" ? "pending" : "applied",
              lifecycle: {
                schemaVersion: 1,
                botId: "alpha",
                status: variant === "wrong-target" ? "active" : marker,
                revision: 0,
              },
            }),
          readBotLifecycle: (_userId, botId) =>
            Promise.resolve({
              schemaVersion: 1,
              botId,
              status: marker,
              revision: marker === "archived" ? 1 : 0,
            }),
        });
      const contribution = create();
      await contribution.createBot("user-1", command());
      expect(
        await contribution.executeLifecycle("user-1", lifecycleCommand),
      ).toMatchObject({ status: "pending", lifecycle: { status: "active" } });
      marker = "archived";
      const reconstructed = create();
      await reconstructed.alarm();
      expect(
        await reconstructed.executeLifecycle("user-1", lifecycleCommand),
      ).toMatchObject({
        commandId: lifecycleCommand.commandId,
        status: "applied",
        lifecycle: { status: "archived" },
      });
    }
  });

  test("durably rejects duplicate IDs and the bounded directory limit", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      readUserSettings: () => Promise.resolve(settings),
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
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

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
  test("atomically admits a model-free Bot and replays duplicate delivery", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
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
      registeredAt: "2026-08-29T00:00:00.000Z",
    });
    const registration = await contribution.registration("alpha");
    expect(Object.hasOwn(registration, "initialModel")).toBe(false);
    expect(Object.hasOwn(registration, "initialCapabilities")).toBe(false);
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

  test("admits a Bot without consulting User model state", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
    });

    await expect(
      contribution.createBot("user-1", command()),
    ).resolves.toMatchObject({ status: "applied" });
    expect((await contribution.listBots()).bots).toMatchObject([
      { botId: "alpha" },
    ]);
  });

  test("rejects malformed durable directories and receipts at the storage seam", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
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

  test("lists and extends a directory stored before Bots lost their model seed", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockUserBackendContribution({
      storage,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
    });
    await storage.put("flock:directory:v1", {
      schemaVersion: 1,
      revision: 1,
      bots: [
        {
          schemaVersion: 1,
          botId: "legacy",
          registeredAt: "2026-08-29T00:00:00.000Z",
          initialName: "Legacy",
          initialModel: { connectionId: "openai", providerModelId: "gpt-5" },
          initialAssignments: [],
          sheep: randomSheepRecipeV1(() => 0),
        },
      ],
    });
    const directory = await contribution.listBots();
    expect(directory.bots.map((bot) => bot.botId)).toEqual(["legacy"]);
    expect(Object.hasOwn(directory.bots[0]!, "initialModel")).toBe(false);
    // Creating a Bot reads the same record, so it died on the same field.
    const receipt = await contribution.createBot(
      "user-1",
      command("create-1", 1),
    );
    expect(receipt.status).toBe("applied");
    const migrated = await contribution.listBots();
    expect(migrated.bots.map((bot) => bot.botId)).toEqual(["legacy", "alpha"]);
    // The write settles the migrated shape durably.
    expect(
      Object.hasOwn(
        (
          storage.values.get("flock:directory:v1") as {
            bots: Record<string, unknown>[];
          }
        ).bots[0]!,
        "initialModel",
      ),
    ).toBe(false);
  });

  test("coordinates archive through durable intent and reconciles a lost response", async () => {
    const storage = new MemoryStorage();
    let botStatus: "active" | "archived" = "active";
    let calls = 0;
    const contribution = createFlockUserBackendContribution({
      storage,
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

  test("removes a deleted Bot from the directory and queues its sweep", async () => {
    const storage = new MemoryStorage();
    let botStatus: "active" | "deleted" = "active";
    const contribution = createFlockUserBackendContribution({
      storage,
      commandBotLifecycle: (_userId, lifecycleCommand) => {
        botStatus = "deleted";
        return Promise.resolve({
          schemaVersion: 1,
          commandId: lifecycleCommand.commandId,
          botId: lifecycleCommand.botId,
          status: "applied",
          lifecycle: {
            schemaVersion: 1,
            botId: lifecycleCommand.botId,
            status: "deleted",
            revision: 1,
          },
        });
      },
      readBotLifecycle: (_userId, botId) =>
        Promise.resolve({
          schemaVersion: 1,
          botId,
          status: botStatus,
          revision: 1,
        }),
    });
    await contribution.createBot("user-1", command());
    const remove = {
      schemaVersion: 1 as const,
      type: "bot/delete" as const,
      commandId: "delete-1",
      botId: "alpha",
    };
    const applied = await contribution.executeLifecycle("user-1", remove);
    expect(applied).toMatchObject({
      status: "applied",
      lifecycle: { status: "deleted" },
    });
    // Gone from every read the sidebar, the fan-outs and the debug surface do.
    expect(await contribution.listBots()).toMatchObject({
      revision: 2,
      bots: [],
    });
    expect(await contribution.listBotLifecycles()).toEqual({
      schemaVersion: 1,
      lifecycles: [],
    });
    expect(storage.values.has("flock:lifecycle:alpha")).toBe(false);
    // The User-scoped projections are somebody else's to sweep, so the
    // removal leaves the to-do entry that says so.
    expect(await contribution.listDeletedBotIds()).toEqual(["alpha"]);
    await contribution.forgetDeletedBot("alpha");
    expect(await contribution.listDeletedBotIds()).toEqual([]);
    // Replaying the command settles from the stored receipt rather than
    // reporting a Bot that is no longer registered.
    expect(await contribution.executeLifecycle("user-1", remove)).toEqual(
      applied,
    );
    // A fresh delete of a Bot that is already gone is a plain 404.
    await expect(
      contribution.executeLifecycle("user-1", {
        ...remove,
        commandId: "delete-2",
      }),
    ).rejects.toThrow('Bot "alpha" is not registered');
  });

  test("finishes a half-done delete from the User alarm", async () => {
    const storage = new MemoryStorage();
    // The Bot tore itself down but the reply never arrived, so the saga is the
    // only thing that knows the registration still has to go.
    const contribution = createFlockUserBackendContribution({
      storage,
      commandBotLifecycle: () => Promise.reject(new Error("response lost")),
      readBotLifecycle: (_userId, botId) =>
        Promise.resolve({
          schemaVersion: 1,
          botId,
          status: "deleted",
          revision: 1,
        }),
    });
    await contribution.createBot("user-1", command());
    const failing = createFlockUserBackendContribution({
      storage,
      commandBotLifecycle: () => Promise.reject(new Error("response lost")),
      readBotLifecycle: () => Promise.reject(new Error("Bot unavailable")),
    });
    expect(
      await failing.executeLifecycle("user-1", {
        schemaVersion: 1,
        type: "bot/delete",
        commandId: "delete-alarm",
        botId: "alpha",
      }),
    ).toMatchObject({ status: "pending" });
    expect((await contribution.listBots()).bots).toHaveLength(1);
    await contribution.alarm();
    expect((await contribution.listBots()).bots).toEqual([]);
    expect(await contribution.listDeletedBotIds()).toEqual(["alpha"]);
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
      commandBotLifecycle: () => Promise.reject(new Error("not used")),
      readBotLifecycle: () => Promise.reject(new Error("not used")),
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

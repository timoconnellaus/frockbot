import { describe, expect, test } from "bun:test";
import { createFlockBotBackendContribution } from "./bot.js";
import { FlockConflictError, randomSheepRecipeV1 } from "./shared.js";

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
const registration = {
  botId: "alpha",
  registeredAt: "2026-08-29T00:00:00.000Z",
  initialName: "Alpha",
  sheep: randomSheepRecipeV1(() => 0),
};

describe("Flock Bot contribution", () => {
  test("materializes once and replays sheep updates after reconstruction", async () => {
    const storage = new MemoryStorage();
    let settingsMaterializations = 0;
    const create = () =>
      createFlockBotBackendContribution({
        storage,
        materializeSettings: () => {
          settingsMaterializations += 1;
          return Promise.resolve();
        },
      });
    expect(await create().read(registration, "user-1")).toMatchObject({
      botId: "alpha",
      revision: 0,
    });
    const nextSheep = randomSheepRecipeV1(() => 0.8);
    const command = {
      schemaVersion: 1 as const,
      type: "bot/update-sheep" as const,
      commandId: "sheep-1",
      expectedRevision: 0,
      botId: "alpha",
      sheep: nextSheep,
    };
    const first = await create().update(registration, "user-1", command);
    expect(await create().update(registration, "user-1", command)).toEqual(
      first,
    );
    expect(await create().read(registration, "user-1")).toMatchObject({
      revision: 1,
      sheep: nextSheep,
    });
    await expect(
      create().update(registration, "user-1", {
        ...command,
        commandId: "stale",
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(FlockConflictError);
    await expect(
      create().update(registration, "user-1", {
        ...command,
        sheep: registration.sheep,
      }),
    ).rejects.toThrow("command ID collision");
    expect(settingsMaterializations).toBeGreaterThan(0);
  });

  test("rejects malformed durable sheep identity and receipt records", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
    });
    await storage.put("flock:sheep:v1", {
      schemaVersion: 1,
      botId: "alpha",
      revision: 0,
      sheep: registration.sheep,
      unknown: true,
    });
    await expect(contribution.read(registration, "user-1")).rejects.toThrow(
      "unknown or missing field",
    );
    storage.values.delete("flock:sheep:v1");
    await contribution.read(registration, "user-1");
    await storage.put("flock:sheep-receipt:sheep-1", {
      fingerprint: "{}",
      receipt: { schemaVersion: 1, status: "applied" },
    });
    await expect(
      contribution.update(registration, "user-1", {
        schemaVersion: 1,
        type: "bot/update-sheep",
        commandId: "sheep-1",
        expectedRevision: 0,
        botId: "alpha",
        sheep: registration.sheep,
      }),
    ).rejects.toThrow("unknown or missing field");
  });
});

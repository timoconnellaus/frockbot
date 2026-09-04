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
  list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(prefix),
        ) as Array<[string, T]>,
      ),
    );
  }
}
const registration = {
  schemaVersion: 1 as const,
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
        archiveEligible: () => Promise.resolve(true),
        tearDown: () => Promise.resolve("complete"),
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

  test("archives idempotently, fences mutations, rejects active work, and restores data", async () => {
    const storage = new MemoryStorage();
    let eligible = true;
    const create = () =>
      createFlockBotBackendContribution({
        storage,
        materializeSettings: () => Promise.resolve(),
        archiveEligible: () => Promise.resolve(eligible),
        tearDown: () => Promise.resolve("complete"),
      });
    const contribution = create();
    await contribution.read(registration, "user-1");
    const archive = {
      schemaVersion: 1 as const,
      type: "bot/archive" as const,
      commandId: "archive-1",
      botId: "alpha",
    };
    eligible = false;
    expect(
      await contribution.executeLifecycle(registration, "user-1", archive),
    ).toMatchObject({ status: "rejected", lifecycle: { status: "active" } });
    eligible = true;
    const applied = await contribution.executeLifecycle(
      registration,
      "user-1",
      {
        ...archive,
        commandId: "archive-2",
      },
    );
    expect(applied).toMatchObject({
      status: "applied",
      lifecycle: { status: "archived" },
    });
    expect(
      await contribution.executeLifecycle(registration, "user-1", {
        ...archive,
        commandId: "archive-2",
      }),
    ).toEqual(applied);
    const reconstructed = create();
    expect(
      await reconstructed.readLifecycle(registration, "user-1"),
    ).toMatchObject({ status: "archived" });
    await expect(
      reconstructed.update(registration, "user-1", {
        schemaVersion: 1,
        type: "bot/update-sheep",
        commandId: "sheep-archived",
        expectedRevision: 0,
        botId: "alpha",
        sheep: registration.sheep,
      }),
    ).rejects.toThrow("archived");
    await reconstructed.executeLifecycle(registration, "user-1", {
      schemaVersion: 1,
      type: "bot/restore",
      commandId: "restore-1",
      botId: "alpha",
    });
    expect(await contribution.read(registration, "user-1")).toMatchObject({
      revision: 0,
      sheep: registration.sheep,
    });
  });

  test("deletes every key, cancels the alarm, and refuses to come back", async () => {
    const storage = new MemoryStorage();
    // Whatever else the Bot owned: a run, a Routine schedule, its transcript.
    // The teardown is the host's, so the test plays the host and asserts that
    // the Contribution asked for one and left nothing but the tombstone.
    let alarms = 1;
    const torn: Array<{ userId: string; botId: string }> = [];
    const create = () =>
      createFlockBotBackendContribution({
        storage,
        materializeSettings: () => Promise.resolve(),
        archiveEligible: () => Promise.resolve(false),
        tearDown: (identity) => {
          torn.push(identity);
          alarms = 0;
          storage.values.clear();
          return Promise.resolve("complete" as const);
        },
      });
    const contribution = create();
    await contribution.read(registration, "user-1");
    await storage.put("run:run-1", { schemaVersion: 1 });
    await storage.put("conversation", { schemaVersion: 1 });
    await storage.put("routine-schedule:daily", { schemaVersion: 1 });
    const command = {
      schemaVersion: 1 as const,
      type: "bot/delete" as const,
      commandId: "delete-1",
      botId: "alpha",
    };
    const applied = await contribution.executeLifecycle(
      registration,
      "user-1",
      command,
    );
    expect(applied).toMatchObject({
      status: "applied",
      lifecycle: { botId: "alpha", status: "deleted" },
    });
    // Deletion is not gated on `archiveEligible`: a Bot mid-run is still
    // deleted when its owner says so.
    expect(torn).toEqual([{ userId: "user-1", botId: "alpha" }]);
    expect(alarms).toBe(0);
    // Nothing survives but the tombstone and the receipt that proves it.
    expect([...storage.values.keys()].sort()).toEqual([
      "flock:lifecycle-receipt:delete-1",
      "flock:lifecycle:v1",
    ]);
    // Replaying the command, and replaying it against a fresh instance, both
    // settle from the tombstone without tearing anything down again.
    expect(
      await contribution.executeLifecycle(registration, "user-1", command),
    ).toEqual(applied);
    const reconstructed = create();
    expect(
      await reconstructed.executeLifecycle(registration, "user-1", {
        ...command,
        commandId: "delete-2",
      }),
    ).toMatchObject({ status: "applied", lifecycle: { status: "deleted" } });
    expect(torn).toHaveLength(1);
    expect(
      await reconstructed.readLifecycle(registration, "user-1"),
    ).toMatchObject({ botId: "alpha", status: "deleted" });
    // Neither restore nor archive resurrects it, and no Turn or sheep command
    // may run against it.
    expect(
      await reconstructed.executeLifecycle(registration, "user-1", {
        schemaVersion: 1,
        type: "bot/restore",
        commandId: "restore-1",
        botId: "alpha",
      }),
    ).toMatchObject({ status: "rejected", failure: 'Bot "alpha" is deleted' });
    await expect(reconstructed.read(registration, "user-1")).rejects.toThrow(
      "deleted",
    );
    await expect(reconstructed.assertActive(storage, "alpha")).rejects.toThrow(
      "deleted",
    );
  });

  test("keeps deletion pending until the host has purged derived state", async () => {
    const storage = new MemoryStorage();
    const outcomes: Array<"pending" | "complete"> = ["pending", "complete"];
    const contribution = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve(outcomes.shift() ?? "complete"),
    });
    await contribution.read(registration, "user-1");
    const command = {
      schemaVersion: 1 as const,
      type: "bot/delete" as const,
      commandId: "delete-paged",
      botId: "alpha",
    };

    expect(
      await contribution.executeLifecycle(registration, "user-1", command),
    ).toMatchObject({
      status: "pending",
      lifecycle: { status: "active" },
    });
    expect(
      await contribution.readLifecycle(registration, "user-1"),
    ).toMatchObject({ status: "active" });
    expect(
      await contribution.executeLifecycle(registration, "user-1", command),
    ).toMatchObject({
      status: "applied",
      lifecycle: { status: "deleted" },
    });
  });

  test("rejects malformed durable sheep identity and receipt records", async () => {
    const storage = new MemoryStorage();
    const contribution = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
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

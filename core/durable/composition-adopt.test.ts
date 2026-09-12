import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "./composition/generation.ts";
import { DurableCompositionStore } from "./composition-store.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";

function createStore(storage: MemoryStorage) {
  return new DurableCompositionStore({
    state: { storage } as unknown as DurableObjectState,
    bootstrap: () =>
      bootstrapGeneration({ createdAt: "2026-08-31T00:00:00.000Z" }),
  });
}

async function successor(
  parent: CompositionGenerationV1,
  createdAt: string,
  status: CompositionGenerationV1["status"] = "pending",
): Promise<CompositionGenerationV1> {
  return {
    ...parent,
    generationId: `${createdAt}:${parent.artifactSetHash.slice(0, 16)}`,
    parentGenerationId: parent.generationId,
    createdAt,
    origin: {
      kind: "bot-authored",
      runId: "run-1",
      sessionId: "user-1:primary",
      turnId: "turn-1",
    },
    status,
  };
}

describe("adopting another store's generations as the mirror", () => {
  test("replaces stale records whole, so nothing from before the move lingers", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    // Records from when the Bot owned its own generations.
    const own = await store.current();
    await storage.put("composition:failure:old:1", { stale: true });
    expect(
      [...(await storage.list({ prefix: "composition:" })).keys()].length,
    ).toBeGreaterThan(2);

    const userCurrent = await successor(
      own,
      "2026-09-12T00:00:00.000Z",
      "active",
    );
    const userLastKnownGood = await successor(
      own,
      "2026-09-11T00:00:00.000Z",
      "superseded",
    );
    const pin = await store.adopt({
      current: userCurrent,
      lastKnownGood: userLastKnownGood,
    });

    expect(pin.generationId).toBe(userCurrent.generationId);
    expect(await storage.get<unknown>("composition:current")).toEqual(pin);
    expect(await storage.get<unknown>("composition:last-known-good")).toBe(
      userLastKnownGood.generationId,
    );
    expect(await store.current()).toEqual(userCurrent);
    expect(await store.lastKnownGood()).toEqual(userLastKnownGood);
    expect(await store.read(own.generationId)).toBeUndefined();
    expect(
      await storage.get<unknown>("composition:failure:old:1"),
    ).toBeUndefined();
  });

  test("a pin that already matches only refreshes the two records' status", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const own = await store.current();
    const current = await successor(own, "2026-09-12T00:00:00.000Z", "pending");
    await store.adopt({ current, lastKnownGood: own });
    const keysBefore = [
      ...(await storage.list({ prefix: "composition:" })).keys(),
    ].sort();

    await store.adopt({
      current: { ...current, status: "active" },
      lastKnownGood: own,
    });

    expect(
      [...(await storage.list({ prefix: "composition:" })).keys()].sort(),
    ).toEqual(keysBefore);
    expect((await store.current()).status).toBe("active");
  });

  test("refuses a generation whose artifact-set hash does not match its members", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const own = await store.current();
    await expect(
      store.adopt({
        current: { ...own, artifactSetHash: "f".repeat(64) },
        lastKnownGood: own,
      }),
    ).rejects.toThrow();
  });
});

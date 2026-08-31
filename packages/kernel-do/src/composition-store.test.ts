import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
} from "./authority.ts";
import { DurableCompositionStore } from "./composition-store.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: {
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          key.startsWith(options.prefix ?? "") &&
          (options.end === undefined || key < options.end),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    return Promise.resolve(
      new Map(entries.slice(0, options.limit) as Array<[string, T]>),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

function bootstrap(createdAt: string): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    [
      {
        packageId: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "0.0.1",
        manifest: { id: "shell", version: "0.0.1" },
      },
    ],
    { createdAt },
  );
}

async function successor(
  parent: CompositionGenerationV1,
  createdAt: string,
): Promise<CompositionGenerationV1> {
  return {
    ...parent,
    generationId: `${createdAt}:${parent.artifactSetHash.slice(0, 16)}`,
    parentGenerationId: parent.generationId,
    createdAt,
    origin: { kind: "user-install", userId: "user-1" },
    status: "pending",
  };
}

function createStore(storage: MemoryStorage) {
  return new DurableCompositionStore({
    state: { storage } as unknown as DurableObjectState,
    bootstrap: () => bootstrap("2026-08-31T00:00:00.000Z"),
  });
}

describe("Bot Durable Object Composition records", () => {
  test("materializes the bootstrap generation once, idempotently", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);

    const first = await store.materialize();
    const second = await store.materialize();

    expect(second).toEqual(first);
    expect(storage.values.get("composition:current")).toEqual(first);
    expect(storage.values.get("composition:last-known-good")).toBe(
      first.generationId,
    );
    const current = await store.current();
    expect(current.status).toBe("active");
    expect(current.origin).toEqual({ kind: "bootstrap" });
    expect(await store.lastKnownGood()).toEqual(current);
    expect([...storage.values.keys()].sort()).toEqual([
      "composition:current",
      `composition:generation:${first.generationId}`,
      `composition:index:2026-08-31T00:00:00.000Z:${first.generationId}`,
      "composition:last-known-good",
    ]);
  });

  test("committing a proposal supersedes the generation it replaces", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const parent = await store.current();
    const next = await successor(parent, "2026-09-01T00:00:00.000Z");

    await store.propose(next);
    expect((await store.read(next.generationId))?.status).toBe("pending");
    expect((await store.current()).generationId).toBe(parent.generationId);

    await store.commit(next.generationId);

    expect((await store.current()).generationId).toBe(next.generationId);
    expect((await store.read(parent.generationId))?.status).toBe("superseded");
    expect((await store.lastKnownGood()).generationId).toBe(next.generationId);
  });

  test("rejects unknown, duplicate, and non-pending proposals", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const parent = await store.current();
    const next = await successor(parent, "2026-09-01T00:00:00.000Z");

    await expect(store.commit("missing")).rejects.toThrow(
      'composition generation "missing" is unknown',
    );
    await expect(store.propose({ ...next, status: "active" })).rejects.toThrow(
      "must be proposed as pending",
    );
    await expect(
      store.propose({ ...next, artifactSetHash: "e".repeat(64) }),
    ).rejects.toThrow("mismatched artifact set hash");
    await store.propose(next);
    await expect(store.propose(next)).rejects.toThrow("already exists");
  });

  test("lists generations newest first and paginates by cursor", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const parent = await store.current();
    const created = [parent.generationId];
    for (const day of ["01", "02", "03", "04"]) {
      const next = await successor(parent, `2026-09-${day}T00:00:00.000Z`);
      await store.propose(next);
      created.push(next.generationId);
    }

    const first = await store.list({ limit: 2 });
    expect(first.generations.map((entry) => entry.generationId)).toEqual([
      created[4],
      created[3],
    ]);
    expect(first.cursor).toBeDefined();

    const second = await store.list({ limit: 2, cursor: first.cursor });
    expect(second.generations.map((entry) => entry.generationId)).toEqual([
      created[2],
      created[1],
    ]);

    const last = await store.list({ limit: 2, cursor: second.cursor });
    expect(last.generations.map((entry) => entry.generationId)).toEqual([
      created[0],
    ]);
    expect(last.cursor).toBeUndefined();
    await expect(store.list({ limit: 0 })).rejects.toThrow("positive integer");
    await expect(
      store.list({ limit: 2, cursor: "run-index:x" }),
    ).rejects.toThrow("cursor is invalid");
  });
});

interface TurnProbe {
  authority: BotDurableAuthority<undefined>;
  store: DurableCompositionStore;
  storage: MemoryStorage;
  observed: BotTurnExecutionInput<undefined>[];
}

function createAuthority(
  storage: MemoryStorage,
  executeTurn?: BotDurableAuthorityHooks<undefined>["executeTurn"],
): TurnProbe {
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const authority = new BotDurableAuthority<undefined>({
    state: { storage } as unknown as DurableObjectState,
    codec: createStoredRunCodecV1<undefined>({
      decodeRunId: (value) => value as string,
      decodeConfigurationSnapshot: () => undefined,
    }),
    hooks: {
      resolveAdmissionSnapshot: () => Promise.resolve(undefined),
      bootstrapComposition: () => bootstrap("2026-08-31T00:00:00.000Z"),
      admittedSnapshot: () => Promise.resolve(undefined),
      executeTurn: (input) => {
        observed.push(input);
        return (
          executeTurn?.(input) ??
          Promise.resolve({
            runId: input.command.runId,
            text: "ok",
            events: [],
          })
        );
      },
      notification: () => undefined,
      scheduledDeadlines: () => Promise.resolve([]),
      scheduledWorkInFlight: () => false,
      deferScheduledWork: () => Promise.resolve(),
      settleScheduledWork: () => Promise.resolve(),
    },
  });
  return { authority, store: authority.composition, storage, observed };
}

function command(runId: string) {
  return {
    userId: "user-1",
    botId: "primary",
    runId,
    sessionId: "user-1:primary",
    acceptedAt: "2026-08-31T01:00:00.000Z",
    text: "hello",
  };
}

describe("Composition pinned at admission", () => {
  test("an admitted Turn records the current generation id", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const current = await probe.store.current();

    await probe.authority.run(command("run-1"));

    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    expect(stored.compositionGenerationId).toBe(current.generationId);
    expect(probe.observed[0]?.compositionGenerationId).toBe(
      current.generationId,
    );
  });

  test("committing a generation mid-Turn does not move the in-flight Turn", async () => {
    const storage = new MemoryStorage();
    let pinned: string | undefined;
    let committed: string | undefined;
    const probe = createAuthority(storage, async (input) => {
      pinned = input.compositionGenerationId;
      const parent = await probe.store.current();
      const next = await successor(parent, "2026-09-01T00:00:00.000Z");
      await probe.store.propose(next);
      await probe.store.commit(next.generationId);
      committed = next.generationId;
      return { runId: input.command.runId, text: "ok", events: [] };
    });
    const admitted = await probe.store.current();

    await probe.authority.run(command("run-1"));

    expect(pinned).toBe(admitted.generationId);
    expect(committed).not.toBe(admitted.generationId);
    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    expect(stored.compositionGenerationId).toBe(admitted.generationId);
    expect((await probe.store.current()).generationId).toBe(committed!);
  });

  test("the next admitted Turn pins the newly committed generation", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const parent = await probe.store.current();
    await probe.authority.run(command("run-1"));
    const next = await successor(parent, "2026-09-01T00:00:00.000Z");
    await probe.store.propose(next);
    await probe.store.commit(next.generationId);

    await probe.authority.run({ ...command("run-2"), text: "again" });

    expect(
      (storage.values.get("run:run-1") as StoredRunV1<undefined>)
        .compositionGenerationId,
    ).toBe(parent.generationId);
    expect(
      (storage.values.get("run:run-2") as StoredRunV1<undefined>)
        .compositionGenerationId,
    ).toBe(next.generationId);
  });

  test("recovery reads the pin from the stored run rather than recomputing it", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const parent = await probe.store.current();
    await probe.authority.run(command("run-1"));
    const next = await successor(parent, "2026-09-01T00:00:00.000Z");
    await probe.store.propose(next);
    await probe.store.commit(next.generationId);

    // A Turn interrupted after admission: the durable record still holds the pin.
    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    storage.values.set("run:run-1", {
      ...stored,
      status: "running",
      phase: "executing",
      responseText: undefined,
      events: [],
    });
    storage.values.set("active-run", "run-1");
    storage.values.set("identity", { userId: "user-1", botId: "primary" });
    storage.values.set("latest-events", []);
    const resumed = createAuthority(storage);
    await resumed.authority.recoverActiveRun();

    expect(resumed.observed.at(-1)?.compositionGenerationId).toBe(
      parent.generationId,
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  CompositionPinConflictError,
  COMPOSITION_PIN_ATTEMPTS_V1,
  pinCompositionWithRetryV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
} from "./authority.ts";
import { DurableCompositionStore } from "./composition-store.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";

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

function createStore(storage: MemoryStorage, now?: () => Date) {
  return new DurableCompositionStore({
    state: { storage } as unknown as DurableObjectState,
    bootstrap: () => bootstrap("2026-08-31T00:00:00.000Z"),
    ...(now ? { now } : {}),
  });
}

const authoredMember: CompositionMemberV1 = {
  packageId: "bot-authored-greeter",
  specifier: "bot:greeter",
  version: "0.0.1",
  manifestHash: "a".repeat(64),
  provenance: {
    kind: "bot",
    packageId: "bot-authored-greeter",
    version: "0.0.1",
    botId: "primary",
    sessionId: "user-1:primary",
    turnId: "turn-1",
    runId: "run-1",
    authoredAt: "2026-08-31T12:00:00.000Z",
  },
  artifact: {
    contentHash: "b".repeat(64),
    size: 512,
    mediaType: "application/javascript",
    bundlerVersion: "worker-bundler@0.2.3",
  },
};

/** A successor that actually changes the member set, so a revert is visible. */
async function grownSuccessor(
  parent: CompositionGenerationV1,
  createdAt: string,
): Promise<CompositionGenerationV1> {
  const members = [...parent.members, authoredMember].sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  const artifactSetHash = await compositionArtifactSetHashV1(members);
  return {
    schemaVersion: 1,
    generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
    artifactSetHash,
    parentGenerationId: parent.generationId,
    createdAt,
    origin: {
      kind: "bot-authored",
      runId: "run-1",
      sessionId: "user-1:primary",
      turnId: "turn-1",
    },
    members,
    status: "pending",
  };
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

  test("refuses proposals that remove or replace the first-party bootstrap core", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const parent = await store.current();
    const createdAt = "2026-09-01T00:00:00.000Z";

    const omittedHash = await compositionArtifactSetHashV1([]);
    await expect(
      store.propose({
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(createdAt, omittedHash),
        artifactSetHash: omittedHash,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: "run-1",
          sessionId: "s",
          turnId: "t",
        },
        members: [],
        status: "pending",
      }),
    ).rejects.toThrow(/omits required first-party Package "shell"/);

    const shadow: CompositionMemberV1 = {
      ...authoredMember,
      packageId: "shell",
      specifier: "bot-authored:shell",
      provenance: {
        ...authoredMember.provenance,
        packageId: "shell",
      },
    };
    const replacedHash = await compositionArtifactSetHashV1([shadow]);
    await expect(
      store.propose({
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(createdAt, replacedHash),
        artifactSetHash: replacedHash,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: "run-1",
          sessionId: "s",
          turnId: "t",
        },
        members: [shadow],
        status: "pending",
      }),
    ).rejects.toThrow(
      /replaces required first-party Package "shell" with bot provenance/,
    );

    const catalogShadow: CompositionMemberV1 = {
      packageId: "shell",
      specifier: "catalog:shell",
      version: "0.0.1",
      manifestHash: authoredMember.manifestHash,
      provenance: {
        kind: "catalog",
        packageId: "shell",
        version: "0.0.1",
        catalogId: "shell",
        catalogGeneration: "catalog-1",
        contentHash: authoredMember.artifact!.contentHash,
      },
      artifact: authoredMember.artifact,
    };
    const catalogHash = await compositionArtifactSetHashV1([catalogShadow]);
    await expect(
      store.propose({
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(createdAt, catalogHash),
        artifactSetHash: catalogHash,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: {
          kind: "bot-catalog",
          action: "install",
          packageId: "shell",
          catalogId: "shell",
          botId: "bot-1",
          runId: "run-1",
          sessionId: "s",
          turnId: "t",
        },
        summary: "Added shell",
        members: [catalogShadow],
        status: "pending",
      }),
    ).rejects.toThrow(
      /replaces required first-party Package "shell" with catalog provenance/,
    );

    const changedCore = {
      ...parent.members[0]!,
      version: "9.9.9",
      provenance: {
        ...parent.members[0]!.provenance,
        version: "9.9.9",
      },
    };
    const changedHash = await compositionArtifactSetHashV1([changedCore]);
    await expect(
      store.propose({
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(createdAt, changedHash),
        artifactSetHash: changedHash,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: { kind: "user-install", userId: "user-1" },
        members: [changedCore],
        status: "pending",
      }),
    ).resolves.toBeUndefined();
  });

  test("reverting records a new pending generation with the target's members", async () => {
    const storage = new MemoryStorage();
    const store = createStore(
      storage,
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    const bootstrapped = await store.current();
    const authored = await grownSuccessor(
      bootstrapped,
      "2026-09-01T00:00:00.000Z",
    );
    await store.propose(authored);
    await store.commit(authored.generationId);

    const reverted = await store.revert(bootstrapped.generationId, {
      kind: "revert",
      revertsTo: bootstrapped.generationId,
      userId: "user-1",
    });

    expect(reverted.generationId).not.toBe(bootstrapped.generationId);
    expect(reverted.status).toBe("pending");
    expect(reverted.parentGenerationId).toBe(authored.generationId);
    expect(reverted.members).toEqual(bootstrapped.members);
    expect(reverted.artifactSetHash).toBe(bootstrapped.artifactSetHash);
    expect(reverted.createdAt).toBe("2026-09-05T00:00:00.000Z");
    expect(reverted.origin).toEqual({
      kind: "revert",
      revertsTo: bootstrapped.generationId,
      userId: "user-1",
    });
    // The reverted-to generation is a record: reverting never mutates it.
    expect((await store.read(bootstrapped.generationId))?.status).toBe(
      "superseded",
    );
    // The revert is pinned: the pointer names it now, so the next admitted
    // Turn mounts and commits it. Without the pin the pointer would keep
    // naming the generation the revert replaces and nothing would change.
    expect((await store.current()).generationId).toBe(reverted.generationId);
    expect((await store.read(reverted.generationId))?.status).toBe("pending");
    expect((await store.read(reverted.generationId))?.members).toEqual(
      bootstrapped.members,
    );
  });

  test("the reverted generation activates only when it is committed", async () => {
    const storage = new MemoryStorage();
    const store = createStore(
      storage,
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    const bootstrapped = await store.current();
    const authored = await grownSuccessor(
      bootstrapped,
      "2026-09-01T00:00:00.000Z",
    );
    await store.propose(authored);
    await store.commit(authored.generationId);

    const reverted = await store.revert(bootstrapped.generationId, {
      kind: "revert",
      revertsTo: bootstrapped.generationId,
      userId: "user-1",
    });
    await store.commit(reverted.generationId);

    const current = await store.current();
    expect(current.generationId).toBe(reverted.generationId);
    expect(current.members).toEqual(bootstrapped.members);
    expect((await store.read(authored.generationId))?.status).toBe(
      "superseded",
    );
    expect(
      (await store.list({ limit: 10 })).generations.map(
        (entry) => entry.generationId,
      ),
    ).toEqual([
      reverted.generationId,
      authored.generationId,
      bootstrapped.generationId,
    ]);
  });

  test("a Bot-origin revert is idempotent and cannot mark its generation last-known-good", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const bootstrapped = await store.current();
    const authored = await grownSuccessor(
      bootstrapped,
      "2026-09-01T00:00:00.000Z",
    );
    await store.propose(authored);
    await store.commit(authored.generationId);
    const origin = {
      kind: "revert" as const,
      revertsTo: bootstrapped.generationId,
      botId: "bot-1",
      runId: "run-undo",
      turnId: "turn-undo",
    };

    const reverted = await store.revert(bootstrapped.generationId, origin, {
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const replay = await store.revert(bootstrapped.generationId, origin, {
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    expect(replay).toEqual(reverted);
    expect((await store.lastKnownGood()).generationId).toBe(
      authored.generationId,
    );
    await store.fail(reverted.generationId, { quarantined: false });
    expect((await store.lastKnownGood()).generationId).toBe(
      authored.generationId,
    );
  });

  test("refuses an unknown target and the generation that is already current", async () => {
    const storage = new MemoryStorage();
    const store = createStore(
      storage,
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    const bootstrapped = await store.current();

    await expect(
      store.revert("missing", {
        kind: "revert",
        revertsTo: "missing",
        userId: "user-1",
      }),
    ).rejects.toThrow('composition generation "missing" is unknown');
    await expect(
      store.revert(bootstrapped.generationId, {
        kind: "revert",
        revertsTo: bootstrapped.generationId,
        userId: "user-1",
      }),
    ).rejects.toThrow("is already current");
    await expect(
      store.revert(bootstrapped.generationId, {
        kind: "revert",
        revertsTo: "some-other-generation",
        userId: "user-1",
      }),
    ).rejects.toThrow("does not name its target");
    expect([...storage.values.keys()]).toHaveLength(4);
  });

  test("quarantine with no last known good record falls back to the bootstrap", async () => {
    const storage = new MemoryStorage();
    const store = createStore(
      storage,
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    const bootstrapped = await store.current();
    const authored = await grownSuccessor(
      bootstrapped,
      "2026-09-01T00:00:00.000Z",
    );
    await store.propose(authored);
    await store.commit(authored.generationId);
    const broken = await successor(authored, "2026-09-02T00:00:00.000Z");
    await store.propose(broken, { pin: true });
    // The last known good record is gone. Without a fallback the pointer would
    // keep naming the quarantined generation and every later Turn would throw.
    storage.values.delete(`composition:generation:${authored.generationId}`);

    await store.fail(broken.generationId, { quarantined: true });

    expect((await store.current()).generationId).toBe(
      bootstrapped.generationId,
    );
    expect((await store.lastKnownGood()).generationId).toBe(
      bootstrapped.generationId,
    );
    expect((await store.read(broken.generationId))?.status).toBe("quarantined");
    // The fallback is itself a recorded, visible failure.
    const failures = [...storage.values.entries()].filter(([key]) =>
      key.startsWith(`composition:failure:${authored.generationId}:`),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[1]).toMatchObject({
      generationId: authored.generationId,
      attempt: 1,
      phase: "resolve",
    });
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

describe("a pinning proposal compares and swaps the pointer", () => {
  test("a proposal derived from the generation the pointer still names wins", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const parent = await store.current();
    const next = await grownSuccessor(parent, "2026-09-01T00:00:00.000Z");

    await store.propose(next, {
      pin: true,
      expectedCurrentGenerationId: parent.generationId,
    });

    expect((await store.current()).generationId).toBe(next.generationId);
  });

  test("a proposal derived from a pointer that has since moved is refused whole", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    // What the losing writer snapshotted before it yielded.
    const stale = await store.current();
    // What landed while it was yielded: a Package the Bot authored.
    const authored = await grownSuccessor(stale, "2026-09-01T00:00:00.000Z");
    await store.propose(authored, {
      pin: true,
      expectedCurrentGenerationId: stale.generationId,
    });

    const derivedFromStale = await successor(stale, "2026-09-01T00:00:01.000Z");
    await expect(
      store.propose(derivedFromStale, {
        pin: true,
        expectedCurrentGenerationId: stale.generationId,
      }),
    ).rejects.toBeInstanceOf(CompositionPinConflictError);

    // The pointer still names the winner, and the loser wrote nothing at all:
    // no generation record, no index entry, so no retention quota was spent on
    // a proposal that never applied.
    expect((await store.current()).generationId).toBe(authored.generationId);
    expect(await store.read(derivedFromStale.generationId)).toBeUndefined();
    expect(await store.retainedCount()).toBe(2);
    // And the authored member is still there — the whole point of refusing.
    expect(
      (await store.current()).members.map((member) => member.packageId),
    ).toEqual(["bot-authored-greeter", "shell"]);
  });

  test("the loser re-derives from the winner and keeps both members", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const stale = await store.current();
    const authored = await grownSuccessor(stale, "2026-09-01T00:00:00.000Z");
    await store.propose(authored, {
      pin: true,
      expectedCurrentGenerationId: stale.generationId,
    });

    let derivedFrom = stale;
    let attempts = 0;
    const pinned = await pinCompositionWithRetryV1(async () => {
      attempts += 1;
      // A first attempt that derives from the snapshot it took before it
      // yielded, and a retry that re-reads — which is the merge.
      const parent = attempts === 1 ? stale : await store.current();
      derivedFrom = parent;
      const generation = await successor(
        parent,
        `2026-09-01T00:00:0${attempts}.000Z`,
      );
      await store.propose(generation, {
        pin: true,
        expectedCurrentGenerationId: parent.generationId,
      });
      return generation;
    });

    expect(attempts).toBe(2);
    expect(derivedFrom.generationId).toBe(authored.generationId);
    expect((await store.current()).generationId).toBe(pinned.generationId);
    expect(pinned.members.map((member) => member.packageId)).toEqual([
      "bot-authored-greeter",
      "shell",
    ]);
  });

  test("gives up after a bounded number of losses rather than spinning", async () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const stale = await store.current();
    let attempts = 0;

    await expect(
      pinCompositionWithRetryV1(async () => {
        attempts += 1;
        // Someone else always wins: every attempt derives from a pointer that
        // has already moved by the time it proposes.
        const winner = await successor(
          await store.current(),
          `2026-09-0${attempts}T00:00:00.000Z`,
        );
        await store.propose(winner, { pin: true });
        const generation = await successor(
          stale,
          `2026-09-0${attempts}T00:00:01.000Z`,
        );
        await store.propose(generation, {
          pin: true,
          expectedCurrentGenerationId: stale.generationId,
        });
        return generation;
      }),
    ).rejects.toBeInstanceOf(CompositionPinConflictError);

    expect(attempts).toBe(COMPOSITION_PIN_ATTEMPTS_V1);
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

import { describe, expect, test } from "bun:test";
import {
  activateCompositionV1,
  CompositionMountFailureError,
  type CompositionFailureV1,
} from "@frockbot/kernel-composition/activation";
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
  type MountedComposition,
} from "@frockbot/kernel-composition/generation";
import type { Context } from "cordis";
import { DurableCompositionFailureLog } from "./composition-failures.ts";
import { DurableCompositionStore } from "./composition-store.ts";
import {
  COMPOSITION_CURRENT_KEY,
  compositionFailureCountKey,
  compositionFailureKey,
  compositionQuarantineKey,
} from "./storage-keys.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

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

  delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return Promise.resolve(
        key.reduce(
          (count, entry) => count + (this.values.delete(entry) ? 1 : 0),
          0,
        ),
      );
    }
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()]
          .filter(([key]) => key.startsWith(options.prefix ?? ""))
          .sort(([left], [right]) => left.localeCompare(right)) as Array<
          [string, T]
        >,
      ),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
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

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    [
      {
        packageId: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "0.0.1",
        manifest: { id: "shell", version: "0.0.1" },
      },
    ],
    { createdAt: "2026-08-31T00:00:00.000Z" },
  );
}

async function authored(
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

function mounted(generation: CompositionGenerationV1): MountedComposition {
  return {
    generation,
    root: {} as Context,
    verify: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

interface Fixture {
  storage: MemoryStorage;
  store: DurableCompositionStore;
  failures: DurableCompositionFailureLog;
  lastKnownGood: CompositionGenerationV1;
  broken: CompositionGenerationV1;
}

async function fixture(): Promise<Fixture> {
  const storage = new MemoryStorage();
  const state = { storage } as unknown as DurableObjectState;
  const store = new DurableCompositionStore({ state, bootstrap });
  const failures = new DurableCompositionFailureLog({
    state,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  const lastKnownGood = await store.current();
  const broken = await authored(lastKnownGood, "2026-09-01T00:00:00.000Z");
  await store.propose(broken, { pin: true });
  return { storage, store, failures, lastKnownGood, broken };
}

function activationStore(store: DurableCompositionStore) {
  return {
    read: (generationId: string) => store.read(generationId),
    lastKnownGood: () => store.lastKnownGood(),
    commit: (generationId: string) => store.commit(generationId),
    fail: (generationId: string, options: { quarantined: boolean }) =>
      store.fail(generationId, options),
  };
}

/** Mounts everything except the named generation, which fails at `phase`. */
function brokenHost(
  brokenGenerationId: string,
  phase: "resolve" | "mount" | "health",
) {
  return {
    mount: (generation: CompositionGenerationV1) =>
      generation.generationId === brokenGenerationId
        ? Promise.reject(
            new CompositionMountFailureError(
              phase,
              `package "bot-authored-greeter" failed at ${phase}`,
              [`${phase}: diagnostic`],
            ),
          )
        : Promise.resolve(mounted(generation)),
  };
}

describe("fail-closed Composition activation", () => {
  test("a broken generation leaves the last known good running and records a visible failure", async () => {
    const { store, failures, storage, lastKnownGood, broken } = await fixture();
    const raised: CompositionFailureV1[] = [];

    const activation = await activateCompositionV1({
      generationId: broken.generationId,
      store: activationStore(store),
      failures,
      host: brokenHost(broken.generationId, "mount"),
      signal: new AbortController().signal,
      now: () => new Date("2026-09-01T00:01:00.000Z"),
      onFailure: (failure) => {
        raised.push(failure);
        return Promise.resolve();
      },
    });

    expect(activation.status).toBe("failed-closed");
    if (activation.status !== "failed-closed") return;
    expect(activation.mounted.generation.generationId).toBe(
      lastKnownGood.generationId,
    );
    expect(activation.quarantined).toBe(false);
    expect(activation.failure).toMatchObject({
      generationId: broken.generationId,
      attempt: 1,
      phase: "mount",
    });
    // The failure is durable, visible, and repairable.
    expect(raised).toHaveLength(1);
    expect(
      storage.values.get(compositionFailureKey(broken.generationId, 1)),
    ).toMatchObject({ attempt: 1, phase: "mount" });
    expect(
      storage.values.get(compositionFailureCountKey(broken.generationId)),
    ).toBe(1);
    expect((await store.read(broken.generationId))?.status).toBe("failed");
    expect((await store.lastKnownGood()).generationId).toBe(
      lastKnownGood.generationId,
    );
  });

  test("each of the three load sites records its own phase", async () => {
    for (const phase of ["resolve", "mount", "health"] as const) {
      const { store, failures, broken } = await fixture();
      const activation = await activateCompositionV1({
        generationId: broken.generationId,
        store: activationStore(store),
        failures,
        host: brokenHost(broken.generationId, phase),
        signal: new AbortController().signal,
      });
      expect(activation.status).toBe("failed-closed");
      if (activation.status !== "failed-closed") return;
      expect(activation.failure?.phase).toBe(phase);
      expect(activation.failure?.diagnostics).toEqual([`${phase}: diagnostic`]);
    }
  });

  test("an unresolvable generation fails closed at the resolve phase", async () => {
    const { store, failures, lastKnownGood } = await fixture();
    const activation = await activateCompositionV1({
      generationId: "2026-09-02T00:00:00.000Z:deadbeefdeadbeef",
      store: activationStore(store),
      failures,
      host: { mount: (generation) => Promise.resolve(mounted(generation)) },
      signal: new AbortController().signal,
    });
    expect(activation.status).toBe("failed-closed");
    if (activation.status !== "failed-closed") return;
    expect(activation.failure?.phase).toBe("resolve");
    expect(activation.mounted.generation.generationId).toBe(
      lastKnownGood.generationId,
    );
  });

  test("a third consecutive failure quarantines the generation and is never retried", async () => {
    const { store, failures, storage, lastKnownGood, broken } = await fixture();
    const host = brokenHost(broken.generationId, "health");
    const activationStoreForTurn = activationStore(store);

    for (const attempt of [1, 2, 3]) {
      // Every Turn re-pins the failed generation until it is quarantined.
      if (attempt > 1) {
        await storage.put(COMPOSITION_CURRENT_KEY, {
          generationId: broken.generationId,
          artifactSetHash: broken.artifactSetHash,
        });
      }
      const activation = await activateCompositionV1({
        generationId: broken.generationId,
        store: activationStoreForTurn,
        failures,
        host,
        signal: new AbortController().signal,
      });
      expect(activation.status).toBe("failed-closed");
      if (activation.status !== "failed-closed") return;
      expect(activation.failure?.attempt).toBe(attempt);
      expect(activation.quarantined).toBe(attempt === 3);
    }

    expect((await store.read(broken.generationId))?.status).toBe("quarantined");
    expect(
      storage.values.get(compositionQuarantineKey(broken.generationId)),
    ).toMatchObject({ failures: 3 });
    // Quarantine moved the pointer back, so the fourth Turn pins the good one.
    expect((await store.current()).generationId).toBe(
      lastKnownGood.generationId,
    );

    // A fourth activation of the quarantined generation attempts no mount.
    let attempted = 0;
    const fourth = await activateCompositionV1({
      generationId: broken.generationId,
      store: activationStoreForTurn,
      failures,
      host: {
        mount: (generation) => {
          if (generation.generationId === broken.generationId) attempted += 1;
          return Promise.resolve(mounted(generation));
        },
      },
      signal: new AbortController().signal,
    });
    expect(attempted).toBe(0);
    expect(fourth.status).toBe("failed-closed");
    if (fourth.status !== "failed-closed") return;
    expect(fourth.quarantined).toBe(true);
    expect(await failures.list(broken.generationId)).toHaveLength(3);
  });

  test("quarantine is per generation, so a later unrelated generation still activates", async () => {
    const { store, failures, broken, lastKnownGood } = await fixture();
    await activateCompositionV1({
      generationId: broken.generationId,
      store: activationStore(store),
      failures,
      host: brokenHost(broken.generationId, "mount"),
      signal: new AbortController().signal,
    });
    await failures.record({
      generationId: broken.generationId,
      at: "2026-09-01T00:02:00.000Z",
      phase: "mount",
      message: "second",
      diagnostics: [],
    });
    await failures.record({
      generationId: broken.generationId,
      at: "2026-09-01T00:03:00.000Z",
      phase: "mount",
      message: "third",
      diagnostics: [],
    });
    await store.fail(broken.generationId, { quarantined: true });

    const later = await authored(lastKnownGood, "2026-09-03T00:00:00.000Z");
    await store.propose(later, { pin: true });
    const activation = await activateCompositionV1({
      generationId: later.generationId,
      store: activationStore(store),
      failures,
      host: { mount: (generation) => Promise.resolve(mounted(generation)) },
      signal: new AbortController().signal,
    });

    expect(activation.status).toBe("activated");
    expect((await store.read(later.generationId))?.status).toBe("active");
    expect((await store.lastKnownGood()).generationId).toBe(later.generationId);
    expect(await failures.quarantine(later.generationId)).toBeUndefined();
    expect(await failures.quarantine(broken.generationId)).toMatchObject({
      failures: 3,
    });
    expect((await store.read(broken.generationId))?.status).toBe("quarantined");
  });

  test("a generation that finally activates commits and clears its consecutive count", async () => {
    const { store, failures, storage, broken } = await fixture();
    await activateCompositionV1({
      generationId: broken.generationId,
      store: activationStore(store),
      failures,
      host: brokenHost(broken.generationId, "mount"),
      signal: new AbortController().signal,
    });
    expect(
      storage.values.get(compositionFailureCountKey(broken.generationId)),
    ).toBe(1);

    const activation = await activateCompositionV1({
      generationId: broken.generationId,
      store: activationStore(store),
      failures,
      host: { mount: (generation) => Promise.resolve(mounted(generation)) },
      signal: new AbortController().signal,
    });

    expect(activation.status).toBe("activated");
    expect((await store.read(broken.generationId))?.status).toBe("active");
    expect(
      storage.values.get(compositionFailureCountKey(broken.generationId)),
    ).toBeUndefined();
    // The recorded failure survives: it is the repair history a User reads.
    expect(await failures.list(broken.generationId)).toHaveLength(1);
  });

  test("three failed repairs quarantine, even though each one is a new generation", async () => {
    // The safeguard was dead code in the path a real user takes. The model
    // never retries a failed generation: it authors a *new* one, which
    // supersedes the failed one at attempt 1, so the per-generation counter
    // never reached three and the Composition just grew one dead generation
    // per repair attempt.
    const { store, failures, storage, lastKnownGood } = await fixture();
    const attempts: CompositionGenerationV1[] = [];
    for (const minute of [1, 2, 3]) {
      const generation = await authored(
        lastKnownGood,
        `2026-09-01T00:0${minute}:00.000Z`,
      );
      await store.propose(generation, { pin: true });
      attempts.push(generation);
      const activation = await activateCompositionV1({
        generationId: generation.generationId,
        store: activationStore(store),
        failures,
        host: brokenHost(generation.generationId, "mount"),
        signal: new AbortController().signal,
      });
      expect(activation.status).toBe("failed-closed");
      if (activation.status !== "failed-closed") return;
      // Each new generation is on its own first attempt...
      expect(activation.failure?.attempt).toBe(1);
      // ...but the Bot's streak is what earns the quarantine.
      expect(activation.quarantined).toBe(minute === 3);
    }

    const third = attempts[2]!;
    expect((await store.read(third.generationId))?.status).toBe("quarantined");
    expect(
      storage.values.get(compositionQuarantineKey(third.generationId)),
    ).toBeDefined();
    // The two earlier attempts stay `failed`: a quarantine is a decision about
    // the generation that earned it, not a verdict on its history.
    expect((await store.read(attempts[0]!.generationId))?.status).toBe(
      "failed",
    );
    expect((await store.read(attempts[1]!.generationId))?.status).toBe(
      "failed",
    );
  });

  test("a generation that activates clears the streak, so the next failure starts over", async () => {
    const { store, failures, lastKnownGood } = await fixture();
    for (const minute of [1, 2]) {
      const generation = await authored(
        lastKnownGood,
        `2026-09-01T00:0${minute}:00.000Z`,
      );
      await store.propose(generation, { pin: true });
      await activateCompositionV1({
        generationId: generation.generationId,
        store: activationStore(store),
        failures,
        host: brokenHost(generation.generationId, "mount"),
        signal: new AbortController().signal,
      });
    }

    const working = await authored(lastKnownGood, "2026-09-01T00:03:00.000Z");
    await store.propose(working, { pin: true });
    const activated = await activateCompositionV1({
      generationId: working.generationId,
      store: activationStore(store),
      failures,
      host: { mount: (generation) => Promise.resolve(mounted(generation)) },
      signal: new AbortController().signal,
    });
    expect(activated.status).toBe("activated");

    const next = await authored(lastKnownGood, "2026-09-01T00:04:00.000Z");
    await store.propose(next, { pin: true });
    const activation = await activateCompositionV1({
      generationId: next.generationId,
      store: activationStore(store),
      failures,
      host: brokenHost(next.generationId, "mount"),
      signal: new AbortController().signal,
    });

    expect(activation.status).toBe("failed-closed");
    if (activation.status !== "failed-closed") return;
    expect(activation.quarantined).toBe(false);
  });

  test("a last known good that will not mount has nothing to fail into", async () => {
    const { store, failures, lastKnownGood } = await fixture();
    await expect(
      activateCompositionV1({
        generationId: lastKnownGood.generationId,
        store: activationStore(store),
        failures,
        host: brokenHost(lastKnownGood.generationId, "mount"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/failed at mount/);
  });
});

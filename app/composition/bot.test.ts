import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  compositionActivationStoreV1,
  compositionFailureLogV1,
  syncCompositionFromUser,
} from "./bot.js";

const identity = { userId: "user-1", botId: "bot-1" };

async function generations() {
  const current = await bootstrapGeneration({
    createdAt: "2026-09-12T00:00:00.000Z",
  });
  const lastKnownGood = {
    ...current,
    generationId: `${current.generationId}-lkg`,
  };
  return { current, lastKnownGood };
}

function fakeState(input: {
  rpc: Record<string, (request: unknown) => Promise<unknown>>;
  mirror?: Map<string, CompositionGenerationV1>;
}) {
  const calls: { method: string; request: unknown }[] = [];
  const adopted: unknown[] = [];
  const mirror = input.mirror ?? new Map<string, CompositionGenerationV1>();
  const stub = new Proxy(
    {},
    {
      get: (_target, method: string) => (request: unknown) => {
        calls.push({ method, request });
        const handler = input.rpc[method];
        if (!handler) throw new Error(`unexpected RPC ${method}`);
        return handler(request);
      },
    },
  );
  const state = {
    env: {
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: (id: string) => {
          expect(id).toBe("user-1");
          return stub;
        },
      },
    },
    authority: {
      composition: {
        adopt: (snapshot: unknown) => {
          adopted.push(snapshot);
          const pair = snapshot as {
            current: CompositionGenerationV1;
            lastKnownGood: CompositionGenerationV1;
          };
          mirror.set(pair.current.generationId, pair.current);
          mirror.set(pair.lastKnownGood.generationId, pair.lastKnownGood);
          return Promise.resolve({
            generationId: pair.current.generationId,
            artifactSetHash: pair.current.artifactSetHash,
          });
        },
        read: (generationId: string) =>
          Promise.resolve(mirror.get(generationId)),
        lastKnownGood: () => Promise.resolve([...mirror.values()].at(-1)),
      },
    },
  } as unknown as ShellBotStateV1;
  return { state, calls, adopted };
}

describe("the Bot's mirror of the User's Composition", () => {
  test("syncing reads the User's pin and fallback and adopts them", async () => {
    const pair = await generations();
    const subject = fakeState({
      rpc: { readComposition: () => Promise.resolve(pair) },
    });
    await syncCompositionFromUser(subject.state, identity);
    expect(subject.calls).toEqual([
      {
        method: "readComposition",
        request: { schemaVersion: 1, userId: "user-1" },
      },
    ]);
    expect(subject.adopted).toEqual([pair]);
  });

  test("a User that cannot be read leaves the Bot on the pin it has", async () => {
    const subject = fakeState({
      rpc: { readComposition: () => Promise.reject(new Error("unreachable")) },
    });
    await syncCompositionFromUser(subject.state, identity);
    expect(subject.adopted).toEqual([]);
  });
});

describe("activation against the User", () => {
  test("reads from the mirror first and the User second", async () => {
    const pair = await generations();
    const other = { ...pair.current, generationId: "elsewhere" };
    const subject = fakeState({
      rpc: {
        readCompositionGeneration: (request) =>
          Promise.resolve(
            (request as { generationId: string }).generationId === "elsewhere"
              ? other
              : undefined,
          ),
      },
      mirror: new Map([[pair.current.generationId, pair.current]]),
    });
    const store = compositionActivationStoreV1(subject.state, identity);
    expect(await store.read(pair.current.generationId)).toEqual(pair.current);
    expect(subject.calls).toEqual([]);
    expect(await store.read("elsewhere")).toEqual(other);
    expect(subject.calls[0]?.method).toBe("readCompositionGeneration");
  });

  test("a commit or a failure lands on the User and refreshes the mirror", async () => {
    const pair = await generations();
    const subject = fakeState({
      rpc: {
        commitComposition: () => Promise.resolve(),
        failComposition: () => Promise.resolve(),
        readComposition: () => Promise.resolve(pair),
      },
    });
    const store = compositionActivationStoreV1(subject.state, identity);
    await store.commit(pair.current.generationId);
    await store.fail(pair.current.generationId, { quarantined: true });
    expect(subject.calls.map((call) => call.method)).toEqual([
      "commitComposition",
      "readComposition",
      "failComposition",
      "readComposition",
    ]);
    expect(subject.calls[2]?.request).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      generationId: pair.current.generationId,
      quarantined: true,
    });
    expect(subject.adopted).toHaveLength(2);
  });

  test("the failure log is the User's", async () => {
    const subject = fakeState({
      rpc: {
        recordCompositionFailure: () =>
          Promise.resolve({ consecutiveFailures: 1, quarantined: false }),
        listCompositionFailures: () => Promise.resolve([]),
        readCompositionQuarantine: () => Promise.resolve(undefined),
        clearCompositionFailures: () => Promise.resolve(),
      },
    });
    const log = compositionFailureLogV1(subject.state, identity);
    const failure = {
      generationId: "gen-1",
      at: "2026-09-12T00:00:00.000Z",
      phase: "mount" as const,
      message: "boom",
      diagnostics: [],
    };
    expect(await log.record(failure)).toEqual({
      consecutiveFailures: 1,
      quarantined: false,
    });
    expect(await log.list("gen-1")).toEqual([]);
    expect(await log.quarantine("gen-1")).toBeUndefined();
    await log.clear("gen-1");
    expect(subject.calls.map((call) => call.method)).toEqual([
      "recordCompositionFailure",
      "listCompositionFailures",
      "readCompositionQuarantine",
      "clearCompositionFailures",
    ]);
    expect(subject.calls[0]?.request).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      failure,
    });
  });
});

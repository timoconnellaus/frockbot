// What the journal is allowed to remember about an effect.
//
// One rule under test: only a terminal outcome is durable. A dropped socket, a
// 5xx or a timeout is not this effect's answer, and storing it as one made a
// one-off blip permanent — the claim answered every later attempt with the
// same failure, at HTTP 200, so the effect could never be retried.
import { describe, expect, test } from "bun:test";
import {
  computerHostEffectRequestWireV1,
  type ComputerHostEffectRequestV1,
} from "@frockbot/computer-core/host-protocol";
import { ComputerEffectJournal } from "./effect-journal.ts";

const effect: ComputerHostEffectRequestV1 = {
  schemaVersion: 1,
  effectId: "tool:1:1:0",
  identity: { userId: "user-1" },
  tenant: { botId: "bot-1" },
  assignment: { providerId: "shared", generation: 1 },
  operation: { type: "exec", request: { executable: "/bin/true" } },
};

/** Storage enough for the journal: a map with a serial transaction. */
function state(): DurableObjectState {
  const map = new Map<string, unknown>();
  const storage = {
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      map.set(key, value);
      return Promise.resolve();
    },
    transaction: <T>(run: (storage: unknown) => Promise<T>) => run(storage),
  };
  return { storage } as unknown as DurableObjectState;
}

function journal(
  ctx: DurableObjectState,
  container: () => Promise<Response>,
): ComputerEffectJournal {
  return new ComputerEffectJournal(ctx, {
    FLY_HOST: { getByName: () => ({ fetch: () => container() }) },
    FLY_HOST_SHARDS: "1",
  });
}

function post(): Request {
  return new Request("http://computer-host.internal/effects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(computerHostEffectRequestWireV1(effect)),
  });
}

function completed(): Response {
  return Response.json({
    schemaVersion: 1,
    effectId: effect.effectId,
    status: "completed",
    result: {
      type: "exec",
      result: {
        exitCode: 0,
        stdout: [],
        stderr: [],
        outputTruncated: false,
      },
    },
  });
}

describe("the Computer effect journal", () => {
  test("a transient container failure is not the effect's durable outcome", async () => {
    const ctx = state();
    let attempts = 0;
    const resident = journal(ctx, () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("socket hung up"));
      return Promise.resolve(completed());
    });

    const first = await resident.fetch(post());
    // Non-terminal, and said so: 202, not a 200 that reads as an answer.
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: "unresolved" });

    // The same effect id, attempted again, re-drives the container rather than
    // inheriting the blip forever.
    const second = await resident.fetch(post());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "completed" });
    expect(attempts).toBe(2);

    // And the terminal outcome is the one that is durable: a third attempt
    // replays it without touching the container again.
    const third = await resident.fetch(post());
    expect(await third.json()).toMatchObject({ status: "completed" });
    expect(attempts).toBe(2);
  });
});

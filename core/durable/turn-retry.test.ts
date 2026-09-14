import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import { bootstrapGeneration } from "./composition/generation.js";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import {
  BotTurnExecutionError,
  BotTurnRecoveryRequiredError,
} from "./turn-errors.ts";
import {
  botTurnCommandFingerprintV1,
  createStoredRunCodecV1,
  type StoredRunV1,
} from "./run-records.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => {
    if (typeof value !== "string" || !/^[-a-zA-Z0-9._]+$/.test(value))
      throw new Error("invalid id");
    return value;
  },
  decodeConfigurationSnapshot: () => undefined,
});
const identity = { userId: "user-1", botId: "primary" };
function command(runId: string, retryOf?: string): OwnedBotTurnCommand {
  return {
    ...identity,
    runId,
    sessionId: "user-1:primary",
    acceptedAt: retryOf
      ? "2026-09-13T00:01:00.000Z"
      : "2026-09-13T00:00:00.000Z",
    text: "Check the build",
    ...(retryOf ? { retryOf } : {}),
  };
}
function record(storage: MemoryStorage, id: string) {
  return codec.require(storage.values.get(`run:${id}`));
}

function probe(
  storage: MemoryStorage,
  options: {
    fail?: Set<string>;
    evict?: string;
  } = {},
) {
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const admitted: StoredRunV1<undefined>[] = [];
  const requests: string[] = [];
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () =>
      bootstrapGeneration({ createdAt: "2026-09-13T00:00:00.000Z" }),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      observed.push(input);
      admitted.push(structuredClone(record(storage, input.command.runId)));
      if (options.evict === input.command.runId)
        throw new BotTurnRecoveryRequiredError([]);
      const turn =
        1 +
        input.previousEvents.filter((event) => event.type === "turn/start")
          .length;
      const requestId = crypto.randomUUID();
      requests.push(requestId);
      const fail = options.fail?.has(input.command.runId) ?? false;
      const events: SessionEvent[] = [
        { type: "turn/start", turn },
        {
          type: "user/message",
          turn,
          step: 1,
          messageId: `m-${input.command.runId}`,
          text: input.command.text,
        },
        { type: "step/start", turn, step: 1 },
        {
          type: "model/request",
          turn,
          step: 1,
          request: {
            requestId,
            provider: "foundation",
            model: "test",
            system: "system",
            messages: [{ role: "user", content: input.command.text }],
            tools: [],
          },
        },
        {
          type: "assistant/message",
          turn,
          step: 1,
          requestId,
          text: "private",
          toolCalls: [],
        },
        {
          type: "send/to-user",
          turn,
          step: 1,
          occurrenceId: `tool:${turn}:1:0`,
          payload: { type: "text", text: `Sent by ${input.command.runId}` },
        },
        {
          type: "step/end",
          turn,
          step: 1,
          outcome: fail ? "model-error" : "completed",
        },
        {
          type: "turn/end",
          turn,
          outcome: fail ? "model-error" : "completed",
          ...(fail ? { reason: "Provider unavailable" } : {}),
        },
      ].map(
        (event, index) =>
          ({
            ...event,
            seq: input.previousEvents.length + index,
            timestamp: input.command.acceptedAt,
          }) as SessionEvent,
      );
      await input.persistSessionEvents(input.command.sessionId, events);
      if (fail) throw new BotTurnExecutionError("Provider unavailable", events);
      return { runId: input.command.runId, text: "", events };
    },
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
  };
  return {
    authority: new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks,
    }),
    observed,
    admitted,
    requests,
  };
}

describe("retrying one visible message under a fresh execution identity", () => {
  test("records a chain, preserves all sends and effects, and replays each command once", async () => {
    const storage = new MemoryStorage();
    const p = probe(storage, { fail: new Set(["first", "second"]) });
    await p.authority.run(command("first"));
    const first = (await p.authority.readRun("first"))!;
    const originalEffects = [
      {
        kind: "tool" as const,
        effectId: "tool:1:1:0",
        outcome: "admitted" as const,
      },
    ];
    await storage.put("run:first", {
      ...(storage.values.get("run:first") as object),
      effectAdmissions: originalEffects,
    });
    await p.authority.run(command("second", "first"));
    await p.authority.run(command("second", "first"));
    await p.authority.run(command("third", "second"));
    await p.authority.run(command("third", "second"));
    expect(p.observed.map((input) => input.command.runId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(record(storage, "first").retriedBy).toBe("second");
    expect(record(storage, "second")).toMatchObject({
      retryOf: "first",
      retriedBy: "third",
      messageRunId: "first",
      messageAdmittedAt: command("first").acceptedAt,
    });
    expect(record(storage, "third")).toMatchObject({
      retryOf: "second",
      messageRunId: "first",
      messageAdmittedAt: command("first").acceptedAt,
    });
    expect((await p.authority.readRun("first"))!.events).toEqual(first.events);
    expect(record(storage, "first").effectAdmissions).toEqual(originalEffects);
    expect(
      p.admitted
        .slice(1)
        .every(
          (run) => run.effectAdmissions.length === 0 && run.events.length === 0,
        ),
    ).toBe(true);
    expect(new Set(p.requests).size).toBe(3);
    expect(
      p.observed[2]!.previousEvents.filter(
        (event) => event.type === "send/to-user",
      ),
    ).toHaveLength(2);
    await expect(
      p.authority.run({ ...command("third", "first") }),
    ).rejects.toThrow(/idempotency key/);
    await expect(
      p.authority.run({ ...command("third", "second"), text: "Changed" }),
    ).rejects.toThrow(/idempotency key/);
  });

  test("two devices cannot both retry the same failed attempt", async () => {
    const storage = new MemoryStorage();
    const p = probe(storage, { fail: new Set(["first"]) });
    await p.authority.run(command("first"));
    const results = await Promise.allSettled([
      p.authority.run(command("phone", "first")),
      p.authority.run(command("desktop", "first")),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(p.observed).toHaveLength(2);
    const successor = record(storage, "first").retriedBy!;
    expect(record(storage, successor).retryOf).toBe("first");
    expect(
      storage.values.has(`run:${successor === "phone" ? "desktop" : "phone"}`),
    ).toBe(false);
  });

  test("only the exact failed user message in this conversation is retryable", async () => {
    const storage = new MemoryStorage();
    const p = probe(storage, { fail: new Set(["first"]) });
    await p.authority.run(command("first"));
    const first = structuredClone(storage.values.get("run:first"));
    for (const changed of [
      { retryOf: "missing" },
      { runId: "first" },
      { text: "Different" },
      { sessionId: "user-1:old-conversation" },
      { turnType: "automation" as const },
      { lane: "background" as const },
    ]) {
      await expect(
        p.authority.run({ ...command("retry", "first"), ...changed }),
      ).rejects.toThrow();
      expect(storage.values.has("run:retry")).toBe(false);
      expect(storage.values.get("run:first")).toEqual(first);
    }
    for (const changed of [
      { status: "completed", failure: undefined, responseText: "done" },
      { admission: { schemaVersion: 1, turnType: "agent" } },
      { admission: { schemaVersion: 1, turnType: "chat", lane: "background" } },
      { sessionId: "user-1:old-conversation" },
    ]) {
      await storage.put("run:first", { ...(first as object), ...changed });
      await expect(p.authority.run(command("retry", "first"))).rejects.toThrow(
        /no longer available/,
      );
      expect(storage.values.has("run:retry")).toBe(false);
    }
    await storage.put("run:first", first);
    await p.authority.run(command("retry", "first"));
    await expect(p.authority.run(command("stale", "first"))).rejects.toThrow(
      /no longer available/,
    );
  });

  test("an admitted retry survives eviction without rerunning its predecessor", async () => {
    const storage = new MemoryStorage();
    const p = probe(storage, { fail: new Set(["first"]), evict: "retry" });
    await p.authority.run(command("first"));
    await expect(p.authority.run(command("retry", "first"))).rejects.toThrow(
      /settlement pending/,
    );
    expect(record(storage, "retry")).toMatchObject({
      status: "running",
      retryOf: "first",
      messageRunId: "first",
    });
    const next = probe(storage);
    await next.authority.recoverActiveRun();
    expect(next.observed.map((input) => input.command.runId)).toEqual([
      "retry",
    ]);
    expect(next.observed[0]!.command.retryOf).toBe("first");
    expect(record(storage, "retry")).toMatchObject({
      status: "completed",
      messageRunId: "first",
      messageAdmittedAt: command("first").acceptedAt,
    });
    expect(record(storage, "first").status).toBe("failed");
  });

  test("the stored codec refuses partial, cyclic and nonfailed successor records", async () => {
    const storage = new MemoryStorage();
    const p = probe(storage, { fail: new Set(["first"]) });
    await p.authority.run(command("first"));
    const first = record(storage, "first");
    for (const change of [
      { retryOf: "previous" },
      { messageRunId: "previous" },
      { retriedBy: "first" },
      {
        retryOf: "previous",
        messageRunId: "first",
        messageAdmittedAt: first.acceptedAt,
      },
      { status: "running", failure: undefined, retriedBy: "next" },
    ])
      expect(() => codec.require({ ...first, ...change })).toThrow();
    expect(botTurnCommandFingerprintV1(command("retry", "first"))).not.toBe(
      botTurnCommandFingerprintV1(command("retry")),
    );
  });
});

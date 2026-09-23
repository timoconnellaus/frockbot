import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "./composition/generation.js";
import type { SessionEvent, TurnTypeV1 } from "@frockbot/core/contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { SessionEventLog } from "./session-event-log.ts";
import {
  botTurnCommandFingerprintV1,
  createStoredRunCodecV1,
  storedRunAdmissionV1,
  storedRunTurnTypeV1,
  type StoredRunOriginV1,
  type StoredRunV1,
} from "./run-records.ts";
import type { ConversationUpdateV1 } from "./publication.ts";

const ROUTINE_ORIGIN: StoredRunOriginV1 = {
  kind: "routine",
  routineId: "morning-briefing",
  fireId: "fire-1",
  trigger: "cron",
};

/**
 * A subagent Turn's origin: recorded in the *child* Durable Object, naming the
 * task it is and the parent run that asked for it.
 */
const SUBAGENT_ORIGIN: StoredRunOriginV1 = {
  kind: "subagent",
  taskId: "tk-1",
  parentRunId: "run-parent",
};

/**
 * A hand-off's origin: the Turn a `subagent` call admitted on this same Bot's
 * agent lane, naming the run that asked and how deep the chain is.
 */
const HANDOFF_ORIGIN: StoredRunOriginV1 = {
  kind: "handoff",
  parentRunId: "run-parent",
  depth: 1,
};

const BOT_ORIGIN: StoredRunOriginV1 = {
  kind: "bot",
  fromBotId: "researcher",
  fromBotName: "Researcher",
  messageId: "agent-message-1",
};

/**
 * A voice request's origin: the fixed return address written before the Bot is
 * asked anything, naming the call, the spoken Turn and the request itself.
 */
const VOICE_ORIGIN: StoredRunOriginV1 = {
  kind: "voice",
  callId: "call-1",
  voiceTurnId: "call-1:3",
  requestId: "voice-0123456789abcdef0123456789abcdef",
};

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

/** A stored run exactly as it was written before turn admission existed. */
function legacyRun(
  overrides: Partial<StoredRunV1<undefined>> = {},
): Record<string, unknown> {
  return {
    runId: "run-1",
    commandFingerprint: "bot-turn-command-v1:{}",
    sessionId: "user-1:primary",
    acceptedAt: "2026-08-31T01:00:00.000Z",
    input: "hello",
    events: [],
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: undefined,
    previousEventCount: 0,
    ...overrides,
  };
}

describe("the stored run records the turn type it was admitted as", () => {
  test("a record written before turn admission existed decodes as chat", () => {
    const decoded = codec.require(legacyRun());

    expect(decoded.admission).toBeUndefined();
    expect(storedRunTurnTypeV1(decoded)).toBe("chat");
    // Nothing is added on the way through: the bytes round-trip unchanged.
    expect(Object.keys(decoded).sort()).toEqual(
      Object.keys(legacyRun()).sort(),
    );
  });

  test("round-trips a non-chat admission", () => {
    const stored = legacyRun({
      admission: { schemaVersion: 1, turnType: "automation" },
    });

    const decoded = codec.require(stored);

    expect(decoded.admission).toEqual({
      schemaVersion: 1,
      turnType: "automation",
    });
    expect(storedRunTurnTypeV1(decoded)).toBe("automation");
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);
  });

  test("rejects an unknown turn type and a malformed admission", () => {
    expect(() =>
      codec.require(
        legacyRun({
          admission: { schemaVersion: 1, turnType: "routine" } as never,
        }),
      ),
    ).toThrow(/invalid admission turn type/);
    expect(() =>
      codec.require(legacyRun({ admission: { schemaVersion: 2 } as never })),
    ).toThrow(/invalid admission fields/);
    expect(() =>
      codec.require(legacyRun({ admission: "automation" as never })),
    ).toThrow(/invalid admission/);
  });

  test("writes no admission field at all for a chat Turn", () => {
    expect(storedRunAdmissionV1(undefined)).toEqual({});
    expect(storedRunAdmissionV1("chat")).toEqual({});
    expect(storedRunAdmissionV1("automation")).toEqual({
      admission: { schemaVersion: 1, turnType: "automation" },
    });
    // A recorded origin is worth a record even on a chat Turn.
    expect(storedRunAdmissionV1("chat", ROUTINE_ORIGIN)).toEqual({
      admission: { schemaVersion: 1, turnType: "chat", origin: ROUTINE_ORIGIN },
    });
  });
});

describe("the admission record names what produced the Turn", () => {
  test("round-trips a routine origin", () => {
    const decoded = codec.require(
      legacyRun({
        admission: {
          schemaVersion: 1,
          turnType: "automation",
          origin: ROUTINE_ORIGIN,
        },
      }),
    );

    expect(decoded.admission?.origin).toEqual(ROUTINE_ORIGIN);
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);
  });

  test("an admission with no origin decodes without the key", () => {
    const decoded = codec.require(
      legacyRun({ admission: { schemaVersion: 1, turnType: "automation" } }),
    );

    expect(Object.hasOwn(decoded.admission ?? {}, "origin")).toBe(false);
  });

  test("round-trips a subagent origin, and keeps it exact", () => {
    const decoded = codec.require(
      legacyRun({
        admission: {
          schemaVersion: 1,
          turnType: "subagent",
          origin: SUBAGENT_ORIGIN,
        },
      }),
    );

    expect(decoded.admission?.origin).toEqual(SUBAGENT_ORIGIN);
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);
  });

  test("round-trips an agent Turn and its sending Bot", () => {
    const decoded = codec.require(
      legacyRun({
        admission: {
          schemaVersion: 1,
          turnType: "agent",
          origin: BOT_ORIGIN,
        },
      }),
    );

    expect(decoded.admission?.origin).toEqual(BOT_ORIGIN);
    expect(storedRunTurnTypeV1(decoded)).toBe("agent");
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);
  });

  test("round-trips a voice request and its return address", () => {
    const decoded = codec.require(
      legacyRun({
        admission: {
          schemaVersion: 1,
          turnType: "agent",
          lane: "agent",
          origin: VOICE_ORIGIN,
        },
      }),
    );

    expect(decoded.admission?.origin).toEqual(VOICE_ORIGIN);
    expect(storedRunTurnTypeV1(decoded)).toBe("agent");
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);
  });

  test("round-trips a hand-off and refuses a depth it never wrote", () => {
    const withOrigin = (origin: unknown) =>
      legacyRun({
        admission: {
          schemaVersion: 1,
          turnType: "agent",
          lane: "agent",
          origin,
        },
      } as never);
    const decoded = codec.require(withOrigin(HANDOFF_ORIGIN));

    expect(decoded.admission?.origin).toEqual(HANDOFF_ORIGIN);
    expect(storedRunTurnTypeV1(decoded)).toBe("agent");
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);

    // Depth is the recursion bound, so a record claiming a level the tool
    // cannot produce is not a record this codec wrote.
    expect(() =>
      codec.require(withOrigin({ ...HANDOFF_ORIGIN, depth: 2 })),
    ).toThrow(/invalid admission origin depth/);
    expect(() =>
      codec.require(withOrigin({ ...HANDOFF_ORIGIN, depth: 0 })),
    ).toThrow(/invalid admission origin depth/);
    expect(() =>
      codec.require(withOrigin({ kind: "handoff", parentRunId: "run-parent" })),
    ).toThrow(/invalid admission origin fields/);
  });

  test("a voice origin cannot borrow another origin's fields", () => {
    const withOrigin = (origin: unknown) =>
      legacyRun({
        admission: { schemaVersion: 1, turnType: "agent", origin },
      } as never);

    expect(() =>
      codec.require(withOrigin({ ...VOICE_ORIGIN, fromBotId: "researcher" })),
    ).toThrow(/invalid admission origin fields/);
    expect(() =>
      codec.require(withOrigin({ kind: "voice", callId: "call-1" })),
    ).toThrow(/invalid admission origin fields/);
    expect(() =>
      codec.require(withOrigin({ ...VOICE_ORIGIN, requestId: "" })),
    ).toThrow(/invalid admission origin id/);
    expect(() =>
      codec.require(withOrigin({ ...BOT_ORIGIN, kind: "voice" })),
    ).toThrow(/invalid admission origin fields/);
  });

  test("a group origin round-trips and names members exactly", () => {
    const withOrigin = (origin: unknown) =>
      legacyRun({
        admission: {
          schemaVersion: 1,
          turnType: "agent",
          lane: "agent",
          origin,
        },
      } as never);
    const group: StoredRunOriginV1 = {
      kind: "group",
      groupId: "g-0123456789abcdef0123",
      groupName: "Trip",
      members: [
        { botId: "fox", name: "Fox" },
        { botId: "dog", name: "Dog" },
      ],
      throughSeq: 3,
      reason: "mention",
    };
    const decoded = codec.require(withOrigin(group));
    expect(decoded.admission?.origin).toEqual(group);
    expect(codec.require(structuredClone(decoded))).toEqual(decoded);
    expect(() =>
      codec.require(withOrigin({ ...group, reason: "because" })),
    ).toThrow(/invalid admission origin/);
    expect(() =>
      codec.require(
        withOrigin({
          ...group,
          members: [{ botId: "fox", name: "Fox", x: 1 }],
        }),
      ),
    ).toThrow(/invalid admission origin fields/);
    expect(() =>
      codec.require(withOrigin({ ...group, fromBotId: "fox" })),
    ).toThrow(/invalid admission origin fields/);
  });

  test("each origin kind has its own exact fields, and cannot borrow another's", () => {
    const withOrigin = (origin: unknown) =>
      legacyRun({
        admission: { schemaVersion: 1, turnType: "subagent", origin },
      } as never);

    // A subagent origin carrying a Routine's fields is not a record with a
    // spare field; it is one this codec has never written.
    expect(() =>
      codec.require(
        withOrigin({ ...SUBAGENT_ORIGIN, routineId: "morning-briefing" }),
      ),
    ).toThrow(/invalid admission origin fields/);
    expect(() =>
      codec.require(withOrigin({ kind: "subagent", taskId: "tk-1" })),
    ).toThrow(/invalid admission origin fields/);
    expect(() =>
      codec.require(withOrigin({ ...SUBAGENT_ORIGIN, parentRunId: "" })),
    ).toThrow(/invalid admission origin id/);
    expect(() =>
      codec.require(withOrigin({ ...ROUTINE_ORIGIN, kind: "subagent" })),
    ).toThrow(/invalid admission origin fields/);
  });

  test("a subagent origin is part of the command identity", () => {
    const withOrigin = botTurnCommandFingerprintV1({
      userId: "user",
      botId: "bot",
      runId: "tk-1",
      sessionId: "task:tk-1",
      acceptedAt: "2026-09-01T00:00:00.000Z",
      text: "do the thing",
      turnType: "subagent",
      origin: SUBAGENT_ORIGIN,
    });

    expect(withOrigin).toStartWith("bot-turn-command-v2:");
    expect(withOrigin).toContain('"kind":"subagent"');
    expect(withOrigin).toContain('"parentRunId":"run-parent"');
  });

  test("rejects an unknown origin kind, trigger, or extra field", () => {
    const withOrigin = (origin: unknown) =>
      legacyRun({
        admission: { schemaVersion: 1, turnType: "automation", origin },
      } as never);

    expect(() =>
      codec.require(withOrigin({ ...ROUTINE_ORIGIN, kind: "assignment" })),
    ).toThrow(/invalid admission origin kind/);
    expect(() =>
      codec.require(withOrigin({ ...ROUTINE_ORIGIN, trigger: "alarm" })),
    ).toThrow(/invalid admission origin trigger/);
    expect(() =>
      codec.require(withOrigin({ ...ROUTINE_ORIGIN, extra: 1 })),
    ).toThrow(/invalid admission origin fields/);
    expect(() =>
      codec.require(withOrigin({ ...ROUTINE_ORIGIN, fireId: "" })),
    ).toThrow(/invalid admission origin id/);
    expect(() => codec.require(withOrigin("routine"))).toThrow(
      /invalid admission origin/,
    );
    expect(() =>
      codec.require(
        legacyRun({
          admission: {
            schemaVersion: 1,
            turnType: "automation",
            unexpected: true,
          },
        } as never),
      ),
    ).toThrow(/invalid admission fields/);
  });
});

describe("the command fingerprint stays byte-stable for chat", () => {
  const command = {
    userId: "user-1",
    botId: "primary",
    runId: "run-1",
    sessionId: "user-1:primary",
    acceptedAt: "2026-08-31T01:00:00.000Z",
    text: "hello",
  };

  test("a chat command matches the exact bytes deployed idempotency records hold", () => {
    // Pinned literal: an in-flight run admitted before this change must still
    // replay against its stored fingerprint after deploy.
    const pinned =
      'bot-turn-command-v1:{"userId":"user-1","botId":"primary","sessionId":"user-1:primary","text":"hello"}';

    expect(botTurnCommandFingerprintV1(command)).toBe(pinned);
    expect(botTurnCommandFingerprintV1({ ...command, turnType: "chat" })).toBe(
      pinned,
    );
  });

  test("only a non-chat command emits v2, and the type is part of its identity", () => {
    const automation = botTurnCommandFingerprintV1({
      ...command,
      turnType: "automation",
    });
    const subagent = botTurnCommandFingerprintV1({
      ...command,
      turnType: "subagent",
    });

    expect(automation).toStartWith("bot-turn-command-v2:");
    expect(automation).toContain('"turnType":"automation"');
    expect(subagent).not.toBe(automation);
  });

  test("a recorded origin is part of the command identity", () => {
    const withOrigin = botTurnCommandFingerprintV1({
      ...command,
      origin: ROUTINE_ORIGIN,
    });

    expect(withOrigin).toStartWith("bot-turn-command-v2:");
    expect(withOrigin).toContain('"routineId":"morning-briefing"');
    expect(withOrigin).not.toBe(botTurnCommandFingerprintV1(command));
    expect(
      botTurnCommandFingerprintV1({
        ...command,
        origin: { ...ROUTINE_ORIGIN, fireId: "fire-2" },
      }),
    ).not.toBe(withOrigin);
  });
});

interface TurnProbe {
  authority: BotDurableAuthority<undefined>;
  observed: BotTurnExecutionInput<undefined>[];
}

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration({ createdAt: "2026-08-31T00:00:00.000Z" });
}

/**
 * An authority whose Package records `turn/admission` exactly as the Agent loop
 * does, so the durable log shows the turn type the mounted Agent ran on.
 */
function createAuthority(storage: MemoryStorage): TurnProbe {
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () => bootstrap(),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      observed.push(input);
      const events: SessionEvent[] = [
        {
          type: "turn/admission",
          seq: input.cursor.nextSeq,
          timestamp: "2026-08-31T01:00:01.000Z",
          turn: 1,
          turnType: input.command.turnType ?? "chat",
        },
      ];
      await input.persistSessionEvents(input.command.sessionId, events);
      return { runId: input.command.runId, text: "ok", events };
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
  };
}

function command(runId: string, turnType?: TurnTypeV1) {
  return {
    userId: "user-1",
    botId: "primary",
    runId,
    sessionId: "user-1:primary",
    acceptedAt: "2026-08-31T01:00:00.000Z",
    text: "hello",
    ...(turnType ? { turnType } : {}),
  };
}

async function admittedEvent(storage: MemoryStorage, runId: string) {
  const run = storage.values.get(`run:${runId}`) as StoredRunV1<undefined>;
  const events = await new SessionEventLog(storage).readRange(
    run.sessionId,
    run.eventRange!.startSeq,
    run.eventRange!.endSeq,
  );
  return events.find((event) => event.type === "turn/admission");
}

describe("an admitted Turn re-mounts on its recorded turn type", () => {
  test("a chat Turn stores no admission and runs as chat", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    await probe.authority.run(command("run-1"));

    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    expect(stored.admission).toBeUndefined();
    expect(Object.hasOwn(stored, "admission")).toBe(false);
    expect(probe.observed[0]?.command.turnType).toBeUndefined();
  });

  test("an automation Turn stores the type it was admitted as", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    await probe.authority.run(command("run-1", "automation"));

    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    expect(stored.admission).toEqual({
      schemaVersion: 1,
      turnType: "automation",
    });
    expect(probe.observed[0]?.command.turnType).toBe("automation");
    expect(await admittedEvent(storage, "run-1")).toMatchObject({
      turnType: "automation",
    });
  });

  test("an agent Turn defaults to the agent admission lane", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    await probe.authority.run(command("run-agent", "agent"));

    const stored = storage.values.get(
      "run:run-agent",
    ) as StoredRunV1<undefined>;
    expect(stored.admission).toEqual({
      schemaVersion: 1,
      turnType: "agent",
    });
    expect(probe.observed[0]?.command.turnType).toBe("agent");
  });

  test("after eviction the resumed run re-mounts on the recorded type", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    await probe.authority.run(command("run-1", "automation"));

    // A Turn interrupted after admission and before any external intent: the
    // durable record is all a reconstructed object has to re-mount from.
    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    storage.values.set("run:run-1", {
      ...stored,
      status: "running",
      phase: "executing",
      responseText: undefined,
      eventRange: { startSeq: 0, endSeq: 0 },
    });
    storage.values.set("active-run", "run-1");
    storage.values.set("identity", { userId: "user-1", botId: "primary" });
    await new SessionEventLog(storage).rewrite("user-1:primary", []);

    const resumed = createAuthority(storage);
    await resumed.authority.recoverActiveRun();

    expect(resumed.observed.at(-1)?.command.turnType).toBe("automation");
    expect(await admittedEvent(storage, "run-1")).toMatchObject({
      turnType: "automation",
    });
  });

  test("a chat Turn recovered after eviction still re-mounts as chat", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    await probe.authority.run(command("run-1"));

    const stored = storage.values.get("run:run-1") as StoredRunV1<undefined>;
    storage.values.set("run:run-1", {
      ...stored,
      status: "running",
      phase: "executing",
      responseText: undefined,
      eventRange: { startSeq: 0, endSeq: 0 },
    });
    storage.values.set("active-run", "run-1");
    storage.values.set("identity", { userId: "user-1", botId: "primary" });
    await new SessionEventLog(storage).rewrite("user-1:primary", []);

    const resumed = createAuthority(storage);
    await resumed.authority.recoverActiveRun();

    expect(resumed.observed.at(-1)?.command.turnType).toBe("chat");
    expect(await admittedEvent(storage, "run-1")).toMatchObject({
      turnType: "chat",
    });
  });
});

describe("admission does not wait for the previous Turn", () => {
  test("a new command is durable while the previous provider call is unresolved", async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const authority = new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: async (input) => {
          seen.push(input.command.runId);
          if (input.command.runId === "run-1") await gate;
          return { runId: input.command.runId, text: "ok", events: [] };
        },
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      },
    });
    const first = authority.run(command("run-1"));
    for (let attempt = 0; attempt < 20 && seen.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const receipt = await authority.admit({
      ...command("run-2"),
      text: "next",
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runId: "run-2",
      disposition: "queued",
    });
    expect(receipt.completion).toBeUndefined();
    expect(storage.values.has("run:run-2")).toBe(true);
    expect(seen).toEqual(["run-1"]);
    release?.();
    await first;
    await authority.whenDriverSettled();
    expect(
      (storage.values.get("run:run-2") as StoredRunV1<undefined>).status,
    ).toBe("completed");
  });

  test("eviction after admission and before the kick still runs on the alarm", async () => {
    const storage = new MemoryStorage();
    const started = new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: () => Promise.reject(new Error("the kick must not run")),
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      },
      kickDriver: false,
    });
    const receipt = await started.admit(command("run-1"));
    expect(receipt.disposition).toBe("admitted");
    expect(storage.alarmAt).toBeTypeOf("number");
    const ran: string[] = [];
    const resumed = new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: async (input) => {
          ran.push(input.command.runId);
          return { runId: input.command.runId, text: "resumed", events: [] };
        },
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      },
    });
    await resumed.alarm();
    expect(ran).toEqual(["run-1"]);
    expect(
      (storage.values.get("run:run-1") as StoredRunV1<undefined>).status,
    ).toBe("completed");
  });

  test("a queued Turn keeps the Composition it was admitted under", async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pins: string[] = [];
    const authority = new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: async (input) => {
          pins.push(input.compositionGenerationId);
          if (input.command.runId === "run-1") await gate;
          return { runId: input.command.runId, text: "ok", events: [] };
        },
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([Date.now() + 120_000]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      },
    });
    const first = authority.run(command("run-1"));
    for (let attempt = 0; attempt < 20 && pins.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const admittedPin = (
      storage.values.get("run:run-1") as StoredRunV1<undefined>
    ).compositionGenerationId;
    await authority.admit({
      ...command("run-2"),
      text: "later",
    });
    const queuedPin = (
      storage.values.get("run:run-2") as StoredRunV1<undefined>
    ).compositionGenerationId;
    storage.values.set("composition:current", {
      schemaVersion: 1,
      generationId: "generation-later",
    });
    release?.();
    await first;
    await authority.whenDriverSettled();
    expect(queuedPin).toBe(admittedPin);
    expect(pins.at(-1)).toBe(admittedPin);
    expect(pins.at(-1)).not.toBe("generation-later");
  });

  test("a rolled-back admission leaves neither the run nor its publication", async () => {
    const storage = new MemoryStorage();
    storage.failNextAlarm = true;
    const authority = new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: () => Promise.reject(new Error("must not execute")),
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      },
      kickDriver: false,
    });
    await expect(authority.admit(command("run-1"))).rejects.toThrow(
      /alarm write failed/,
    );
    expect(storage.values.has("run:run-1")).toBe(false);
    expect(storage.values.has("active-run")).toBe(false);
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith("publication-pending:"),
      ),
    ).toBe(false);
    expect(
      [...storage.values.keys()].some((key) => key.startsWith("repair-due:")),
    ).toBe(false);
  });

  test("publication drains while a Turn is executing, and a read does not", async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: (readonly ConversationUpdateV1[])[] = [];
    let deferred = 0;
    let settled = 0;
    const authority = new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: async (input) => {
          await authority.alarm();
          await gate;
          return { runId: input.command.runId, text: "ok", events: [] };
        },
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([Date.now() + 60_000]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: async () => {
          deferred += 1;
        },
        settleScheduledWork: async () => {
          settled += 1;
        },
        deliverPublication: async (pending) => {
          delivered.push(pending);
        },
      },
    });
    const running = authority.run(command("run-1"));
    for (
      let attempt = 0;
      attempt < 20 && delivered.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(delivered.length).toBeGreaterThan(0);
    expect(deferred).toBeGreaterThan(0);
    expect(settled).toBe(0);
    const before = delivered.length;
    await authority.readRunHeader("run-1");
    expect(delivered.length).toBe(before);
    release?.();
    await running;
  });
});

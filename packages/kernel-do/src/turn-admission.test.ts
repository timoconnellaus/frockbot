import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import type { SessionEvent, TurnTypeV1 } from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import {
  botTurnCommandFingerprintV1,
  createStoredRunCodecV1,
  storedRunAdmissionV1,
  storedRunTurnTypeV1,
  type StoredRunOriginV1,
  type StoredRunV1,
} from "./run-records.ts";

const ROUTINE_ORIGIN: StoredRunOriginV1 = {
  kind: "routine",
  routineId: "morning-briefing",
  fireId: "fire-1",
  trigger: "cron",
};

/**
 * A subagent Turn's origin (ADR 0017): recorded in the *child* Durable Object,
 * naming the task it is and the parent run that asked for it.
 */
const SUBAGENT_ORIGIN: StoredRunOriginV1 = {
  kind: "subagent",
  taskId: "tk-1",
  parentRunId: "run-parent",
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
          seq: input.previousEvents.length,
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

function admittedEvent(storage: MemoryStorage, runId: string) {
  const run = storage.values.get(`run:${runId}`) as StoredRunV1<undefined>;
  return run.events.find((event) => event.type === "turn/admission");
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
    expect(admittedEvent(storage, "run-1")).toMatchObject({
      turnType: "automation",
    });
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
      events: [],
    });
    storage.values.set("active-run", "run-1");
    storage.values.set("identity", { userId: "user-1", botId: "primary" });
    storage.values.set("latest-events", []);

    const resumed = createAuthority(storage);
    await resumed.authority.recoverActiveRun();

    expect(resumed.observed.at(-1)?.command.turnType).toBe("automation");
    expect(admittedEvent(storage, "run-1")).toMatchObject({
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
      events: [],
    });
    storage.values.set("active-run", "run-1");
    storage.values.set("identity", { userId: "user-1", botId: "primary" });
    storage.values.set("latest-events", []);

    const resumed = createAuthority(storage);
    await resumed.authority.recoverActiveRun();

    expect(resumed.observed.at(-1)?.command.turnType).toBe("chat");
    expect(admittedEvent(storage, "run-1")).toMatchObject({
      turnType: "chat",
    });
  });
});

// robustness F18. The composer sends `supersedes` on every send and names
// whichever run it happened to have observed. A retry of the same send names a
// different one — or none — and used to be refused as a reused idempotency key.
describe("a retried send is idempotent whatever run it names", () => {
  const command = {
    userId: "user-1",
    botId: "primary",
    runId: "run-1",
    sessionId: "user-1:primary",
    acceptedAt: "2026-08-31T01:00:00.000Z",
    text: "hello",
    lane: "user" as const,
  };

  test("the observed run id is not part of the command's identity", () => {
    const first = botTurnCommandFingerprintV1({ ...command, supersedes: {} });

    expect(
      botTurnCommandFingerprintV1({
        ...command,
        supersedes: { runId: "run-0" },
      }),
    ).toBe(first);
    expect(
      botTurnCommandFingerprintV1({
        ...command,
        supersedes: { runId: "run-99" },
      }),
    ).toBe(first);
  });

  test("but the intent itself still is, so a replay cannot gain one", () => {
    expect(
      botTurnCommandFingerprintV1({ ...command, supersedes: {} }),
    ).not.toBe(botTurnCommandFingerprintV1(command));
  });
});

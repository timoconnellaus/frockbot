import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import { Session, type SessionEvent } from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";

const SQLITE_VALUE_LIMIT_BYTES = 2 * 1024 * 1024;
const LARGE_REQUEST_BYTES = 80_000;
const STEPS = 30;
const SESSION_ID = "user-1:primary";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => String(value),
  decodeConfigurationSnapshot: () => undefined,
});

/** A storage double that enforces Durable Object SQLite's per-value ceiling. */
class SqliteLimitedMemoryStorage extends MemoryStorage {
  readonly rejectedKeys: string[] = [];

  override put(
    key: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> {
    const entries =
      typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    for (const [entryKey, entry] of entries) {
      const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (bytes > SQLITE_VALUE_LIMIT_BYTES) {
        this.rejectedKeys.push(entryKey);
        throw new Error("string or blob too big: SQLITE_TOOBIG");
      }
    }
    return super.put(key, value);
  }

  override async transaction<T>(
    callback: (storage: MemoryStorage) => Promise<T>,
  ): Promise<T> {
    const before = structuredClone([...this.values.entries()]);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }
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
    { createdAt: "2026-09-04T00:00:00.000Z" },
  );
}

function legacyEvents(): SessionEvent[] {
  const session = new Session(SESSION_ID, () => {});
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "legacy-message",
      text: "Earlier work",
    },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "legacy-request",
        provider: "fake",
        model: "large-context",
        system: "p".repeat(1_900_000),
        messages: [{ role: "user", content: "Earlier work" }],
        tools: [],
      },
    },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "legacy-request",
      text: "Done earlier.",
      toolCalls: [],
    },
    { type: "step/end", turn: 1, step: 1, outcome: "completed" },
    { type: "turn/end", turn: 1, outcome: "completed" },
  ]);
  return [...session.events];
}

function legacyRun(events: SessionEvent[]): StoredRunV1<undefined> {
  return {
    runId: "legacy-run",
    commandFingerprint: "legacy-fingerprint",
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-04T00:00:00.000Z",
    input: "Earlier work",
    events,
    effectAdmissions: [],
    status: "completed",
    responseText: "Done earlier.",
    phase: "executing",
    compositionGenerationId: "legacy-generation",
    configurationSnapshot: undefined,
    previousEventCount: 0,
  };
}

function createAuthority(
  storage: SqliteLimitedMemoryStorage,
): BotDurableAuthority<undefined> {
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () => bootstrap(),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      let seq = input.previousEvents.length;
      const events: SessionEvent[] = [];
      const persist = async (
        batch: Array<Omit<SessionEvent, "seq" | "timestamp">>,
      ) => {
        const stamped = batch.map(
          (event) =>
            ({
              ...event,
              seq: seq++,
              timestamp: "2026-09-04T00:01:00.000Z",
            }) as SessionEvent,
        );
        events.push(...stamped);
        await input.persistSessionEvents(input.command.sessionId, stamped);
      };

      await persist([{ type: "turn/start", turn: 2 } as never]);
      for (let step = 1; step <= STEPS; step += 1) {
        await persist([
          { type: "step/start", turn: 2, step } as never,
          ...(step === 1
            ? [
                {
                  type: "user/message",
                  turn: 2,
                  step,
                  messageId: "message-2",
                  text: input.command.text,
                } as never,
              ]
            : []),
          {
            type: "model/request",
            turn: 2,
            step,
            request: {
              requestId: `request-${step}`,
              provider: "fake",
              model: "large-context",
              system: "s".repeat(LARGE_REQUEST_BYTES),
              messages: [{ role: "user", content: input.command.text }],
              tools: [],
            },
          } as never,
          {
            type: "assistant/message",
            turn: 2,
            step,
            requestId: `request-${step}`,
            text: step === STEPS ? "All done." : "",
            toolCalls: [],
          } as never,
          { type: "step/end", turn: 2, step, outcome: "completed" } as never,
        ]);
      }
      await persist([
        { type: "turn/end", turn: 2, outcome: "completed" } as never,
      ]);
      return { runId: input.command.runId, text: "All done.", events };
    },
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
  };
  return new BotDurableAuthority<undefined>({
    state: { storage } as unknown as DurableObjectState,
    codec,
    hooks,
  });
}

describe("a long Turn on a legacy near-limit Session", () => {
  test("migrates to bounded values and completes thirty large model steps", async () => {
    const storage = new SqliteLimitedMemoryStorage();
    const previous = legacyEvents();
    const legacyBytes = new TextEncoder().encode(
      JSON.stringify(previous),
    ).byteLength;
    expect(legacyBytes).toBeGreaterThan(1_900_000);
    expect(legacyBytes).toBeLessThan(SQLITE_VALUE_LIMIT_BYTES);
    // Seed through the backing map because these are values an older deploy
    // already wrote. Every write made by the code under test is size-checked.
    storage.values.set("latest-events", structuredClone(previous));
    storage.values.set("run:legacy-run", structuredClone(legacyRun(previous)));

    const completion = await createAuthority(storage).run({
      userId: "user-1",
      botId: "primary",
      runId: "large-run",
      sessionId: SESSION_ID,
      acceptedAt: "2026-09-04T00:01:00.000Z",
      text: "Keep going",
    });

    const stored = codec.require(storage.values.get("run:large-run"));
    expect(storage.rejectedKeys).not.toContain("run:large-run");
    expect(stored.failure ?? "").not.toContain("SQLITE_TOOBIG");
    expect(completion.text).toBe("All done.");
    expect(
      completion.events.filter((event) => event.type === "model/request"),
    ).toHaveLength(STEPS);
    expect(storage.values.has("latest-events")).toBe(false);
    expect(
      [...storage.values.values()].every(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength <=
          SQLITE_VALUE_LIMIT_BYTES,
      ),
    ).toBe(true);
  });
});

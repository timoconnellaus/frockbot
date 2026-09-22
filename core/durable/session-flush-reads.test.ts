// What a durable flush is allowed to read. `persistRunEvents` hydrates the run
// it is appending to — the Package's event-records hook is handed that run —
// but it has no business hydrating the rest of the Session. Every model
// request is stored cut at ~80 KiB and nothing prunes them, so a flush that
// walked the whole log fetched, re-verified and parsed every retained request
// of every earlier Turn, about eight times per Turn preamble.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "./composition/generation.js";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { sessionEventPayloadPrefixV1 } from "./session-event-log.ts";
import { createStoredRunCodecV1 } from "./run-records.ts";

const SESSION_ID = "user-1:primary";
const LARGE_REQUEST_BYTES = 80_000;
const EARLIER_STEPS = 10;

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => String(value),
  decodeConfigurationSnapshot: () => undefined,
});

/** A storage that records the keys read while `recording` is on. */
class ReadRecordingStorage extends MemoryStorage {
  recording = false;
  readonly reads: string[] = [];

  override get<T>(key: string): Promise<T | undefined> {
    if (this.recording) this.reads.push(key);
    return super.get<T>(key);
  }

  override list<T>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    if (
      this.recording &&
      options.limit === undefined &&
      (options.prefix ?? "").startsWith("session-events:")
    ) {
      throw new Error("unbounded archive read");
    }
    return super.list(options);
  }
}

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration({ createdAt: "2026-09-04T00:00:00.000Z" });
}

function createAuthority(
  storage: MemoryStorage,
  executeTurn: BotDurableAuthorityHooks<undefined>["executeTurn"],
): BotDurableAuthority<undefined> {
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () => bootstrap(),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn,
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

function command(runId: string) {
  return {
    userId: "user-1",
    botId: "primary",
    runId,
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-04T00:01:00.000Z",
    text: "Keep going",
  };
}

function largeRequest(turn: number, step: number) {
  return {
    type: "model/request",
    turn,
    step,
    request: {
      requestId: `request-${turn}-${step}`,
      provider: "fake",
      model: "large-context",
      system: "s".repeat(LARGE_REQUEST_BYTES),
      messages: [{ role: "user", content: "Keep going" }],
      tools: [],
    },
  } as never;
}

/** The `seq` a payload chunk key belongs to, from the key alone. */
function payloadSeq(key: string): number {
  return Number(
    key.slice(sessionEventPayloadPrefixV1(SESSION_ID).length + 1).split(":")[0],
  );
}

/**
 * Runs one Turn of `batches`, each batch flushed as the agent loop flushes.
 * Returns how many events the Session log holds afterwards.
 */
function turnOf(
  turn: number,
  batches: Array<Array<Omit<SessionEvent, "seq" | "timestamp">>>,
  /** Recording is scoped to the flush: admission's own read is not the subject. */
  recorder?: ReadRecordingStorage,
): BotDurableAuthorityHooks<undefined>["executeTurn"] {
  return async (input) => {
    let seq = input.cursor.nextSeq;
    const events: SessionEvent[] = [];
    for (const batch of batches) {
      const stamped = batch.map(
        (event) =>
          ({
            ...event,
            seq: seq++,
            timestamp: "2026-09-04T00:01:00.000Z",
          }) as SessionEvent,
      );
      events.push(...stamped);
      if (recorder) recorder.recording = true;
      try {
        await input.persistSessionEvents(input.command.sessionId, stamped);
      } finally {
        if (recorder) recorder.recording = false;
      }
    }
    return { runId: input.command.runId, text: `turn ${turn}`, events };
  };
}

describe("a durable flush of a Session whose log holds cut events", () => {
  test("never fetches a payload chunk from an earlier Turn", async () => {
    const storage = new ReadRecordingStorage();

    // An earlier Turn, whose ten large model requests are all stored cut.
    await createAuthority(
      storage,
      turnOf(1, [
        [{ type: "turn/start", turn: 1 } as never],
        ...Array.from({ length: EARLIER_STEPS }, (_, step) => [
          largeRequest(1, step + 1),
        ]),
        [{ type: "turn/end", turn: 1, outcome: "completed" } as never],
      ]),
    ).run(command("earlier-run"));

    const payloadPrefix = sessionEventPayloadPrefixV1(SESSION_ID);
    const earlier = [...storage.values.keys()].filter((key) =>
      key.startsWith(payloadPrefix),
    );
    // The earlier Turn really did leave cut payloads behind, so the assertion
    // below has something to catch.
    expect(earlier.length).toBeGreaterThan(0);
    const boundary = Math.max(...earlier.map(payloadSeq)) + 1;

    const completion = await createAuthority(
      storage,
      turnOf(
        2,
        [
          [{ type: "turn/start", turn: 2 } as never],
          [largeRequest(2, 1)],
          [{ type: "turn/end", turn: 2, outcome: "completed" } as never],
        ],
        storage,
      ),
    ).run(command("later-run"));

    expect(completion.text).toBe("turn 2");
    expect(storage.reads.length).toBeGreaterThan(0);
    expect(
      storage.reads
        .filter((key) => key.startsWith(payloadPrefix))
        .filter((key) => payloadSeq(key) < boundary),
    ).toEqual([]);
  });

  test("still refuses a batch that does not continue the log", async () => {
    const storage = new MemoryStorage();
    let refusal: string | undefined;

    await createAuthority(storage, async (input) => {
      const first: SessionEvent[] = [
        {
          type: "turn/start",
          turn: 1,
          seq: 0,
          timestamp: "2026-09-04T00:01:00.000Z",
        } as SessionEvent,
      ];
      await input.persistSessionEvents(input.command.sessionId, first);
      try {
        await input.persistSessionEvents(input.command.sessionId, [
          {
            type: "turn/end",
            turn: 1,
            outcome: "completed",
            // The log holds one event, so the next one is seq 1.
            seq: 7,
            timestamp: "2026-09-04T00:01:00.000Z",
          } as SessionEvent,
        ]);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      return { runId: input.command.runId, text: "done", events: first };
    }).run(command("gap-run"));

    expect(refusal).toBe(
      "Bot session persistence received non-contiguous events",
    );
  });
});

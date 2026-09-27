// Events a quiet Bot appends to its own conversation, outside any Turn.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import { bootstrapGeneration } from "./composition/generation.js";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1 } from "./run-records.ts";
import { ACTIVE_RUN_KEY, PENDING_USER_RUN_PREFIX } from "./storage-keys.ts";

const SESSION_ID = "user-1:primary";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => String(value),
  decodeConfigurationSnapshot: () => undefined,
});

const PRUNED = {
  type: "conversation/tool-results-pruned",
  results: [{ turn: 1, callId: "c-1" }],
} as const;

function createAuthority(
  storage: MemoryStorage,
): BotDurableAuthority<undefined> {
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () =>
      bootstrapGeneration({ createdAt: "2026-09-27T00:00:00.000Z" }),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      let seq = input.cursor.nextSeq;
      const events = [
        { type: "turn/start", turn: 1 },
        { type: "turn/end", turn: 1, outcome: "completed" },
      ].map(
        (event) =>
          ({
            ...event,
            seq: seq++,
            timestamp: "2026-09-27T00:01:00.000Z",
          }) as SessionEvent,
      );
      await input.persistSessionEvents(input.command.sessionId, events);
      return { runId: input.command.runId, text: "done", events };
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

async function settledConversation() {
  const storage = new MemoryStorage();
  const authority = createAuthority(storage);
  await authority.run({
    userId: "user-1",
    botId: "primary",
    runId: "run-1",
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-27T00:01:00.000Z",
    text: "Look this up",
  });
  await (authority as unknown as { drive?: Promise<void> }).drive;
  const count = (await authority.readSessionEvents(SESSION_ID)).length;
  return { storage, authority, count };
}

describe("appending while the Bot is quiet", () => {
  test("continues the log after the Session's newest run", async () => {
    const { authority, count } = await settledConversation();
    expect(
      await authority.appendQuietSessionEvents({
        runId: "run-1",
        sessionId: SESSION_ID,
        expectedEventCount: count,
        events: [PRUNED],
      }),
    ).toBe(true);
    const events = await authority.readSessionEvents(SESSION_ID);
    expect(events).toHaveLength(count + 1);
    expect(events.at(-1)).toMatchObject({ ...PRUNED, seq: count });
    expect((await authority.readRun("run-1"))?.events.at(-1)).toMatchObject(
      PRUNED,
    );
  });

  test("is refused once the log has moved on", async () => {
    const { authority, count } = await settledConversation();
    expect(
      await authority.appendQuietSessionEvents({
        runId: "run-1",
        sessionId: SESSION_ID,
        expectedEventCount: count - 1,
        events: [PRUNED],
      }),
    ).toBe(false);
    expect(await authority.readSessionEvents(SESSION_ID)).toHaveLength(count);
  });

  test("is refused while a Turn is active or queued", async () => {
    for (const [key, value] of [
      [ACTIVE_RUN_KEY, "run-2"],
      [`${PENDING_USER_RUN_PREFIX}0001`, "run-2"],
    ] as const) {
      const { storage, authority, count } = await settledConversation();
      await storage.put(key, value);
      expect(
        await authority.appendQuietSessionEvents({
          runId: "run-1",
          sessionId: SESSION_ID,
          expectedEventCount: count,
          events: [PRUNED],
        }),
      ).toBe(false);
      expect(await authority.readSessionEvents(SESSION_ID)).toHaveLength(count);
    }
  });

  test("is refused for a run of another Session", async () => {
    const { authority, count } = await settledConversation();
    expect(
      await authority.appendQuietSessionEvents({
        runId: "run-1",
        sessionId: "user-1:other",
        expectedEventCount: 0,
        events: [PRUNED],
      }),
    ).toBe(false);
    expect(await authority.readSessionEvents(SESSION_ID)).toHaveLength(count);
  });
});

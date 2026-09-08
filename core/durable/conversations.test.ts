import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "./composition/generation.js";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1 } from "./run-records.ts";
import { SessionEventLog } from "./session-event-log.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

const IDENTITY = { userId: "user-1", botId: "primary" };

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration({ createdAt: "2026-08-31T00:00:00.000Z" });
}

function createAuthority(storage: MemoryStorage) {
  const sessions: string[] = [];
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () => bootstrap(),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      sessions.push(input.command.sessionId);
      const events: SessionEvent[] = [
        {
          type: "turn/admission",
          seq: input.previousEvents.length,
          timestamp: "2026-08-31T01:00:01.000Z",
          turn: input.previousEvents.length + 1,
          turnType: "chat",
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
    sessions,
  };
}

function command(runId: string) {
  return {
    ...IDENTITY,
    runId,
    sessionId: "user-1:primary",
    acceptedAt: `2026-08-31T01:00:0${runId.slice(-1)}.000Z`,
    text: `message ${runId}`,
  };
}

describe("one continuous chat", () => {
  test("successive Turns and a reconstructed authority retain the same Session and history", async () => {
    const storage = new MemoryStorage();
    const first = createAuthority(storage);
    await first.authority.run(command("run-1"));
    const resumed = createAuthority(storage);
    await resumed.authority.run(command("run-2"));
    expect(first.sessions).toEqual(["user-1:primary"]);
    expect(resumed.sessions).toEqual(["user-1:primary"]);
    expect(await resumed.authority.readConversationSessionId()).toBe(
      "user-1:primary",
    );
    expect(
      (storage.values.get("run:run-2") as { previousEventCount: number })
        .previousEventCount,
    ).toBe(1);
  });
});

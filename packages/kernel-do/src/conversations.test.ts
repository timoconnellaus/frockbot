import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
} from "./authority.ts";
import {
  ConversationBusyError,
  conversationSessionIdV1,
  isConversationBusyV1,
  isConversationSessionIdV1,
} from "./conversations.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1 } from "./run-records.ts";
import { SessionEventLog } from "./session-event-log.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

const IDENTITY = { userId: "user-1", botId: "primary" };

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

describe("a Bot's Session id names the conversation it is on", () => {
  test("the first conversation is the bare Session id", () => {
    expect(conversationSessionIdV1("user-1:primary", 1)).toBe("user-1:primary");
    expect(conversationSessionIdV1("user-1:primary", 3)).toBe(
      "user-1:primary#3",
    );
  });

  test("only a Bot's own conversations match its base id", () => {
    const base = "user-1:primary";
    expect(isConversationSessionIdV1(base, base)).toBe(true);
    expect(isConversationSessionIdV1(base, `${base}#2`)).toBe(true);
    expect(isConversationSessionIdV1(base, "routine:morning")).toBe(false);
    expect(isConversationSessionIdV1(base, `${base}#0`)).toBe(false);
    expect(isConversationSessionIdV1(base, `${base}#x`)).toBe(false);
  });
});

describe("starting a new conversation", () => {
  test("empties the log the next Turn derives from and keeps the old Turns", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    await probe.authority.run(command("run-1"));
    const log = new SessionEventLog(storage);
    expect((await log.read("user-1:primary")).length).toBe(1);

    const started = await probe.authority.startConversation(IDENTITY);
    expect(started.ordinal).toBe(2);
    expect(started.sessionId).toBe("user-1:primary#2");
    // The next Turn starts from a distinct, empty paged log.
    expect(await log.read("user-1:primary#2")).toEqual([]);
    // The conversation just ended is still on disk, Turn for Turn.
    expect((await probe.authority.readRun("run-1"))?.events.length).toBe(1);
    expect(storage.values.get("run:run-1")).not.toHaveProperty("events");

    await probe.authority.run(command("run-2"));
    // The new Turn ran in the new Session, and saw none of the old history.
    expect(probe.sessions).toEqual(["user-1:primary", "user-1:primary#2"]);
    expect(
      (storage.values.get("run:run-2") as { previousEventCount: number })
        .previousEventCount,
    ).toBe(0);
  });

  test("lists the conversations the Bot has had, newest first", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    await probe.authority.run(command("run-1"));
    await probe.authority.startConversation(IDENTITY);
    await probe.authority.run(command("run-2"));

    const conversations = await probe.authority.listConversations(IDENTITY);
    expect(conversations.map((entry) => entry.sessionId)).toEqual([
      "user-1:primary#2",
      "user-1:primary",
    ]);
    expect(conversations[0]?.endedAt).toBeUndefined();
    expect(conversations[1]?.endedAt).toBeString();
  });

  test("is refused while a Turn is still admitted", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    storage.values.set("active-run", "run-9");

    // Typed, not a bare Error: the Durable Object boundary keys on the name to
    // turn this one case into a 409 value rather than letting it escape the
    // object's entry frame as an uncaught exception.
    const refusal = await probe.authority
      .startConversation(IDENTITY)
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(isConversationBusyV1(refusal)).toBe(true);
    expect(refusal).toBeInstanceOf(ConversationBusyError);
    expect((refusal as Error).message).toMatch(/still working on a Turn/);
  });
});

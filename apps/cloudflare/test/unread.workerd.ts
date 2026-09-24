// Per-Bot unread against a real Bot Durable Object.
//
// The claims a Bun double cannot make, because all three are claims about the
// deployed object:
//
//  1. The count is durable state, not a number a client kept: two settled
//     Turns read as two after the object is evicted and reconstructed.
//  2. `bot/mark-read` is a durable command: the badge stays cleared across
//     eviction, because "read" was written, not remembered.
//  3. Recovery never double-counts. A Turn put back into `running` and settled
//     a second time by the recovery path leaves the count exactly where it was
//     — a counter could not promise this, a `max()` over a cursor does.
//
// A new Bot alerts, so muting is a written setting, not a default: the muted
// case below turns it off through the settings command and reads the view back
// — the intent is suppressed, the unread cursor still advances.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import {
  hydrateStoredRunEventsV1,
  rewindStoredRunEventsV1,
} from "./session-log-probe.ts";

interface UnreadRpc {
  readUnread(input: unknown): Promise<{
    botId: string;
    count: number;
    capped: boolean;
    unread: boolean;
    manuallyUnread: boolean;
    notificationsEnabled: boolean;
    lastActivityCursor?: string;
    lastMessage?: { text: string; at: string; role: "assistant" | "user" };
    working?: boolean;
  }>;
  executeUnreadCommand(input: unknown): Promise<{
    status: string;
    unread: {
      count: number;
      unread: boolean;
      manuallyUnread: boolean;
      notificationsEnabled: boolean;
      lastMessage?: { text: string; at: string; role: "assistant" | "user" };
    };
  }>;
  listRuns(input: unknown): Promise<{ runs: unknown[] }>;
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  executeConfiguration(input: unknown): Promise<unknown>;
  executeRoutineCommand(input: unknown): Promise<{ status: string }>;
}

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function unreadRpc(name: string): UnreadRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(name) as unknown as UnreadRpc;
}

/**
 * Puts a settled run back where a Turn still in flight holds it: `running`,
 * with its Turn not yet ended in its Session's log.
 */
async function reopen(name: string, runId: string): Promise<void> {
  await runInDurableObject(bot(name), async (_instance, state) => {
    const key = `run:${runId}`;
    const stored = (await state.storage.get(key)) as Parameters<
      typeof rewindStoredRunEventsV1
    >[2];
    const run = await hydrateStoredRunEventsV1(state.storage, stored);
    await rewindStoredRunEventsV1(
      state.storage,
      key,
      stored,
      run.events.filter((event) => event.type !== "turn/end"),
      { status: "running", phase: "executing" },
    );
  });
}

/** Names the Turn occupying the Bot, or clears it. */
async function markActive(
  name: string,
  runId: string | undefined,
): Promise<void> {
  await runInDurableObject(bot(name), async (_instance, state) => {
    if (runId === undefined) await state.storage.delete("active-run");
    else await state.storage.put("active-run", runId);
  });
}

async function storedRun(name: string, runId: string): Promise<unknown> {
  return runInDurableObject(bot(name), (_instance, state) =>
    state.storage.get(`run:${runId}`),
  );
}

/** The newest Turn in the Bot's run index. */
async function newestRunId(name: string): Promise<string | undefined> {
  return runInDurableObject(bot(name), async (_instance, state) => {
    const newest = await state.storage.list<string>({
      prefix: "run-index:",
      reverse: true,
      limit: 1,
    });
    return [...newest.values()][0];
  });
}

describe("per-Bot unread in Workerd", () => {
  test("two settled Turns read as two, and mark-read survives eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-user-${suffix}`,
      botId: `unread-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);
    const sessionId = name;

    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      botId: identity.botId,
      count: 0,
      unread: false,
    });

    for (const [index, text] of ["first", "second"].entries()) {
      const result = await stub.run({
        ...identity,
        command: {
          runId: `run-${index + 1}`,
          sessionId,
          acceptedAt: `2026-08-31T00:0${index}:00.000Z`,
          text,
        },
      });
      expect(result.text).toBe("Ollama reply");
    }

    const settled = await unreadRpc(name).readUnread(identity);
    // A new Bot alerts: `notifications.enabled` is true the moment the Bot is
    // materialized, so the view tells the application icon to count it.
    expect(settled).toMatchObject({
      count: 2,
      capped: false,
      unread: true,
      notificationsEnabled: true,
    });
    expect(settled.lastActivityCursor).toMatch(/^message-[0-9]{20}$/);
    expect(settled.lastMessage).toMatchObject({
      text: "Ollama reply",
      role: "assistant",
    });

    // THE EVICTION. The count is derived from durable state, not from anything
    // the object was holding.
    await evictDurableObject(stub);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 2,
      unread: true,
      lastMessage: { text: "Ollama reply", role: "assistant" },
    });

    const receipt = await unreadRpc(name).executeUnreadCommand({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: `mark-${suffix}`,
        botId: identity.botId,
        upToCursor: settled.lastActivityCursor,
      },
    });
    expect(receipt).toMatchObject({
      status: "applied",
      unread: { count: 0, unread: false, notificationsEnabled: true },
    });

    await evictDurableObject(stub);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 0,
      unread: false,
    });

    // A replayed command is the same receipt, not a second write.
    const replayed = await unreadRpc(name).executeUnreadCommand({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: `mark-${suffix}`,
        botId: identity.botId,
        upToCursor: settled.lastActivityCursor,
      },
    });
    expect(replayed).toMatchObject({ unread: { count: 0 } });

    // Manual unread is User intent, and it is durable too.
    await unreadRpc(name).executeUnreadCommand({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/mark-unread",
        commandId: `unmark-${suffix}`,
        botId: identity.botId,
      },
    });
    await evictDurableObject(stub);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 0,
      unread: true,
      manuallyUnread: true,
    });
  });

  // Muting is the eligibility rule the application icon runs on, and it is a
  // setting the fan-out reads out of the Bot's own durable record — not a flag
  // the client keeps. So mute through the command a person's toggle sends, and
  // the view that feeds the badge has to say so, still after an eviction.
  test("muting the Bot turns its badge off in the unread view", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-muted-user-${suffix}`,
      botId: `unread-muted-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);

    await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt: "2026-09-05T00:00:00.000Z",
        text: "hello",
      },
    });
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 1,
      notificationsEnabled: true,
    });

    const configuration = await unreadRpc(name).readConfiguration(identity);
    await unreadRpc(name).executeConfiguration({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/update-notifications",
        commandId: `mute-${suffix}`,
        expectedRevision: configuration.revision,
        botId: identity.botId,
        notifications: { enabled: false },
      },
    });

    // The mute gates the alert, never the cursor: the row still says one.
    await evictDurableObject(stub);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 1,
      unread: true,
      notificationsEnabled: false,
    });

    // A Turn on a muted Bot still counts on its row, and still must not badge.
    await stub.run({
      ...identity,
      command: {
        runId: "run-2",
        sessionId: name,
        acceptedAt: "2026-09-05T00:01:00.000Z",
        text: "again",
      },
    });
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 2,
      notificationsEnabled: false,
    });

    // Unmuting is the same seam, read back the same way.
    const muted = await unreadRpc(name).readConfiguration(identity);
    await unreadRpc(name).executeConfiguration({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/update-notifications",
        commandId: `unmute-${suffix}`,
        expectedRevision: muted.revision,
        botId: identity.botId,
        notifications: { enabled: true },
      },
    });
    await evictDurableObject(stub);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 2,
      notificationsEnabled: true,
    });
  });

  // The row and the transcript are two renderings of the same Turn, so the
  // very first settlement has to be enough: a Bot that has answered once owes
  // its sidebar row that answer and the instant it landed, with no second Turn
  // and no reload in between.
  test("one settled Turn is enough for the row to carry its reply and time", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-first-user-${suffix}`,
      botId: `unread-first-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;

    const before = await unreadRpc(name).readUnread(identity);
    // "No messages yet" is the row for a Bot with no settled line at all.
    expect(before.lastMessage).toBeUndefined();

    const acceptedAt = "2026-08-31T00:00:00.000Z";
    const sent = Date.now();
    await bot(name).run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt,
        text: "hello",
      },
    });

    const settled = await unreadRpc(name).readUnread(identity);
    expect(settled.lastMessage).toMatchObject({
      text: "Ollama reply",
      role: "assistant",
    });
    // The time is when the Turn settled — this run, not the admission stamp of
    // some earlier one, and not a placeholder the row would render as an epoch.
    const at = Date.parse(settled.lastMessage?.at ?? "");
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(sent);
    expect(settled.lastMessage?.at).not.toBe(acceptedAt);
  });

  // The preview record is written at settlement, so a Bot whose Turns settled
  // before that projection existed has a transcript and no record — and its
  // sidebar row read "No messages yet" over a full conversation. The read
  // derives the line from the runs instead. The open Bot is the one that gets
  // marked read, so its receipt is the row the sidebar renders, and it owes
  // the same preview the fan-out gives every other Bot.
  test("a Bot with a transcript and no preview record still shows its latest message", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-legacy-user-${suffix}`,
      botId: `unread-legacy-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);

    await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt: "2026-08-31T00:00:00.000Z",
        text: "hello",
      },
    });

    // A Bot as the durable store held it before the preview projection: the
    // runs and the unread cursors are there, the preview key is not.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete("shell:preview");
    });
    await evictDurableObject(stub);

    const derived = await unreadRpc(name).readUnread(identity);
    expect(derived.lastMessage).toMatchObject({
      text: "Ollama reply",
      role: "assistant",
    });

    const receipt = await unreadRpc(name).executeUnreadCommand({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: `mark-legacy-${suffix}`,
        botId: identity.botId,
        upToCursor: derived.lastActivityCursor,
      },
    });
    expect(receipt.unread.lastMessage).toMatchObject({
      text: "Ollama reply",
      role: "assistant",
    });
  });

  // The badge half of "one notification per message, none for the open Bot".
  //
  // The client suppresses the row of the Bot it is looking at and sends a read
  // receipt behind it. What that leans on is this: reading is a cursor, so the
  // *next* message still counts one, and the receipt behind it clears exactly
  // that one — the same conversation, kept at zero for as long as it is being
  // read, without the durable record ever having heard of "focus".
  test("reading keeps pace with the conversation, one message at a time", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-focus-user-${suffix}`,
      botId: `unread-focus-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);

    const say = async (index: number): Promise<void> => {
      await stub.run({
        ...identity,
        command: {
          runId: `run-${index}`,
          sessionId: name,
          acceptedAt: `2026-09-04T00:0${index}:00.000Z`,
          text: `message ${index}`,
        },
      });
    };
    const read = async (upToCursor: string, label: string): Promise<number> => {
      const receipt = await unreadRpc(name).executeUnreadCommand({
        ...identity,
        command: {
          schemaVersion: 1,
          type: "bot/mark-read",
          commandId: `${label}-${suffix}`,
          botId: identity.botId,
          upToCursor,
        },
      });
      return receipt.unread.count;
    };

    // Three replies to a Bot nobody is reading: three, not one.
    for (const index of [1, 2, 3]) await say(index);
    const away = await unreadRpc(name).readUnread(identity);
    expect(away).toMatchObject({ count: 3, unread: true });

    // Opening the chat is one command and it clears all three.
    expect(await read(away.lastActivityCursor!, "open")).toBe(0);

    // Now the chat is open. Each further reply counts exactly one against the
    // cursor, and the receipt the focused client sends puts it straight back
    // to zero — durably, so the reload and the second tab agree.
    for (const index of [4, 5]) {
      await say(index);
      const after = await unreadRpc(name).readUnread(identity);
      expect(after).toMatchObject({ count: 1, unread: true });
      expect(await read(after.lastActivityCursor!, `read-${index}`)).toBe(0);
      await evictDurableObject(stub);
      expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
        count: 0,
        unread: false,
      });
    }

    // And a reply that arrives after the User has looked away is news again.
    await say(6);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 1,
      unread: true,
    });
  });

  test("recovering an interrupted Turn does not count it twice", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-recovery-user-${suffix}`,
      botId: `unread-recovery-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);

    await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt: "2026-08-31T00:00:00.000Z",
        text: "hello",
      },
    });
    const before = await unreadRpc(name).readUnread(identity);
    expect(before).toMatchObject({
      count: 1,
      lastMessage: { text: "Ollama reply", role: "assistant" },
    });

    // Put the settled Turn back where an eviction mid-flight leaves one: an
    // active run, still `running`, with its durable events already recorded.
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get("run:run-1")) as Record<
        string,
        unknown
      >;
      const { responseText: _responseText, ...interrupted } = stored;
      await state.storage.put({
        "run:run-1": { ...interrupted, status: "running", phase: "executing" },
        "active-run": "run-1",
      });
    });

    // `listRuns` recovers the active run before it projects anything, which is
    // the production path a returning client takes.
    await unreadRpc(name).listRuns({
      ...identity,
      query: { schemaVersion: 1 },
    });

    const after = await unreadRpc(name).readUnread(identity);
    expect(after).toMatchObject({ count: 1 });
    expect(after.lastActivityCursor).toBe(before.lastActivityCursor);
    expect(after.lastMessage).toEqual(before.lastMessage);
  });

  // A row's working mark is the chat's, and the open chat draws it for the
  // Turn its transcript shows running. A Routine firing runs in its own
  // Session and shows nothing; a message sent while it runs is the newest
  // Turn but waits behind it, and the chat draws that one queued.
  test("the row's working mark follows the Turn the chat shows running", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `unread-working-user-${suffix}`,
      botId: `unread-working-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const working = async () =>
      (await unreadRpc(name).readUnread(identity)).working ?? false;

    await bot(name).run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt: new Date().toISOString(),
        text: "hello",
      },
    });
    expect(
      await unreadRpc(name).executeRoutineCommand({
        ...identity,
        command: {
          schemaVersion: 1,
          botId: identity.botId,
          type: "routine/create",
          commandId: `create-${suffix}`,
          routineId: "triage",
          name: "Inbox triage",
          prompt: "Check the inbox.",
          trigger: { kind: "webhook" },
        },
      }),
    ).toMatchObject({ status: "applied" });
    expect(
      await unreadRpc(name).executeRoutineCommand({
        ...identity,
        command: {
          schemaVersion: 1,
          botId: identity.botId,
          type: "routine/run",
          commandId: `run-${suffix}`,
          routineId: "triage",
        },
      }),
    ).toMatchObject({ status: "fired" });
    // The firing is a durable record the alarm drains, not a timer.
    await evictDurableObject(bot(name));
    await runDurableObjectAlarm(bot(name));

    // A silent firing in flight, and the newest Turn the Bot has.
    const firing = (await newestRunId(name))!;
    await reopen(name, firing);
    await markActive(name, firing);
    expect(await storedRun(name, firing)).toMatchObject({
      status: "running",
      sessionId: "routine:triage",
      admission: { turnType: "automation" },
    });
    expect(await working()).toBe(false);

    // A chat Turn queued behind it: newest, live, and still not running.
    await markActive(name, undefined);
    await bot(name).run({
      ...identity,
      command: {
        runId: "run-2",
        sessionId: name,
        acceptedAt: new Date().toISOString(),
        text: "still there?",
      },
    });
    expect(await newestRunId(name)).toBe("run-2");
    await reopen(name, "run-2");
    await markActive(name, firing);
    expect(await storedRun(name, "run-2")).toMatchObject({
      status: "running",
    });
    expect(await working()).toBe(false);

    // Its turn comes: now the chat shows it running, and so does the row.
    await markActive(name, "run-2");
    expect(await working()).toBe(true);
  });
});

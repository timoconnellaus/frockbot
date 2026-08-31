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
// The Bot here has notifications disabled (every new Bot does), which makes it
// the muted case: the intent is suppressed, the unread cursor still advances.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

interface UnreadRpc {
  readUnread(input: unknown): Promise<{
    botId: string;
    count: number;
    capped: boolean;
    unread: boolean;
    manuallyUnread: boolean;
    lastActivityCursor?: string;
  }>;
  executeUnreadCommand(input: unknown): Promise<{
    status: string;
    unread: { count: number; unread: boolean; manuallyUnread: boolean };
  }>;
  listRuns(input: unknown): Promise<{ runs: unknown[] }>;
}

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function unreadRpc(name: string): UnreadRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(name) as unknown as UnreadRpc;
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
    // A muted Bot: `notifications.enabled` is false on every new Bot, and the
    // badge advanced anyway.
    expect(settled).toMatchObject({ count: 2, capped: false, unread: true });
    expect(settled.lastActivityCursor).toContain("run-index:");

    // THE EVICTION. The count is derived from durable state, not from anything
    // the object was holding.
    await evictDurableObject(stub);
    expect(await unreadRpc(name).readUnread(identity)).toMatchObject({
      count: 2,
      unread: true,
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
      unread: { count: 0, unread: false },
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
    expect(before).toMatchObject({ count: 1 });

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
  });
});

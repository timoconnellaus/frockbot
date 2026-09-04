// Permanent Bot deletion against the real Durable Objects.
//
// The claims a Bun double cannot make, because every one of them is a claim
// about the deployed pair of objects:
//
//  1. The Bot Durable Object's storage really is empty afterwards. Not "the
//     keys this test happens to know about" — every key, listed back from the
//     object itself, with only the tombstone left standing.
//  2. The alarm is gone. A Routine armed one; a deleted Bot must not wake.
//  3. The User's Bot list, its lifecycle list and its unread fan-out all stop
//     showing the Bot immediately, in the same call that deleted it.
//  4. A Turn sent afterwards is refused — 404, because the registration is
//     genuinely gone — rather than quietly re-creating the Bot from its own
//     empty storage.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { entryFailureStatusV1 } from "../src/entry-boundary.ts";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

function bot(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

function user(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

interface BotRpc {
  readUnread(input: unknown): Promise<{ count: number }>;
  executeRoutineCommand(input: unknown): Promise<{ status: string }>;
  listRoutines(input: unknown): Promise<{ routines: unknown[] }>;
}

function botRpc(userId: string, botId: string): BotRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(userId, botId) as unknown as BotRpc;
}

interface UserRpc {
  listBots(input: unknown): Promise<{ bots: Array<{ botId: string }> }>;
  listBotLifecycles(input: unknown): Promise<{
    lifecycles: Array<{ botId: string; status: string }>;
  }>;
  executeBotLifecycle(input: unknown): Promise<{
    status: string;
    lifecycle: { botId: string; status: string };
  }>;
}

function userRpc(userId: string): UserRpc {
  // SAFETY: as above, for the User Durable Object's Flock RPCs.
  return user(userId) as unknown as UserRpc;
}

describe("deleting a Bot in Workerd", () => {
  test("tears the Bot Durable Object down and drops it from the User", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `delete-user-${suffix}`,
      botId: `delete-bot-${suffix}`,
    };
    // A sibling, so the assertions are about this Bot leaving rather than
    // about the account emptying.
    const sibling = {
      schemaVersion: 1 as const,
      userId: identity.userId,
      botId: `keep-bot-${suffix}`,
    };
    await provisionBot(identity);
    await provisionSiblingBot(sibling, 1);
    const envelope = identity;
    const stub = bot(identity.userId, identity.botId);

    // A transcript.
    const turn = await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: "2026-09-04T00:00:00.000Z",
        text: "hello",
      },
    });
    expect(turn.text).toBe("Ollama reply");
    expect(
      await botRpc(identity.userId, identity.botId).readUnread(identity),
    ).toMatchObject({ count: 1 });

    // And a Routine, which is what arms this object's alarm.
    expect(
      await botRpc(identity.userId, identity.botId).executeRoutineCommand({
        ...envelope,
        command: {
          schemaVersion: 1,
          type: "routine/create",
          commandId: `routine-${suffix}`,
          botId: identity.botId,
          routineId: "brief",
          name: "Morning brief",
          prompt: "Summarize overnight email.",
          schedule: "0 7 * * *",
          timezone: "Australia/Sydney",
        },
      }),
    ).toMatchObject({ status: "applied" });

    const before = await runInDurableObject(stub, async (_instance, state) => ({
      keys: (await state.storage.list()).size,
      alarm: await state.storage.getAlarm(),
    }));
    expect(before.keys).toBeGreaterThan(1);
    expect(before.alarm).not.toBeNull();

    const receipt = await userRpc(identity.userId).executeBotLifecycle({
      schemaVersion: 1,
      userId: identity.userId,
      command: {
        schemaVersion: 1,
        type: "bot/delete",
        commandId: `delete-${suffix}`,
        botId: identity.botId,
      },
    });
    expect(receipt).toMatchObject({
      status: "applied",
      lifecycle: { botId: identity.botId, status: "deleted" },
    });

    // 1 and 2: nothing but the tombstone and the receipt that proves it, and
    // no alarm to wake a Bot that no longer exists.
    const after = await runInDurableObject(stub, async (_instance, state) => ({
      keys: [...(await state.storage.list()).keys()].sort(),
      alarm: await state.storage.getAlarm(),
    }));
    expect(after.keys).toEqual([
      `flock:lifecycle-receipt:delete-${suffix}`,
      "flock:lifecycle:v1",
    ]);
    expect(after.alarm).toBeNull();

    // 3: the sidebar, the lifecycle list and the unread fan-out all read the
    // User's directory, and the Bot is out of it.
    const listed = await userRpc(identity.userId).listBots({
      schemaVersion: 1,
      userId: identity.userId,
    });
    expect(listed.bots.map((entry) => entry.botId)).toEqual([sibling.botId]);
    const lifecycles = await userRpc(identity.userId).listBotLifecycles({
      schemaVersion: 1,
      userId: identity.userId,
    });
    expect(lifecycles.lifecycles.map((entry) => entry.botId)).toEqual([
      sibling.botId,
    ]);

    // 4: a Turn, and the unread read the sidebar would do, are both refused.
    //
    // On the settled path the answer is 404 rather than 410, and that is the
    // stronger result: the registration is gone from the User's directory, so
    // the Bot object never even gets as far as its own tombstone. The
    // tombstone answers the crash window — the Bot torn down but the
    // registration not yet removed — and `BotDeletedError` (410) is asserted
    // over that window in `packages/plugin-flock/src/bot.test.ts`.
    for (const attempt of [
      () =>
        stub.run({
          ...identity,
          command: {
            runId: "run-2",
            sessionId: `${identity.userId}:${identity.botId}`,
            acceptedAt: "2026-09-04T00:01:00.000Z",
            text: "still there?",
          },
        }),
      () => botRpc(identity.userId, identity.botId).readUnread(identity),
    ]) {
      const failure = await attempt().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeDefined();
      expect((failure as { name?: string }).name).toBe("BotNotFoundError");
      expect(entryFailureStatusV1(failure)).toBe(404);
    }
    // The status the tombstone is owed, wherever it is the thing that answers.
    expect(entryFailureStatusV1({ name: "BotDeletedError" })).toBe(410);

    // 5: a refused Turn does not leave the object holding state again.
    expect(
      await runInDurableObject(stub, async (_instance, state) =>
        [...(await state.storage.list()).keys()].sort(),
      ),
    ).toEqual([
      `flock:lifecycle-receipt:delete-${suffix}`,
      "flock:lifecycle:v1",
    ]);

    // The sibling is untouched, and still works.
    expect(
      await bot(sibling.userId, sibling.botId).run({
        ...sibling,
        command: {
          runId: "sibling-run-1",
          sessionId: `${sibling.userId}:${sibling.botId}`,
          acceptedAt: "2026-09-04T00:02:00.000Z",
          text: "hello",
        },
      }),
    ).toMatchObject({ text: "Ollama reply" });

    // Deletion is idempotent by command id: the replay settles from the stored
    // receipt rather than reporting a Bot that is no longer registered. (A
    // *fresh* delete of an already-deleted Bot is a `BotNotFoundError`, which
    // `packages/plugin-flock/src/user.test.ts` asserts.)
    expect(
      await userRpc(identity.userId).executeBotLifecycle({
        schemaVersion: 1,
        userId: identity.userId,
        command: {
          schemaVersion: 1,
          type: "bot/delete",
          commandId: `delete-${suffix}`,
          botId: identity.botId,
        },
      }),
    ).toMatchObject({ status: "applied", lifecycle: { status: "deleted" } });
  });
});

// General, the Bot every admitted account starts with, against the real User
// and Bot Durable Objects: the claims that depend on their input gates,
// transactions, eviction and tombstones rather than on a Bun double.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { randomAvatarAppearanceV1 } from "@frockbot/app/flock/shared";

interface UserRpc {
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  listBots(input: unknown): Promise<{
    revision: number;
    bots: Array<{ botId: string; initialName: string }>;
  }>;
  listBotLifecycles(input: unknown): Promise<{
    lifecycles: Array<{ botId: string; status: string }>;
  }>;
  readFlockBootstrap(input: unknown): Promise<{ generalBotId: string | null }>;
  createBot(input: unknown): Promise<{ status: string }>;
  executeBotLifecycle(input: unknown): Promise<{
    status: string;
    lifecycle: { botId: string; status: string };
  }>;
}

interface BotRpc {
  run(input: unknown): Promise<{ text: string }>;
  readConfiguration(input: unknown): Promise<{ profile: { name: string } }>;
}

function user(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

function userRpc(userId: string): UserRpc {
  // SAFETY: the generated stub types for these RPCs are too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return user(userId) as unknown as UserRpc;
}

function botRpc(userId: string, botId: string): BotRpc {
  // SAFETY: as above, for the Bot Durable Object.
  return env.BOT_STATES.getByName(`${userId}:${botId}`) as unknown as BotRpc;
}

const GENERAL_ID = /^general-[0-9a-f]{16}$/;

/**
 * Forget that this instance already provisioned, so the next request decides
 * again from durable state alone, as a cold instance would. A delete leaves
 * references the test harness cannot evict past.
 */
async function forgetBootstrap(userId: string): Promise<void> {
  await runInDurableObject(user(userId), (instance) => {
    // SAFETY: the memo is private; clearing it is what an eviction does.
    (instance as unknown as { bootstrapped: boolean }).bootstrapped = false;
  });
}

/** A Turn on the ambient Frock AI default, which a fresh account can run. */
async function reply(userId: string, botId: string): Promise<string> {
  const runId = `run-${crypto.randomUUID()}`;
  return (
    await botRpc(userId, botId).run({
      schemaVersion: 1,
      userId,
      botId,
      command: {
        runId,
        sessionId: `${userId}:${botId}`,
        acceptedAt: "2026-09-14T00:00:00.000Z",
        text: "Say hello.",
      },
    })
  ).text;
}

async function deleteBot(userId: string, botId: string): Promise<void> {
  expect(
    await userRpc(userId).executeBotLifecycle({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "bot/delete",
        commandId: `delete-${botId}-${crypto.randomUUID()}`,
        botId,
      },
    }),
  ).toMatchObject({ status: "applied", lifecycle: { status: "deleted" } });
}

describe("General in Workerd", () => {
  test("an account is given General when its identity is first proven, not by a directory read", async () => {
    const userId = `general-admitted-${crypto.randomUUID()}`;
    // The first thing this account does is read its settings.
    await userRpc(userId).readConfiguration({ schemaVersion: 1, userId });
    const stored = await runInDurableObject(user(userId), (_, state) =>
      state.storage.get<{
        bots: Array<{ botId: string; initialName: string }>;
      }>("flock:directory:v1"),
    );
    expect(stored?.bots).toHaveLength(1);
    expect(stored?.bots[0]).toMatchObject({ initialName: "General" });
    expect(stored?.bots[0]!.botId).toMatch(GENERAL_ID);
  });

  test("racing first requests provision exactly one General, which survives eviction and replies", async () => {
    const userId = `general-race-${crypto.randomUUID()}`;
    const rpc = userRpc(userId);
    const envelope = { schemaVersion: 1, userId };
    const [, directory, lifecycles, bootstrap] = await Promise.all([
      rpc.readConfiguration(envelope),
      rpc.listBots(envelope),
      rpc.listBotLifecycles(envelope),
      rpc.readFlockBootstrap(envelope),
      rpc.listBots(envelope),
    ]);
    const generalBotId = bootstrap.generalBotId!;
    expect(generalBotId).toMatch(GENERAL_ID);
    expect(directory.bots.map((bot) => bot.botId)).toEqual([generalBotId]);
    expect(lifecycles.lifecycles.map((entry) => entry.botId)).toEqual([
      generalBotId,
    ]);

    await evictDurableObject(user(userId));
    expect(await rpc.listBots(envelope)).toMatchObject({
      revision: 1,
      bots: [{ botId: generalBotId, initialName: "General" }],
    });
    expect(await rpc.readFlockBootstrap(envelope)).toEqual({
      schemaVersion: 1,
      generalBotId,
    });

    // General is an ordinary Bot: its own object materializes, holds its
    // profile, and answers a Turn.
    expect(await reply(userId, generalBotId)).toBe("Frock AI reply");
    expect(
      await botRpc(userId, generalBotId).readConfiguration({
        schemaVersion: 1,
        userId,
        botId: generalBotId,
      }),
    ).toMatchObject({ profile: { name: "General" } });
  });

  test("deleting General does not bring it back", async () => {
    const userId = `general-deleted-${crypto.randomUUID()}`;
    const rpc = userRpc(userId);
    const envelope = { schemaVersion: 1, userId };
    const { generalBotId } = await rpc.readFlockBootstrap(envelope);
    await deleteBot(userId, generalBotId!);

    await forgetBootstrap(userId);
    expect((await rpc.listBots(envelope)).bots).toEqual([]);
    expect((await rpc.listBotLifecycles(envelope)).lifecycles).toEqual([]);
    expect(await rpc.readFlockBootstrap(envelope)).toEqual({
      schemaVersion: 1,
      generalBotId: null,
    });
  });

  test("an account that deleted a Bot called `general` before bootstrap gets a fresh General that works", async () => {
    const userId = `general-tombstone-${crypto.randomUUID()}`;
    const rpc = userRpc(userId);
    const envelope = { schemaVersion: 1, userId };
    // A Bot with the old fixed id, run once and deleted: its Durable Object
    // now holds a tombstone for ever.
    const first = await rpc.readFlockBootstrap(envelope);
    await rpc.createBot({
      ...envelope,
      command: {
        schemaVersion: 1,
        type: "bot/create",
        commandId: `create-legacy-${userId}`,
        expectedRevision: (await rpc.listBots(envelope)).revision,
        botId: "general",
        name: "General",
      },
    });
    expect(await reply(userId, "general")).toBe("Frock AI reply");
    await deleteBot(userId, "general");
    await deleteBot(userId, first.generalBotId!);
    // What the account looked like before bootstrap existed: no Bots and no
    // marker, with the tombstoned `general` object still out there.
    await runInDurableObject(user(userId), (_, state) =>
      state.storage.delete("flock:bootstrap:v1"),
    );
    await forgetBootstrap(userId);

    const directory = await rpc.listBots(envelope);
    expect(directory.bots).toHaveLength(1);
    const generalBotId = directory.bots[0]!.botId;
    expect(generalBotId).toMatch(GENERAL_ID);
    expect(generalBotId).not.toBe(first.generalBotId);
    expect(await rpc.readFlockBootstrap(envelope)).toEqual({
      schemaVersion: 1,
      generalBotId,
    });
    expect(await reply(userId, generalBotId)).toBe("Frock AI reply");
    // And the tombstone is untouched: the old Bot stays gone.
    await expect(reply(userId, "general")).rejects.toThrow();
  });

  test("an account that already owns Bots is not given General", async () => {
    const userId = `general-existing-${crypto.randomUUID()}`;
    // Bots written before this account's identity was ever proven here, as
    // an account from before bootstrap existed holds them.
    await runInDurableObject(user(userId), async (_, state) => {
      await state.storage.put("flock:directory:v1", {
        schemaVersion: 1,
        revision: 3,
        bots: [
          {
            schemaVersion: 1,
            botId: "existing-bot",
            registeredAt: "2026-09-01T00:00:00.000Z",
            initialName: "General",
            avatar: randomAvatarAppearanceV1(() => 0),
          },
        ],
      });
      await state.storage.put("flock:lifecycle:existing-bot", {
        schemaVersion: 1,
        botId: "existing-bot",
        status: "active",
        revision: 0,
      });
    });
    const rpc = userRpc(userId);
    const envelope = { schemaVersion: 1, userId };
    expect(await rpc.listBots(envelope)).toMatchObject({
      revision: 3,
      bots: [{ botId: "existing-bot", initialName: "General" }],
    });
    // A Bot named General is still not the bootstrap one.
    expect(await rpc.readFlockBootstrap(envelope)).toEqual({
      schemaVersion: 1,
      generalBotId: null,
    });
  });
});

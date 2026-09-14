// General, the Bot every new account starts with, against the real User
// Durable Object: the claims that depend on its input gates, its transactions
// and its eviction rather than on a Bun double.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { GENERAL_BOT_ID_V1 } from "@frockbot/app/flock/shared";
import { provisionBot } from "./provision-bot.ts";

interface UserRpc {
  listBots(input: unknown): Promise<{
    revision: number;
    bots: Array<{ botId: string; initialName: string }>;
  }>;
  listBotLifecycles(input: unknown): Promise<{
    lifecycles: Array<{ botId: string; status: string }>;
  }>;
  executeBotLifecycle(input: unknown): Promise<{
    status: string;
    lifecycle: { botId: string; status: string };
  }>;
}

function user(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

function userRpc(userId: string): UserRpc {
  // SAFETY: the generated stub type for the Flock RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return user(userId) as unknown as UserRpc;
}

describe("General in Workerd", () => {
  test("racing first reads provision exactly one General, which survives eviction", async () => {
    const userId = `general-new-${crypto.randomUUID()}`;
    const rpc = userRpc(userId);
    const envelope = { schemaVersion: 1, userId };
    const reads = await Promise.all([
      rpc.listBots(envelope),
      rpc.listBotLifecycles(envelope),
      rpc.listBots(envelope),
      rpc.listBotLifecycles(envelope),
      rpc.listBots(envelope),
    ]);
    for (const read of reads) {
      const ids =
        "bots" in read
          ? read.bots.map((bot) => bot.botId)
          : read.lifecycles.map((entry) => entry.botId);
      expect(ids).toEqual([GENERAL_BOT_ID_V1]);
    }

    await evictDurableObject(user(userId));
    expect(await rpc.listBots(envelope)).toMatchObject({
      revision: 1,
      bots: [{ botId: GENERAL_BOT_ID_V1, initialName: "General" }],
    });
  });

  test("deleting General does not bring it back", async () => {
    const userId = `general-deleted-${crypto.randomUUID()}`;
    const rpc = userRpc(userId);
    const envelope = { schemaVersion: 1, userId };
    await rpc.listBots(envelope);
    expect(
      await rpc.executeBotLifecycle({
        ...envelope,
        command: {
          schemaVersion: 1,
          type: "bot/delete",
          commandId: `delete-general-${userId}`,
          botId: GENERAL_BOT_ID_V1,
        },
      }),
    ).toMatchObject({
      status: "applied",
      lifecycle: { botId: GENERAL_BOT_ID_V1, status: "deleted" },
    });

    // Both reads provision when the marker is missing, so an empty answer
    // from each is the proof; the marker's durability across eviction is the
    // first test's.
    expect((await rpc.listBots(envelope)).bots).toEqual([]);
    expect((await rpc.listBotLifecycles(envelope)).lifecycles).toEqual([]);
    expect((await rpc.listBots(envelope)).bots).toEqual([]);
  });

  test("an account that already owns a Bot is not given a second one", async () => {
    const userId = `general-existing-${crypto.randomUUID()}`;
    await provisionBot({ userId, botId: "existing-bot" });
    const listed = await userRpc(userId).listBots({ schemaVersion: 1, userId });
    expect(listed.bots.map((bot) => bot.botId)).toEqual(["existing-bot"]);
    expect(listed.bots[0]!.initialName).toBe("Workerd Bot");
  });
});

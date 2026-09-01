// Channels against real workerd Durable Objects.
//
// Three claims, and none of them is provable against a Map:
//
//  1. A post writes the message and one `ChannelDeliveryV1` per recipient, and
//     both survive eviction — "Persist enough state to resume safely after
//     Durable Object eviction" is not a property of the object staying
//     resident.
//  2. The same message delivered twice admits exactly one `channel` Turn. The
//     run id is derived from the message id, so the kernel's own Turn
//     idempotency is what refuses the second, not a check anyone remembered.
//  3. The sender is never a recipient of its own post.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { pairChannelIdV1 } from "@frockbot/plugin-channels/records";
import type { ChannelInputV1 } from "@frockbot/plugin-channels/shared";
import { provisionBot } from "./provision-bot.ts";

const WRITER = {
  kind: "user" as const,
};

function channels(name: string) {
  return env.CHANNEL_STORE.getByName(name);
}

function bot(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

interface StoredRunProbe {
  runId: string;
  admission?: { turnType?: string; origin?: { channelId?: string } };
}

async function storedRuns(
  userId: string,
  botId: string,
): Promise<StoredRunProbe[]> {
  return runInDurableObject(bot(userId, botId), async (_instance, state) => [
    ...(await state.storage.list<StoredRunProbe>({ prefix: "run:" })).values(),
  ]);
}

/**
 * The alarm a delivery arms is due immediately, so miniflare may already have
 * fired it. Driving it explicitly makes the test deterministic either way, and
 * the poll covers the case where it fired a moment before this asked.
 */
async function settleChannelTurns(
  userId: string,
  botId: string,
): Promise<StoredRunProbe[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await runDurableObjectAlarm(bot(userId, botId));
    const runs = (await storedRuns(userId, botId)).filter(
      (run) => run.admission?.turnType === "channel",
    );
    if (
      runs.length > 0 &&
      (await pendingChannelKeys(userId, botId)).length === 0
    ) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await storedRuns(userId, botId)).filter(
    (run) => run.admission?.turnType === "channel",
  );
}

async function pendingChannelKeys(
  userId: string,
  botId: string,
): Promise<string[]> {
  return runInDurableObject(bot(userId, botId), async (_instance, state) => [
    ...(
      await state.storage.list<unknown>({ prefix: "channel-pending:" })
    ).keys(),
  ]);
}

describe("the Channel authority in Workerd", () => {
  test("a post and its deliveries survive Durable Object eviction", async () => {
    const name = `channel-store-${crypto.randomUUID()}`;
    const store = channels(name);
    expect(
      await store.execute({
        command: {
          schemaVersion: 1,
          type: "channel/create",
          commandId: "open",
          botId: "alpha",
          channelId: "standup",
          name: "Standup",
          members: ["alpha", "beta", "gamma"],
        },
        writer: WRITER,
      }),
    ).toMatchObject({ status: "applied" });

    const posted = await store.execute({
      command: {
        schemaVersion: 1,
        type: "channel/post",
        commandId: "say-1",
        botId: "alpha",
        channelId: "standup",
        text: "Morning, both.",
      },
      writer: WRITER,
    });
    expect(posted).toMatchObject({
      status: "posted",
      // The sender is not owed its own post.
      recipients: ["beta", "gamma"],
    });
    if (posted.status !== "posted") throw new Error("expected a post");

    // THE EVICTION. Nothing is held in memory on the object's behalf.
    await evictDurableObject(channels(name));

    const deliveries = await channels(name).deliveries(
      posted.message.messageId,
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.botId)).toEqual([
      "beta",
      "gamma",
    ]);
    expect(deliveries.every((delivery) => delivery.state === "pending")).toBe(
      true,
    );
    expect((await channels(name).thread("standup")).messages).toMatchObject([
      { text: "Morning, both.", senderBotId: "alpha", seq: 0, hop: 1 },
    ]);

    // The command receipt is durable too: a retried post replays it rather
    // than writing a second message.
    expect(
      await channels(name).execute({
        command: {
          schemaVersion: 1,
          type: "channel/post",
          commandId: "say-1",
          botId: "alpha",
          channelId: "standup",
          text: "Morning, both.",
        },
        writer: WRITER,
      }),
    ).toEqual(posted);
    expect((await channels(name).thread("standup")).messages).toHaveLength(1);
  });

  test("a delivery marked admitted keeps the run it first named", async () => {
    const name = `channel-store-${crypto.randomUUID()}`;
    const store = channels(name);
    await store.execute({
      command: {
        schemaVersion: 1,
        type: "channel/create",
        commandId: "open",
        botId: "alpha",
        channelId: "standup",
        name: "Standup",
        members: ["alpha", "beta"],
      },
      writer: WRITER,
    });
    const posted = await store.execute({
      command: {
        schemaVersion: 1,
        type: "channel/post",
        commandId: "say-1",
        botId: "alpha",
        channelId: "standup",
        text: "Morning.",
      },
      writer: WRITER,
    });
    if (posted.status !== "posted") throw new Error("expected a post");
    await store.markAdmitted(posted.message.messageId, "beta", "ch-run-1");
    await evictDurableObject(channels(name));
    await channels(name).markAdmitted(
      posted.message.messageId,
      "beta",
      "ch-run-2",
    );
    expect(
      await channels(name).deliveries(posted.message.messageId),
    ).toMatchObject([{ state: "admitted", runId: "ch-run-1" }]);
  });
});

describe("delivery into a Bot Durable Object", () => {
  test("a redelivered message admits one Turn and no more", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const identity = {
      userId: `channel-user-${suffix}`,
      botId: `channel-bot-${suffix}`,
    };
    await provisionBot(identity);

    const messageId = `cm-${suffix}`;
    const delivery: ChannelInputV1 = {
      schemaVersion: 1,
      channelId: pairChannelIdV1(identity.botId, `peer-${suffix}`),
      channelName: "A pair",
      messageId,
      botId: identity.botId,
      senderBotId: `peer-${suffix}`,
      text: "Anything for me?",
      hop: 1,
      at: new Date().toISOString(),
      history: [],
    };
    const envelope = {
      schemaVersion: 1 as const,
      userId: identity.userId,
      botId: identity.botId,
      delivery,
    };

    const first = await bot(
      identity.userId,
      identity.botId,
    ).deliverChannelInput(envelope);
    // The delivery is written down and answered for; the run it will be
    // admitted under is already determined, because it is the message id.
    expect(first).toMatchObject({ messageId, runId: `ch-${messageId}` });

    // A second delivery of the same message, racing the first.
    await bot(identity.userId, identity.botId).deliverChannelInput(envelope);

    // The alarm the delivery armed is what admits the Turn.
    const channelRuns = await settleChannelTurns(
      identity.userId,
      identity.botId,
    );
    // The debt was settled, not merely recorded.
    expect(await pendingChannelKeys(identity.userId, identity.botId)).toEqual(
      [],
    );

    // Exactly one run, and it is a `channel` Turn naming the Channel.
    expect(channelRuns).toHaveLength(1);
    expect(channelRuns[0]).toMatchObject({
      runId: `ch-${messageId}`,
      admission: {
        turnType: "channel",
        origin: { kind: "channel", fireId: messageId, trigger: "integration" },
      },
    });

    // A delivery that arrives after the Turn has run cannot run it again: the
    // run id is the message id, so the kernel refuses the second admission.
    await bot(identity.userId, identity.botId).deliverChannelInput(envelope);
    await settleChannelTurns(identity.userId, identity.botId);
    expect(
      (await storedRuns(identity.userId, identity.botId)).filter(
        (run) => run.admission?.turnType === "channel",
      ),
    ).toHaveLength(1);
  });
});

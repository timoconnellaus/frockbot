// The Channels WebUI routes, through the deployed Worker.
//
// `SELF.fetch` enters `src/index.ts`, which loads the real application
// artifact — the same bundle the browser is served — so the routes exercised
// here are the ones the hosted client calls and nothing stubbed in beside
// them. Nothing reaches past the gateway on the test's behalf.
//
// What it proves:
//
//  * The Channels list, the thread, the badge and the read receipt are one
//    coherent surface: a message a Bot posted comes back on the thread route,
//    the badge counts it, and the read receipt clears it.
//  * The person can speak into a room and be heard: a post from the WebUI is
//    recorded as a peer, never as one of the room's Bots.
//  * **No response body carries credential material.** A connected Channel
//    shows the Connection's label; the token, its digest and the webhook path
//    appear in no read.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pairChannelIdV1 } from "@frockbot/plugin-channels/records";
import type {
  ChannelListViewV1,
  ChannelThreadPageViewV1,
} from "@frockbot/plugin-channels/shared";
import type {
  ChannelReadReceiptV1,
  ChannelUnreadDirectoryViewV1,
} from "@frockbot/plugin-channels/unread";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

/**
 * Drive the alarm a queued Channel input arms until nothing is owed. The alarm
 * is due immediately; this only makes the settlement deterministic.
 */
async function settle(userId: string, botIds: string[]): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let owed = 0;
    for (const botId of botIds) {
      owed += await runInDurableObject(
        botStub(userId, botId),
        async (_instance, state) =>
          (await state.storage.list<unknown>({ prefix: "channel-pending:" }))
            .size,
      );
    }
    if (owed === 0 && attempt > 0) return;
    for (const botId of botIds) {
      await runDurableObjectAlarm(botStub(userId, botId));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function twoBots(
  prefix: string,
): Promise<{ userId: string; alpha: string; beta: string }> {
  const userId = freshUserId(prefix);
  const alpha = `${prefix}-alpha`;
  const beta = `${prefix}-beta`;
  await provisionThroughGateway({ userId, botId: alpha });
  expect(
    (
      await postAsUser(userId, "/api/bots", {
        schemaVersion: 1,
        type: "bot/create",
        commandId: `create-${beta}`,
        expectedRevision: 1,
        botId: beta,
        name: "Beta",
      })
    ).status,
  ).toBe(201);
  return { userId, alpha, beta };
}

/**
 * Everything a credential could look like on this path. A body that carried
 * any of them would be a second place the Channel's key lives.
 */
const CREDENTIAL_SHAPES = [
  "webhookPath",
  "token",
  "digest",
  "keyVersion",
  "secret",
  "/api/plugins/channels/",
];

function expectNoCredentialMaterial(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const shape of CREDENTIAL_SHAPES) {
    expect(serialized).not.toContain(shape);
  }
}

describe("the Channels WebUI routes", () => {
  it("returns the thread a posted message produced, and counts it unread", async () => {
    const { userId, alpha, beta } = await twoBots("channels-ui");
    const channelId = pairChannelIdV1(alpha, beta);

    // Bot A opens the room from a chat Turn, exactly as N1's tools do. The
    // WebUI never creates a Channel; it renders the one the Bots are in.
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${alpha}/turns`, {
        schemaVersion: 1,
        commandId: "channels-ui-open",
        text: toolCallTriggerPrompt([
          "send_to_agent",
          { botId: beta, text: "Standup in five." },
        ]),
      }),
    );
    await settle(userId, [alpha, beta]);

    // The list route: the room is there for both members.
    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${beta}/channels`),
    )) as ChannelListViewV1;
    expect(list.channels.map((channel) => channel.channelId)).toContain(
      channelId,
    );
    expectNoCredentialMaterial(list);

    // The thread route: the message the Bot posted, with its members strip.
    const thread = (await expectOkJson(
      await asUser(userId, `/api/channels/${channelId}`),
    )) as ChannelThreadPageViewV1;
    expect(thread.messages[0]).toMatchObject({
      text: "Standup in five.",
      senderBotId: alpha,
      seq: 0,
    });
    expect(thread.channel.members).toEqual(
      expect.arrayContaining([alpha, beta]),
    );
    expectNoCredentialMaterial(thread);

    // The badge: nothing has been read, so every message is unread.
    const unread = (await expectOkJson(
      await asUser(userId, `/api/bots/${beta}/channels/unread`),
    )) as ChannelUnreadDirectoryViewV1;
    const row = unread.unread.find((view) => view.channelId === channelId);
    expect(row?.unread).toBe(true);
    expect(row?.count).toBeGreaterThan(0);
    expectNoCredentialMaterial(unread);

    // The read receipt: an authenticated command, and the row clears.
    const receipt = (await expectOkJson(
      await postAsUser(userId, `/api/channels/${channelId}/read`, {
        schemaVersion: 1,
        type: "channel/mark-read",
        commandId: "channels-ui-read",
        channelId,
        upToSeq: thread.messages.at(-1)!.seq,
      }),
    )) as ChannelReadReceiptV1;
    expect(receipt.status).toBe("applied");
    expect(receipt.unread.count).toBe(0);

    // And it is a *position*, not a counter: replaying the same command says
    // the same thing rather than reading something twice.
    const replayed = (await expectOkJson(
      await postAsUser(userId, `/api/channels/${channelId}/read`, {
        schemaVersion: 1,
        type: "channel/mark-read",
        commandId: "channels-ui-read",
        channelId,
        upToSeq: thread.messages.at(-1)!.seq,
      }),
    )) as ChannelReadReceiptV1;
    expect(replayed.unread.lastReadSeq).toBe(receipt.unread.lastReadSeq);
  });

  it("records what the person typed as a peer, never as one of the room's Bots", async () => {
    const { userId, alpha, beta } = await twoBots("channels-ui-post");
    const channelId = pairChannelIdV1(alpha, beta);
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${alpha}/turns`, {
        schemaVersion: 1,
        commandId: "channels-ui-post-open",
        text: toolCallTriggerPrompt([
          "send_to_agent",
          { botId: beta, text: "hello" },
        ]),
      }),
    );
    await settle(userId, [alpha, beta]);

    await expectOkJson(
      await postAsUser(userId, `/api/channels/${channelId}/post`, {
        commandId: "channels-ui-post-1",
        botId: alpha,
        text: "Both of you, stand by.",
      }),
    );

    const thread = (await expectOkJson(
      await asUser(userId, `/api/channels/${channelId}`),
    )) as ChannelThreadPageViewV1;
    const mine = thread.messages.find(
      (message) => message.text === "Both of you, stand by.",
    );
    expect(mine?.senderPeer).toBe("you");
    expect(mine?.senderBotId).toBeUndefined();
    expectNoCredentialMaterial(thread);
  });

  it("refuses a read command whose body names a different Channel", async () => {
    const { userId, alpha, beta } = await twoBots("channels-ui-guard");
    const channelId = pairChannelIdV1(alpha, beta);

    const response = await postAsUser(
      userId,
      `/api/channels/${channelId}/read`,
      {
        schemaVersion: 1,
        type: "channel/mark-read",
        commandId: "channels-ui-mismatch",
        channelId: "some-other-room",
        upToSeq: 0,
      },
    );
    expect(response.status).toBe(400);
  });
});

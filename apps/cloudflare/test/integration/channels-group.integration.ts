// A group Channel end to end, through the deployed Worker.
//
// `SELF.fetch` enters `src/index.ts`, the gateway loads the real artifact, and
// two Bots of one User run real Turns on the outbound model stub. Nothing here
// reaches past the gateway on the test's behalf except the assertions, which
// read the durable records the product wrote.
//
// What it proves:
//
//  * A chat Turn of Bot A calls `send_to_agent`, and the message is recorded in
//    the User Durable Object with a delivery for Bot B and none for Bot A.
//  * Bot B runs a **`channel`** Turn for it — its own Turn, in the Bot Durable
//    Object that is the only authority that could admit one — and that Turn is
//    absent from Bot B's visible transcript.
//  * Bot B's reply lands in the same thread, one hop further out.
//  * The cascade stops: the post at `CHANNEL_HOP_MAX + 1` is refused, durably.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_HOP_MAX,
  pairChannelIdV1,
} from "@frockbot/plugin-channels/records";
import type {
  ChannelCommandReceiptV1,
  ChannelThreadViewV1,
} from "@frockbot/plugin-channels/shared";
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

interface TurnView {
  runId: string;
  text: string;
  events: Array<{ type: string; content?: string; isError?: boolean }>;
}

interface RunView {
  runId: string;
  status: string;
  admission?: { turnType?: string };
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
}

async function chatTurn(
  userId: string,
  botId: string,
  text: string,
  commandId: string,
): Promise<TurnView> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text,
    }),
  )) as TurnView;
}

/** Every run the Bot Durable Object holds, visible or not. */
async function storedRuns(userId: string, botId: string): Promise<RunView[]> {
  return runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => [
      ...(await state.storage.list<RunView>({ prefix: "run:" })).values(),
    ],
  );
}

/** The transcript the client is shown. A `channel` Turn is not in it. */
async function visibleRuns(userId: string, botId: string): Promise<RunView[]> {
  const list = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/turns`),
  )) as { runs: RunView[] };
  return list.runs;
}

function thread(
  userId: string,
  channelId: string,
): Promise<ChannelThreadViewV1> {
  return userStub(userId).readChannelThread({
    schemaVersion: 1,
    userId,
    channelId,
  }) as Promise<ChannelThreadViewV1>;
}

/**
 * Drive the alarm that a queued Channel input arms until every Bot named has
 * nothing left owed. The alarm is due immediately, so this only makes the
 * settlement deterministic — it does not make it happen.
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

describe("a group Channel, end to end", () => {
  it("carries a message from one Bot's chat Turn into another Bot's channel Turn", async () => {
    const userId = freshUserId("channels-group");
    const alpha = "channels-alpha";
    const beta = "channels-beta";
    await provisionThroughGateway({ userId, botId: alpha });
    // The Flock's revision has moved on by one Bot.
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

    const channelId = pairChannelIdV1(alpha, beta);

    // What Bot A says to Bot B. It carries the stub's trigger for a reply, so
    // Bot B's own `channel` Turn answers into the same thread — which is the
    // whole point of the `channel` turn type existing.
    const said = toolCallTriggerPrompt([
      "send_to_agent",
      { channelId, text: "On my way." },
    ]);

    // Bot A's chat Turn calls `send_to_agent` with a bare teammate id, which
    // resolves to the implicit pair Channel.
    const posted = await chatTurn(
      userId,
      alpha,
      toolCallTriggerPrompt(["send_to_agent", { botId: beta, text: said }]),
      "channels-post-1",
    );
    const result = posted.events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({ isError: false });
    expect(result?.content).toContain(channelId);

    // The message is in the User Durable Object's log, hop 1, from Bot A.
    const first = await thread(userId, channelId);
    expect(first.messages).toMatchObject([
      { text: said, senderBotId: alpha, seq: 0, hop: 1 },
    ]);

    await settle(userId, [alpha, beta]);

    // Bot B ran a `channel` Turn, keyed by the message.
    const betaRuns = await storedRuns(userId, beta);
    const channelRuns = betaRuns.filter(
      (run) => run.admission?.turnType === "channel",
    );
    expect(channelRuns).toHaveLength(1);
    expect(channelRuns[0]).toMatchObject({
      runId: `ch-${first.messages[0]!.messageId}`,
      status: "completed",
    });

    // Bot A was never handed its own post: the only `channel` run it can have
    // is the one Bot B's reply produced, and it names Bot B's message.
    expect(
      (await storedRuns(userId, alpha))
        .filter((run) => run.admission?.turnType === "channel")
        .map((run) => run.runId),
    ).not.toContain(`ch-${first.messages[0]!.messageId}`);

    // And the Turn is not in Bot B's visible transcript, exactly as an
    // automation Turn is not.
    expect(
      (await visibleRuns(userId, beta)).map((run) => run.runId),
    ).not.toContain(channelRuns[0]!.runId);

    // Bot B's reply landed in the same thread, one hop further out, and Bot A
    // read it on a `channel` Turn of its own.
    const replied = await thread(userId, channelId);
    expect(replied.messages).toMatchObject([
      { senderBotId: alpha, seq: 0, hop: 1 },
      { text: "On my way.", senderBotId: beta, seq: 1, hop: 2 },
    ]);
    expect(
      (await storedRuns(userId, alpha)).filter(
        (run) => run.admission?.turnType === "channel",
      ),
    ).toHaveLength(1);
  });

  it("stops the cascade at the hop bound, with a recorded refusal", async () => {
    const userId = freshUserId("channels-hop");
    const alpha = "hop-alpha";
    const beta = "hop-beta";
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
    const channelId = pairChannelIdV1(alpha, beta);

    // Open the room with one ordinary post, so both Bots are members.
    await chatTurn(
      userId,
      alpha,
      toolCallTriggerPrompt(["send_to_agent", { botId: beta, text: "hello" }]),
      "hop-open",
    );
    await settle(userId, [alpha, beta]);

    // Now walk the hops the way a real cascade would, through the same command
    // path the tool uses, and watch the bound close it.
    const posts: ChannelCommandReceiptV1[] = [];
    for (let hop = 1; hop <= CHANNEL_HOP_MAX + 1; hop += 1) {
      posts.push(
        (await userStub(userId).executeChannelCommand({
          schemaVersion: 1,
          userId,
          command: {
            schemaVersion: 1,
            type: "channel/post",
            commandId: `hop-${hop}`,
            botId: hop % 2 === 1 ? alpha : beta,
            channelId,
            text: `hop ${hop}`,
            hop,
          },
          writer: { kind: "user" },
        })) as ChannelCommandReceiptV1,
      );
    }
    expect(posts.slice(0, CHANNEL_HOP_MAX).map((post) => post.status)).toEqual(
      Array.from({ length: CHANNEL_HOP_MAX }, () => "posted"),
    );
    const refused = posts.at(-1)!;
    expect(refused).toMatchObject({ status: "refused", refusal: "hop" });

    // The refusal is durable: the same command answers the same way, and the
    // message it would have written is nowhere.
    expect(
      await userStub(userId).executeChannelCommand({
        schemaVersion: 1,
        userId,
        command: {
          schemaVersion: 1,
          type: "channel/post",
          commandId: `hop-${CHANNEL_HOP_MAX + 1}`,
          botId: beta,
          channelId,
          text: `hop ${CHANNEL_HOP_MAX + 1}`,
          hop: CHANNEL_HOP_MAX + 1,
        },
        writer: { kind: "user" },
      }),
    ).toEqual(refused);
    const final = await thread(userId, channelId);
    expect(final.messages.map((message) => message.hop)).toEqual([
      1,
      1,
      2,
      CHANNEL_HOP_MAX,
    ]);
    await settle(userId, [alpha, beta]);
  });
});

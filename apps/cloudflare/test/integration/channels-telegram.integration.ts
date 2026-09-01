// An external Channel end to end, through the deployed Worker.
//
// `SELF.fetch` enters `src/index.ts`, the gateway loads the real artifact, and
// one Bot of one User answers a message that arrived from a stubbed Telegram.
//
// What it proves:
//
//  * A `telegram-bot` Connection is created through the ordinary Connection
//    route, and the bot token is validated against Telegram before it is
//    allowed to reach `ready`.
//  * Connect records an external Channel and tells Telegram where to deliver.
//  * A POST to the webhook path, carrying the token in the path *and* in
//    `X-Telegram-Bot-Api-Secret-Token`, becomes a `channel` Turn in the Bot's
//    own Durable Object — the only authority that could admit one.
//  * What that Turn said with `send_to_user` reaches Telegram as a
//    `sendMessage`, and the key is never in a response the client sees.
//  * A token this deployment did not mint is a 404, and so is a good token with
//    the wrong header.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  TELEGRAM_BAD_BOT_TOKEN,
  TELEGRAM_GOOD_BOT_TOKEN,
  TELEGRAM_LEDGER_ENDPOINT,
} from "../harness/miniflare.ts";
import type { ChannelThreadViewV1 } from "@frockbot/plugin-channels/shared";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const TELEGRAM_PACKAGE_ID = "telegram";
const TELEGRAM_CONNECTION_TYPE = "telegram-bot";

interface TelegramCall {
  method: string;
  token: "good" | "limited" | "bad" | "unknown";
  body: unknown;
}

interface RunView {
  runId: string;
  status: string;
  admission?: { turnType?: string };
}

async function ledger(): Promise<TelegramCall[]> {
  return (
    (await (await fetch(TELEGRAM_LEDGER_ENDPOINT)).json()) as {
      calls: TelegramCall[];
    }
  ).calls;
}

async function clearLedger(): Promise<void> {
  await fetch(TELEGRAM_LEDGER_ENDPOINT, { method: "DELETE" });
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
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

async function storedRuns(userId: string, botId: string): Promise<RunView[]> {
  return runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => [
      ...(await state.storage.list<RunView>({ prefix: "run:" })).values(),
    ],
  );
}

/** Drive the alarm a queued Channel input arms until nothing is owed. */
async function settle(userId: string, botId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const owed = await runInDurableObject(
      botStub(userId, botId),
      async (_instance, state) =>
        (await state.storage.list<unknown>({ prefix: "channel-pending:" }))
          .size,
    );
    if (owed === 0 && attempt > 0) return;
    await runDurableObjectAlarm(botStub(userId, botId));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function installTelegram(userId: string): Promise<void> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as {
    revision: number;
  };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-telegram",
      expectedRevision: settings.revision,
      packageId: TELEGRAM_PACKAGE_ID,
      version: "0.0.1",
    }),
  );
}

async function connectTelegram(
  userId: string,
  botId: string,
  apiKey = TELEGRAM_GOOD_BOT_TOKEN,
) {
  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: `telegram-connect-${botId}`,
      packageId: TELEGRAM_PACKAGE_ID,
      connectionTypeId: TELEGRAM_CONNECTION_TYPE,
      label: "Integration bot",
      apiKey,
    }),
  )) as { connectionId: string; status: string };
  return receipt;
}

function update(messageId: number, text: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 5150, username: "peer" },
      chat: { id: 5150, type: "private" },
      date: 1_756_000_000,
      text,
    },
  };
}

function deliver(
  webhookPath: string,
  secret: string | undefined,
  body: unknown,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${webhookPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === undefined
        ? {}
        : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: JSON.stringify(body),
  });
}

describe("an external Telegram Channel, end to end", () => {
  it("carries a Telegram message into a channel Turn and its reply back out", async () => {
    const userId = freshUserId("channels-telegram");
    const botId = "telegram-bot-a";
    await provisionThroughGateway({ userId, botId });
    await installTelegram(userId);
    await clearLedger();

    const connection = await connectTelegram(userId, botId);
    expect(connection.status).toBe("applied");
    // The key was proved against Telegram before the Connection said it worked.
    expect((await ledger()).map((call) => call.method)).toContain("getMe");

    await clearLedger();
    const connected = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/channels/telegram`, {
        schemaVersion: 1,
        commandId: "telegram-channel-1",
        connectionId: connection.connectionId,
        name: "Telegram",
      }),
    )) as {
      channel: { channelId: string; kind: string; connectionId: string };
      webhookPath: string;
    };

    expect(connected.channel.kind).toBe("external");
    expect(connected.channel.connectionId).toBe(connection.connectionId);
    const token = decodeURIComponent(connected.webhookPath.split("/").at(-1)!);
    const registration = (await ledger()).find(
      (call) => call.method === "setWebhook",
    );
    expect(registration).toBeDefined();
    expect(registration!.body).toMatchObject({ secret_token: token });
    // The bot token itself never appears in what the client was handed.
    expect(JSON.stringify(connected)).not.toContain(TELEGRAM_GOOD_BOT_TOKEN);

    await clearLedger();
    // The peer's message carries the stub's trigger, so the Bot's `channel`
    // Turn answers with `send_to_user` — the tool the connector observes.
    const said = "Yes, I can hear you.";
    const response = await deliver(
      connected.webhookPath,
      token,
      update(
        1,
        toolCallTriggerPrompt([
          "send_to_user",
          { payload: { type: "text", text: said } },
        ]),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted" });

    // The peer's message is in the User Durable Object's log, attributed to the
    // peer and to no Bot.
    const inbound = await thread(userId, connected.channel.channelId);
    expect(inbound.messages).toHaveLength(1);
    expect(inbound.messages[0]).toMatchObject({
      senderPeer: "tg-5150",
      hop: 1,
    });
    expect(inbound.messages[0]!.senderBotId).toBeUndefined();

    await settle(userId, botId);

    // The Bot ran its own `channel` Turn, keyed by Telegram's message identity.
    const channelRuns = (await storedRuns(userId, botId)).filter(
      (run) => run.admission?.turnType === "channel",
    );
    expect(channelRuns).toHaveLength(1);
    expect(channelRuns[0]).toMatchObject({
      runId: `ch-${inbound.messages[0]!.messageId}`,
      status: "completed",
    });

    // What it said reached Telegram, and the thread records it.
    const sent = (await ledger()).filter(
      (call) => call.method === "sendMessage",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      token: "good",
      body: { chat_id: 5150, text: said },
    });
    const answered = await thread(userId, connected.channel.channelId);
    expect(answered.messages.at(-1)).toMatchObject({
      senderBotId: botId,
      text: said,
      hop: 2,
    });
  });

  it("answers a token it did not mint, and a good token with the wrong header, with 404", async () => {
    const userId = freshUserId("channels-telegram-forged");
    const botId = "telegram-bot-b";
    await provisionThroughGateway({ userId, botId });
    await installTelegram(userId);
    const connection = await connectTelegram(userId, botId);
    const connected = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/channels/telegram`, {
        schemaVersion: 1,
        commandId: "telegram-channel-2",
        connectionId: connection.connectionId,
        name: "Telegram",
      }),
    )) as { webhookPath: string };
    const token = decodeURIComponent(connected.webhookPath.split("/").at(-1)!);

    // A token this deployment never minted.
    const forged = await deliver(
      "/api/plugins/channels/telegram/not-a-token",
      "not-a-token",
      update(2, "let me in"),
    );
    expect(forged.status).toBe(404);

    // The real token, presented without the header the platform must echo.
    expect(
      (await deliver(connected.webhookPath, undefined, update(3, "hi"))).status,
    ).toBe(404);
    expect(
      (await deliver(connected.webhookPath, "wrong-secret", update(4, "hi")))
        .status,
    ).toBe(404);

    // …and the real token with the real header still works, so the refusals
    // above are about the credential and not about the door being shut.
    expect(
      (await deliver(connected.webhookPath, token, update(5, "hi"))).status,
    ).toBe(200);
  });

  it("leaves a bot token Telegram rejects on a failed Connection", async () => {
    const userId = freshUserId("channels-telegram-bad");
    const botId = "telegram-bot-c";
    await provisionThroughGateway({ userId, botId });
    await installTelegram(userId);

    const connection = await connectTelegram(
      userId,
      botId,
      TELEGRAM_BAD_BOT_TOKEN,
    );
    expect(connection.status).toBe("failed");

    const settings = (await expectOkJson(
      await asUser(userId, "/api/settings"),
    )) as {
      connections: Array<{
        connectionId: string;
        state: string;
        failure?: string;
      }>;
    };
    const stored = settings.connections.find(
      (candidate) => candidate.connectionId === connection.connectionId,
    );
    expect(stored?.state).toBe("failed");
    expect(stored?.failure ?? "").toMatch(/Unauthorized/);
    // No credential material is ever in a settings read.
    expect(JSON.stringify(settings)).not.toContain(TELEGRAM_BAD_BOT_TOKEN);
  });
});

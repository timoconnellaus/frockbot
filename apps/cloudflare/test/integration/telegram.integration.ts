// Telegram as a person meets it: a link code from the app, `/start` in the
// chat, a message that becomes a Turn in the Bot's own conversation, and the
// Bot's reply sent back to the chat.
//
// Every webhook call here is anonymous, exactly as Telegram's are: its only
// credential is the secret header. The Bot API is the outbound stub in
// `test/harness/miniflare.ts`, which records what it was asked to send and is
// read back through the stub origin.
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { telegramRunIdV1 } from "@frockbot/app/telegram/backend";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface TelegramCall {
  method: string;
  body: {
    chat_id?: string;
    text?: string;
    url?: string;
    secret_token?: string;
  };
}

async function telegramCalls(): Promise<TelegramCall[]> {
  const response = await fetch("https://example.test/telegram-calls");
  return ((await response.json()) as { calls: TelegramCall[] }).calls;
}

/** A Telegram id no other test in the run shares. */
function freshTelegramId(): number {
  return 100_000_000 + Math.floor(Math.random() * 800_000_000);
}

function update(telegramId: number, messageId: number, text: string) {
  return JSON.stringify({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1_790_000_000,
      from: {
        id: telegramId,
        is_bot: false,
        first_name: "Tim",
        username: "tim_test",
      },
      chat: { id: telegramId, type: "private" },
      text,
    },
  });
}

function webhook(body: string, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  return SELF.fetch(`${ORIGIN}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body,
  });
}

async function waitForRun(userId: string, botId: string, runId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await asUser(
      userId,
      `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}`,
    );
    if (response.status === 200) {
      const body = (await response.json()) as {
        state?: string;
        run?: { input: string; via?: unknown };
      };
      if (body.state === "terminal" && body.run) return body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Telegram run ${runId} did not settle`);
}

async function linkedAccount(label: string) {
  const userId = freshUserId(label);
  const botId = `${label}-bot`;
  await provisionThroughGateway({ userId, botId });
  const offer = (await expectOkJson(
    await asUser(userId, "/api/telegram/link", { method: "POST" }),
  )) as { code: string; url: string };
  const telegramId = freshTelegramId();
  const linked = await webhook(update(telegramId, 1, `/start ${offer.code}`));
  expect(linked.status).toBe(200);
  expect(await linked.json()).toMatchObject({
    method: "sendMessage",
    chat_id: String(telegramId),
    text: expect.stringContaining("Linked to FrockBot"),
  });
  await expectOkJson(await postAsUser(userId, "/api/telegram/bot", { botId }));
  return { userId, botId, telegramId, offer };
}

describe("talking to a Bot from Telegram", () => {
  it("points Telegram at this deployment's webhook before offering a link", async () => {
    const { offer } = await linkedAccount("tg-offer");
    expect(offer.url).toMatch(
      /^https:\/\/t\.me\/frock_test_bot\?start=[A-Za-z0-9_-]{32}$/,
    );
    const setup = (await telegramCalls()).find(
      (call) => call.method === "setWebhook",
    );
    expect(setup?.body).toMatchObject({
      url: `${ORIGIN}/api/telegram/webhook`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    });
  });

  it("admits the message into the Bot's conversation and sends the reply back", async () => {
    const { userId, botId, telegramId } = await linkedAccount("tg-reply");
    const view = (await expectOkJson(
      await asUser(userId, "/api/telegram"),
    )) as { available: boolean; link?: { botId?: string } };
    expect(view).toMatchObject({ available: true, link: { botId } });

    const answer = await webhook(update(telegramId, 13, "hello from Telegram"));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ method: "sendChatAction" });

    const runId = await telegramRunIdV1(String(telegramId), "13");
    const run = await waitForRun(userId, botId, runId);
    // The person's own message, marked where it was written.
    expect(run).toMatchObject({
      input: "hello from Telegram",
      via: { kind: "telegram" },
    });

    // The reply leaves through the Bot's outbox; the alarm is its second
    // chance, so run it rather than wait on the drain's timing.
    const deadline = Date.now() + 30_000;
    let replies: TelegramCall[] = [];
    while (Date.now() < deadline) {
      replies = (await telegramCalls()).filter(
        (call) =>
          call.method === "sendMessage" &&
          call.body.chat_id === String(telegramId),
      );
      if (replies.length > 0) break;
      await runDurableObjectAlarm(
        env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`)),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(replies.map((call) => call.body.text)).toEqual(["Ollama reply"]);

    // Telegram delivering the same update again is the same Turn.
    expect(
      (await webhook(update(telegramId, 13, "hello from Telegram"))).status,
    ).toBe(200);
    const page = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: { runId: string }[] };
    expect(page.runs.filter((listed) => listed.runId === runId)).toHaveLength(
      1,
    );
  });

  it("refuses a caller without Telegram's secret, and forgets an unlinked chat", async () => {
    const { userId, botId, telegramId } = await linkedAccount("tg-unlink");
    expect((await webhook(update(telegramId, 20, "hi"), "forged")).status).toBe(
      401,
    );

    await expectOkJson(
      await asUser(userId, "/api/telegram/unlink", { method: "POST" }),
    );
    const answer = await webhook(update(telegramId, 21, "still there?"));
    expect(await answer.json()).toMatchObject({
      method: "sendMessage",
      text: expect.stringContaining("isn’t linked"),
    });
    const runId = await telegramRunIdV1(String(telegramId), "21");
    const lookup = await asUser(userId, `/api/bots/${botId}/turns/${runId}`);
    expect(
      lookup.status === 404 ||
        ((await lookup.json()) as { state?: string }).state === "not-admitted",
    ).toBe(true);
  });
});

// The external Channel connector, in workerd, against a stubbed Telegram.
//
// The unit tests prove the connector's rules over plain objects. What only this
// suite can prove:
//
//  * the bot token reaches Telegram *through a lease* — sealed by the Credential
//    Store, opened inside the Durable Object, and present nowhere in that
//    object's durable state;
//  * a delivery is admitted only when the token verifies, the header echoes it,
//    and the durable digest still names it — and refused, as a 404 and nothing
//    more informative, when any of those is false;
//  * a 429 from the platform is recorded as a visible failure rather than
//    swallowed;
//  * `disconnect` deletes the webhook, revokes the key, and leaves the record
//    and its history intact.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  TELEGRAM_GOOD_BOT_TOKEN,
  TELEGRAM_LEDGER_ENDPOINT,
  TELEGRAM_LIMITED_BOT_TOKEN,
} from "./harness/miniflare.ts";

interface TelegramCall {
  method: string;
  token: "good" | "limited" | "bad" | "unknown";
  body: unknown;
}

async function ledger(): Promise<TelegramCall[]> {
  const response = await fetch(TELEGRAM_LEDGER_ENDPOINT);
  return ((await response.json()) as { calls: TelegramCall[] }).calls;
}

async function clearLedger(): Promise<void> {
  await fetch(TELEGRAM_LEDGER_ENDPOINT, { method: "DELETE" });
}

function probe(name: string) {
  return env.CHANNEL_CONNECTOR.get(env.CHANNEL_CONNECTOR.idFromName(name));
}

/** The token out of the webhook path the connect returned. */
function tokenOf(webhookPath: string): string {
  return decodeURIComponent(webhookPath.split("/").at(-1)!);
}

const BOT_ID = "probe-bot";

function update(messageId: number, text: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 4242, username: "peer" },
      chat: { id: 4242, type: "private" },
      date: 1_756_000_000,
      text,
    },
  };
}

async function connected(name: string, apiKey = TELEGRAM_GOOD_BOT_TOKEN) {
  const stub = probe(name);
  await stub.sealBotToken(apiKey);
  const { webhookPath } = await stub.connectChannel(BOT_ID);
  return { stub, webhookPath, token: tokenOf(webhookPath) };
}

beforeEach(async () => {
  await clearLedger();
});

describe("connecting an external Channel", () => {
  it("tells Telegram where to deliver, with the token as URL and as secret", async () => {
    const { webhookPath, token } = await connected("connect-ok");

    const calls = await ledger();
    const registration = calls.find((call) => call.method === "setWebhook");
    expect(registration).toBeDefined();
    // Never a raw key on the wire body: Telegram's own path authentication is
    // the only place the bot token appears, and the stub records only its kind.
    expect(registration!.token).toBe("good");
    expect(registration!.body).toMatchObject({
      url: `https://frockbot.test${webhookPath}`,
      secret_token: token,
      allowed_updates: ["message"],
    });
  });

  it("keeps the bot token out of its own durable state entirely", async () => {
    const { stub } = await connected("connect-sealed");
    const dump = await stub.durableDump();

    expect(dump).not.toContain(TELEGRAM_GOOD_BOT_TOKEN);
    // The sealed envelope is there, which is what makes the absence meaningful.
    expect(dump).toContain("AES-GCM");
  });
});

describe("one delivery from the open internet", () => {
  it("records the peer's message and owes the Bot a Turn", async () => {
    const { stub, token } = await connected("deliver-ok");

    const outcome = await stub.deliver({
      token,
      presentedSecret: token,
      body: update(1, "hello from the outside"),
    });

    expect(outcome).toMatchObject({ status: "accepted" });
    if (outcome.status === "refused") return;
    const thread = await stub.thread(outcome.channelId);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      senderPeer: "tg-4242",
      text: "hello from the outside",
    });
    expect(thread.messages[0]!.senderBotId).toBeUndefined();
  });

  it("refuses a delivery whose header does not echo the token", async () => {
    const { stub, token } = await connected("deliver-header");

    expect(
      await stub.deliver({
        token,
        presentedSecret: "not-the-token",
        body: update(2, "forged"),
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await stub.deliver({
        token,
        presentedSecret: null,
        body: update(3, "forged"),
      }),
    ).toMatchObject({ status: "refused" });
  });

  it("refuses a token this Channel does not hold", async () => {
    const { stub } = await connected("deliver-wrong-token");
    const other = await connected("deliver-wrong-token-other");

    expect(
      await stub.deliver({
        token: other.token,
        presentedSecret: other.token,
        body: update(4, "another Channel's key"),
      }),
    ).toMatchObject({ status: "refused" });
  });

  it("takes an update it has no message for without recording one", async () => {
    const { stub, token } = await connected("deliver-ignored");

    const outcome = await stub.deliver({
      token,
      presentedSecret: token,
      body: { update_id: 5, edited_message: { message_id: 5 } },
    });

    expect(outcome.status).toBe("ignored");
    if (outcome.status === "refused") return;
    expect((await stub.thread(outcome.channelId)).messages).toHaveLength(0);
  });

  it("is idempotent on the platform's own message identity", async () => {
    const { stub, token } = await connected("deliver-retry");
    const body = update(6, "said once");

    const first = await stub.deliver({ token, presentedSecret: token, body });
    const second = await stub.deliver({ token, presentedSecret: token, body });

    if (first.status === "refused" || second.status === "refused") {
      throw new Error("the delivery was refused");
    }
    expect(second.messageId).toBe(first.messageId!);
    expect((await stub.thread(first.channelId)).messages).toHaveLength(1);
  });
});

describe("saying something back", () => {
  it("sends through the lease, and records the reply in the thread", async () => {
    const { stub, token } = await connected("reply-ok");
    const inbound = await stub.deliver({
      token,
      presentedSecret: token,
      body: update(10, "are you there"),
    });
    if (inbound.status === "refused") throw new Error("delivery was refused");
    await clearLedger();

    const receipt = await stub.reply({
      channelId: inbound.channelId,
      botId: BOT_ID,
      text: "I am here",
      inReplyTo: inbound.messageId!,
      ordinal: 0,
      hop: 2,
    });

    expect(receipt.status).toBe("sent");
    const calls = await ledger();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "sendMessage",
      // The lease opened the sealed key; the raw key was never held anywhere
      // this probe could have read it from.
      token: "good",
      body: { chat_id: 4242, text: "I am here" },
    });
    const thread = await stub.thread(inbound.channelId);
    expect(thread.messages.at(-1)).toMatchObject({
      senderBotId: BOT_ID,
      text: "I am here",
      hop: 2,
    });
  });

  it("records a 429 as a visible failure, with the reply still in the log", async () => {
    const { stub, token } = await connected(
      "reply-limited",
      TELEGRAM_LIMITED_BOT_TOKEN,
    );
    const inbound = await stub.deliver({
      token,
      presentedSecret: token,
      body: update(11, "too fast"),
    });
    if (inbound.status === "refused") throw new Error("delivery was refused");

    const receipt = await stub.reply({
      channelId: inbound.channelId,
      botId: BOT_ID,
      text: "slow down",
      inReplyTo: inbound.messageId!,
      ordinal: 0,
      hop: 2,
    });

    expect(receipt).toMatchObject({
      status: "failed",
      retryAfterSeconds: 30,
    });
    if (receipt.status !== "failed") return;
    expect(receipt.reason).toMatch(/Too Many Requests/);
    // The failure is visible *and* the record is honest about what was said.
    const thread = await stub.thread(inbound.channelId);
    expect(thread.messages.at(-1)).toMatchObject({ text: "slow down" });
  });
});

describe("disconnecting", () => {
  it("deletes the webhook, revokes the key, and keeps the history", async () => {
    const { stub, token } = await connected("disconnect");
    const inbound = await stub.deliver({
      token,
      presentedSecret: token,
      body: update(20, "before the door closed"),
    });
    if (inbound.status === "refused") throw new Error("delivery was refused");
    await clearLedger();

    const outcome = await stub.disconnect({
      channelId: inbound.channelId,
      botId: BOT_ID,
      commandId: "probe-disconnect",
    });

    expect(outcome.channel.active).toBe(false);
    expect((await ledger()).map((call) => call.method)).toContain(
      "deleteWebhook",
    );
    // The token that worked a moment ago is now a 404, and nothing else.
    expect(
      await stub.deliver({
        token,
        presentedSecret: token,
        body: update(21, "after"),
      }),
    ).toMatchObject({ status: "refused" });
    // The record and every message in it survive.
    const thread = await stub.thread(inbound.channelId);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      text: "before the door closed",
    });
  });

  it("leaves no webhook key behind in durable storage", async () => {
    const { stub, token } = await connected("disconnect-revoked");
    const inbound = await stub.deliver({
      token,
      presentedSecret: token,
      body: update(30, "hello"),
    });
    if (inbound.status === "refused") throw new Error("delivery was refused");
    await stub.disconnect({
      channelId: inbound.channelId,
      botId: BOT_ID,
      commandId: "probe-disconnect-2",
    });

    const keys = await runInDurableObject(
      probe("disconnect-revoked"),
      async (_instance, state) => [
        ...(
          await state.storage.list<unknown>({ prefix: "channel-token:" })
        ).keys(),
      ],
    );
    expect(keys).toEqual([]);
  });
});

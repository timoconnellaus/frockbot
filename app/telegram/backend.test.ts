import { describe, expect, test } from "bun:test";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  createTelegramBackendContribution,
  telegramRunIdV1,
  type TelegramGatewayHostV1,
} from "./backend.js";
import {
  telegramPlatformBotV1,
  type TelegramRouteDecisionV1,
} from "./shared.js";

const SECRET = "s".repeat(40);
const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const CODE = "C".repeat(32);

interface Recorder {
  calls: Array<[string, ...unknown[]]>;
}

function fakeHost(
  overrides: Partial<TelegramGatewayHostV1> = {},
  options: {
    account?: string;
    decision?: TelegramRouteDecisionV1;
    admit?: () => Promise<void>;
  } = {},
): TelegramGatewayHostV1 & Recorder {
  const calls: Recorder["calls"] = [];
  const record =
    <T>(name: string, answer: T) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(answer);
    };
  return {
    calls,
    telegram: { botToken: TOKEN, webhookSecret: SECRET },
    offerTelegramLink: record("offer", undefined),
    claimTelegramLink: record("claim", {
      status: "claimed" as const,
      userId: "alice",
    }),
    resolveTelegramAccount: record("resolve", options.account),
    releaseTelegramAccount: record("release", undefined),
    readTelegram: record("read", { schemaVersion: 1 as const, bots: [] }),
    completeTelegramLink: record("complete", { botName: "General" }),
    dropTelegramLink: record("drop", undefined),
    unlinkTelegram: record("unlink", { telegramUserId: "4242" }),
    selectTelegramBot: record("select", { status: "applied" as const }),
    routeTelegramMessage: record(
      "route",
      options.decision ?? { kind: "admit", botId: "general-1" },
    ),
    admitTelegramTurn: (...args: unknown[]) => {
      calls.push(["admit", ...args]);
      return options.admit ? options.admit() : Promise.resolve();
    },
    telegramAccountRefusal: record("refusal", undefined),
    ...overrides,
  };
}

function update(text: string, from = 4242): string {
  return JSON.stringify({
    update_id: 1,
    message: {
      message_id: 12,
      date: 1,
      from: { id: from, is_bot: false, first_name: "Tim" },
      chat: { id: from, type: "private" },
      text,
    },
  });
}

async function deliver(
  host: TelegramGatewayHostV1,
  body: string,
  secret: string | null = SECRET,
): Promise<Response> {
  const contribution = createTelegramBackendContribution(host);
  const url = new URL("https://bot.test/api/telegram/webhook");
  const response = await contribution.publicRoute!(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === null
          ? {}
          : { "x-telegram-bot-api-secret-token": secret }),
      },
      body,
    }),
    url,
    {},
  );
  if (!response) throw new Error("the webhook did not answer");
  return response;
}

describe("the Telegram webhook", () => {
  test("refuses a caller without the secret before touching anything", async () => {
    const host = fakeHost({}, { account: "alice" });
    expect((await deliver(host, update("hi"), null)).status).toBe(401);
    expect((await deliver(host, update("hi"), "wrong")).status).toBe(401);
    expect(host.calls).toEqual([]);
  });

  test("is not there at all on a deployment with no bot", async () => {
    const host = fakeHost({ telegram: undefined });
    expect((await deliver(host, update("hi"))).status).toBe(404);
    expect(host.calls).toEqual([]);
  });

  test("admits a linked person's message before answering, once per message", async () => {
    const host = fakeHost({}, { account: "alice" });
    const response = await deliver(host, update("What's on today?"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "sendChatAction",
      chat_id: "4242",
      action: "typing",
    });
    const runId = await telegramRunIdV1("4242", "12");
    expect(runId).toMatch(/^tg-[0-9a-f]{64}$/);
    expect(host.calls.find(([name]) => name === "admit")).toEqual([
      "admit",
      "alice",
      "general-1",
      { runId, text: "What's on today?", messageId: "12" },
    ]);
    // A redelivery names the same run, which the Bot answers from its record.
    await deliver(host, update("What's on today?"));
    expect(
      host.calls
        .filter(([name]) => name === "admit")
        .map(([, , , command]) => (command as { runId: string }).runId),
    ).toEqual([runId, runId]);
  });

  test("an update that could not be admitted is not acknowledged", async () => {
    const host = fakeHost(
      {},
      { account: "alice", admit: () => Promise.reject(new Error("evicted")) },
    );
    expect((await deliver(host, update("hi"))).status).toBe(500);
  });

  test("a full queue is told to the person; an admitted one is just handled", async () => {
    const busy = Object.assign(new Error("queue is full"), {
      name: "BotTurnRefusedError:busy",
    });
    const full = fakeHost(
      {},
      { account: "alice", admit: () => Promise.reject(busy) },
    );
    const answer = await deliver(full, update("hi"));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      method: "sendMessage",
      chat_id: "4242",
    });
    const duplicate = Object.assign(new Error("seen"), {
      name: "BotTurnRefusedError:duplicate",
    });
    const replay = fakeHost(
      {},
      { account: "alice", admit: () => Promise.reject(duplicate) },
    );
    const handled = await deliver(replay, update("hi"));
    expect(handled.status).toBe(200);
    expect(await handled.text()).toBe("");
  });

  test("an account nobody linked is told how to link", async () => {
    const host = fakeHost();
    const answer = await deliver(host, update("hello"));
    expect(await answer.json()).toMatchObject({
      method: "sendMessage",
      chat_id: "4242",
      text: expect.stringContaining("isn’t linked"),
    });
    expect(host.calls.map(([name]) => name)).toEqual(["resolve"]);
  });

  test("a stale directory entry is forgotten when the User no longer links it", async () => {
    const host = fakeHost(
      {},
      { account: "alice", decision: { kind: "not-linked" } },
    );
    await deliver(host, update("hello"));
    expect(host.calls.find(([name]) => name === "release")).toEqual([
      "release",
      "alice",
      "4242",
    ]);
  });

  test("an account that may not use the product reaches no Bot", async () => {
    const host = fakeHost(
      { telegramAccountRefusal: () => Promise.resolve("paused") },
      { account: "alice" },
    );
    const answer = await deliver(host, update("hello"));
    expect(await answer.json()).toMatchObject({ method: "sendMessage" });
    expect(host.calls.map(([name]) => name)).toEqual(["resolve"]);
  });

  test("/start with a code links the account, moving it from its last User", async () => {
    const host = fakeHost({
      claimTelegramLink: (claim) => {
        host.calls.push(["claim", claim]);
        return Promise.resolve({
          status: "claimed",
          userId: "alice",
          previousUserId: "bob",
        });
      },
      completeTelegramLink: (...args) => {
        host.calls.push(["complete", ...args]);
        return Promise.resolve({
          botName: "General",
          previousTelegramUserId: "99",
        });
      },
    });
    const answer = await deliver(host, update(`/start ${CODE}`));
    expect(await answer.json()).toMatchObject({
      method: "sendMessage",
      text: expect.stringContaining("You’re talking to General"),
    });
    expect(host.calls.map(([name]) => name)).toEqual([
      "claim",
      "drop",
      "complete",
      "release",
    ]);
    expect(host.calls[0]![1]).toMatchObject({
      codeDigest: await sha256HexTextV1(CODE),
      telegramUserId: "4242",
    });
    expect(host.calls[3]).toEqual(["release", "alice", "99"]);
  });

  test("a spent or expired code links nothing", async () => {
    const host = fakeHost({
      claimTelegramLink: () => Promise.resolve({ status: "invalid" }),
    });
    const answer = await deliver(host, update(`/start ${CODE}`));
    expect(await answer.json()).toMatchObject({
      text: expect.stringContaining("expired"),
    });
  });

  test("a command the User object answers goes back in the reply", async () => {
    const host = fakeHost(
      {},
      { account: "alice", decision: { kind: "reply", text: "Your Bots:" } },
    );
    expect(await (await deliver(host, update("/bots"))).json()).toEqual({
      method: "sendMessage",
      chat_id: "4242",
      text: "Your Bots:",
      link_preview_options: { is_disabled: true },
    });
  });
});

describe("the Telegram settings routes", () => {
  async function call(
    host: TelegramGatewayHostV1,
    path: string,
    init: RequestInit = {},
    origin = "https://bot.test",
  ): Promise<Response> {
    const url = new URL(`${origin}${path}`);
    const response = await createTelegramBackendContribution(host).route(
      new Request(url, init),
      url,
      { userId: "alice", client: "browser" },
    );
    if (!response) throw new Error(`${path} did not answer`);
    return response;
  }

  test("a link code exists once, on the receipt, and only its digest is kept", async () => {
    const telegramCalls: string[] = [];
    const host = fakeHost({
      telegramFetch: (async (input: RequestInfo | URL) => {
        const method = String(input).split("/").pop()!;
        telegramCalls.push(method);
        return Response.json({
          ok: true,
          result: method === "getMe" ? { username: "frock_test_bot" } : true,
        });
      }) as typeof fetch,
    });
    const offer = (await (
      await call(
        host,
        "/api/telegram/link",
        { method: "POST" },
        "https://link.test",
      )
    ).json()) as { code: string; url: string; expiresAt: string };
    expect(offer.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(offer.url).toBe(`https://t.me/frock_test_bot?start=${offer.code}`);
    expect(telegramCalls).toEqual(["setWebhook", "getMe"]);
    expect(host.calls).toEqual([
      [
        "offer",
        "alice",
        {
          codeDigest: await sha256HexTextV1(offer.code),
          expiresAt: offer.expiresAt,
        },
      ],
    ]);
    // The bot is ready for this origin; a second code asks Telegram nothing.
    await call(
      host,
      "/api/telegram/link",
      { method: "POST" },
      "https://link.test",
    );
    expect(telegramCalls).toEqual(["setWebhook", "getMe"]);
  });

  test("without a bot, the page says so and nothing can be linked", async () => {
    const host = fakeHost({ telegram: undefined });
    expect(
      (await call(host, "/api/telegram/link", { method: "POST" })).status,
    ).toBe(503);
    const document = (await (
      await call(host, "/api/telegram?as=document")
    ).json()) as { surfaceId: string; actions: unknown[] };
    expect(document.surfaceId).toBe("telegram");
    expect(document.actions).toEqual([]);
  });

  test("choosing a Bot and unlinking go to the User's object", async () => {
    const host = fakeHost();
    await call(host, "/api/telegram/bot", {
      method: "POST",
      body: JSON.stringify({ "telegram.bot": "research" }),
    });
    await call(host, "/api/telegram/unlink", { method: "POST" });
    expect(host.calls).toEqual([
      ["select", "alice", "research"],
      ["unlink", "alice"],
      ["release", "alice", "4242"],
    ]);
    const refused = fakeHost({
      selectTelegramBot: () =>
        Promise.resolve({ status: "rejected", reason: "No such Bot." }),
    });
    expect(
      (
        await call(refused, "/api/telegram/bot", {
          method: "POST",
          body: JSON.stringify({ botId: "gone" }),
        })
      ).status,
    ).toBe(409);
  });
});

describe("the platform bot's settings", () => {
  test("a short webhook secret is no credential, so there is no bot", () => {
    expect(
      telegramPlatformBotV1({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_WEBHOOK_SECRET: "short",
      }),
    ).toBeUndefined();
    expect(telegramPlatformBotV1({ TELEGRAM_WEBHOOK_SECRET: SECRET })).toBe(
      undefined,
    );
    expect(
      telegramPlatformBotV1({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_WEBHOOK_SECRET: SECRET,
      }),
    ).toEqual({ botToken: TOKEN, webhookSecret: SECRET });
  });
});

import { describe, expect, it } from "bun:test";
import {
  createTelegramConnectorV1,
  decodeTelegramUpdateV1,
  telegramChatIdV1,
  telegramMessageIdV1,
  telegramPeerV1,
  TELEGRAM_API_ORIGIN_V1,
} from "./connector.js";

const BOT_TOKEN = "123456:test-bot-token";

interface Seen {
  url: string;
  body: unknown;
}

function stub(answer: (seen: Seen) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Seen[];
} {
  const calls: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen: Seen = {
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    };
    calls.push(seen);
    return answer(seen);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function ok(result: unknown = true): Response {
  return Response.json({ ok: true, result });
}

const UPDATE = {
  update_id: 7,
  message: {
    message_id: 42,
    from: { id: 9001, first_name: "Ada", username: "ada" },
    chat: { id: 9001, type: "private" },
    date: 1_756_000_000,
    text: "  hello there  ",
  },
};

describe("decoding one Telegram Update", () => {
  it("reads a text message into an inbound Channel message", () => {
    expect(decodeTelegramUpdateV1(UPDATE)).toEqual({
      peer: "tg-9001",
      peerLabel: "@ada",
      text: "hello there",
      externalId: "tg-9001-42",
    });
  });

  it("names a group chat by its negative id, and the id survives a round trip", () => {
    const decoded = decodeTelegramUpdateV1({
      ...UPDATE,
      message: { ...UPDATE.message, chat: { id: -1_001_234, type: "group" } },
    });
    expect(decoded?.peer).toBe("tg--1001234");
    expect(telegramChatIdV1(decoded!.peer)).toBe(-1_001_234);
  });

  it("falls back to a first name when the sender has no username", () => {
    expect(
      decodeTelegramUpdateV1({
        ...UPDATE,
        message: { ...UPDATE.message, from: { id: 9001, first_name: "Ada" } },
      })?.peerLabel,
    ).toBe("Ada");
  });

  it("ignores an update this product has no message for", () => {
    // An edit, a reaction, a member change: well-formed, and not a message.
    expect(decodeTelegramUpdateV1({ update_id: 8 })).toBeUndefined();
    // A sticker or a photo: a message, with no text in it.
    expect(
      decodeTelegramUpdateV1({
        update_id: 9,
        message: { message_id: 1, chat: { id: 1 }, sticker: {} },
      }),
    ).toBeUndefined();
    // Whitespace is not a message either.
    expect(
      decodeTelegramUpdateV1({
        update_id: 10,
        message: { message_id: 1, chat: { id: 1 }, text: "   " },
      }),
    ).toBeUndefined();
  });

  it("refuses a delivery that claims to be a message and is not one", () => {
    expect(() => decodeTelegramUpdateV1(null)).toThrow(/must be an object/);
    expect(() => decodeTelegramUpdateV1({ message: {} })).toThrow(
      /no update_id/,
    );
    expect(() =>
      decodeTelegramUpdateV1({
        update_id: 1,
        message: { message_id: 1, text: "hi" },
      }),
    ).toThrow(/names no chat/);
    expect(() =>
      decodeTelegramUpdateV1({
        update_id: 1,
        message: { chat: { id: 1 }, text: "hi" },
      }),
    ).toThrow(/no message_id/);
  });

  it("tolerates fields it has never seen", () => {
    expect(
      decodeTelegramUpdateV1({
        ...UPDATE,
        business_connection_id: "b1",
        message: { ...UPDATE.message, link_preview_options: {} },
      })?.text,
    ).toBe("hello there");
  });
});

describe("the outbound request shape", () => {
  it("posts sendMessage with the chat the peer names, and the key only in the path", async () => {
    const { fetch: impl, calls } = stub(() => ok({ message_id: 77 }));
    const receipt = await createTelegramConnectorV1({ fetch: impl }).send({
      apiKey: BOT_TOKEN,
      peer: "tg-9001",
      text: "  a reply  ",
    });

    expect(receipt).toEqual({ status: "sent", externalId: "tg-9001-77" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${TELEGRAM_API_ORIGIN_V1}/bot${BOT_TOKEN}/sendMessage`,
    );
    expect(calls[0]!.body).toEqual({ chat_id: 9001, text: "a reply" });
    // The key is Telegram's own path authentication and appears nowhere else.
    expect(JSON.stringify(calls[0]!.body)).not.toContain(BOT_TOKEN);
  });

  it("records a 429 as a visible failure carrying the platform's back-off", async () => {
    const { fetch: impl } = stub(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 30",
            parameters: { retry_after: 30 },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const receipt = await createTelegramConnectorV1({ fetch: impl }).send({
      apiKey: BOT_TOKEN,
      peer: "tg-9001",
      text: "a reply",
    });

    expect(receipt).toEqual({
      status: "failed",
      reason: "Telegram refused sendMessage: Too Many Requests: retry after 30",
      retryAfterSeconds: 30,
    });
    // A failure is a receipt, never an exception the caller may forget.
    expect(receipt.status).toBe("failed");
    if (receipt.status !== "failed") return;
    expect(receipt.reason).not.toContain(BOT_TOKEN);
  });

  it("refuses a peer that is not a Telegram chat, without reaching the network", async () => {
    const { fetch: impl, calls } = stub(() => ok());
    const receipt = await createTelegramConnectorV1({ fetch: impl }).send({
      apiKey: BOT_TOKEN,
      peer: "slack-U123",
      text: "a reply",
    });
    expect(receipt).toEqual({
      status: "failed",
      reason: '"slack-U123" is not a Telegram chat',
    });
    expect(calls).toHaveLength(0);
  });

  it("reports a transport failure rather than throwing it at the Channel", async () => {
    const impl = (() =>
      Promise.reject(new Error("connection reset"))) as unknown as typeof fetch;
    const receipt = await createTelegramConnectorV1({ fetch: impl }).send({
      apiKey: BOT_TOKEN,
      peer: "tg-9001",
      text: "a reply",
    });
    expect(receipt).toEqual({
      status: "failed",
      reason: "Telegram could not be reached: connection reset",
    });
  });
});

describe("registering and unregistering the webhook", () => {
  it("sends the token both as the URL and as the secret Telegram must echo", async () => {
    const { fetch: impl, calls } = stub(() => ok());
    await createTelegramConnectorV1({ fetch: impl }).register({
      apiKey: BOT_TOKEN,
      webhookUrl: "https://frockbot.test/api/plugins/channels/telegram/tok-1",
      secretToken: "tok-1",
    });
    expect(calls[0]!.url).toBe(
      `${TELEGRAM_API_ORIGIN_V1}/bot${BOT_TOKEN}/setWebhook`,
    );
    expect(calls[0]!.body).toEqual({
      url: "https://frockbot.test/api/plugins/channels/telegram/tok-1",
      secret_token: "tok-1",
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  });

  it("throws when Telegram refuses the registration, so connect does not claim success", async () => {
    const { fetch: impl } = stub(
      () =>
        new Response(
          JSON.stringify({ ok: false, description: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      createTelegramConnectorV1({ fetch: impl }).register({
        apiKey: BOT_TOKEN,
        webhookUrl: "https://frockbot.test/x",
        secretToken: "tok-1",
      }),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("deletes the webhook on unregister", async () => {
    const { fetch: impl, calls } = stub(() => ok());
    await createTelegramConnectorV1({ fetch: impl }).unregister({
      apiKey: BOT_TOKEN,
    });
    expect(calls[0]!.url).toBe(
      `${TELEGRAM_API_ORIGIN_V1}/bot${BOT_TOKEN}/deleteWebhook`,
    );
  });
});

describe("the peer and message addresses", () => {
  it("round-trips a chat id and refuses one that is not a number", () => {
    expect(telegramPeerV1(9001)).toBe("tg-9001");
    expect(telegramChatIdV1("tg-9001")).toBe(9001);
    expect(telegramChatIdV1("tg-nonsense")).toBeUndefined();
    expect(telegramChatIdV1("nine-thousand")).toBeUndefined();
    expect(() => telegramPeerV1(1.5)).toThrow(/chat id is invalid/);
  });

  it("keys a message by its chat as well as its number", () => {
    expect(telegramMessageIdV1(9001, 42)).toBe("tg-9001-42");
    expect(telegramMessageIdV1(9002, 42)).not.toBe(
      telegramMessageIdV1(9001, 42),
    );
  });
});

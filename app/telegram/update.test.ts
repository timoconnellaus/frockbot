import { describe, expect, test } from "bun:test";
import { decodeTelegramUpdateV1, parseTelegramCommandV1 } from "./update.js";

function update(message: Record<string, unknown>): unknown {
  return {
    update_id: 91,
    message: {
      message_id: 12,
      date: 1_790_000_000,
      from: {
        id: 4242,
        is_bot: false,
        first_name: "Tim",
        last_name: "O",
        username: "tim_o",
      },
      chat: { id: 4242, type: "private" },
      text: "hello",
      ...message,
    },
  };
}

describe("a Telegram update", () => {
  test("a private text message is the person speaking", () => {
    expect(decodeTelegramUpdateV1(update({}))).toEqual({
      kind: "message",
      account: {
        telegramUserId: "4242",
        chatId: "4242",
        username: "tim_o",
        name: "Tim O",
      },
      messageId: "12",
      text: "hello",
    });
  });

  test("a group, another bot or an edit is nobody the Bot answers", () => {
    expect(
      decodeTelegramUpdateV1(update({ chat: { id: -100, type: "group" } })),
    ).toMatchObject({ kind: "ignored" });
    expect(
      decodeTelegramUpdateV1(
        update({ from: { id: 4242, is_bot: true, first_name: "Bot" } }),
      ),
    ).toMatchObject({ kind: "ignored" });
    expect(
      decodeTelegramUpdateV1({
        update_id: 1,
        edited_message: { message_id: 1 },
      }),
    ).toMatchObject({ kind: "ignored" });
    expect(decodeTelegramUpdateV1("nonsense")).toMatchObject({
      kind: "ignored",
    });
  });

  test("a photo in a private chat is answered, not dropped", () => {
    const { text: _text, ...photo } = (update({}) as { message: object })
      .message as Record<string, unknown>;
    expect(
      decodeTelegramUpdateV1({
        update_id: 2,
        message: { ...photo, photo: [] },
      }),
    ).toEqual({ kind: "unsupported", chatId: "4242" });
  });

  test("no more text than Telegram itself allows reaches a Turn", () => {
    const decoded = decodeTelegramUpdateV1(update({ text: "x".repeat(9000) }));
    expect(decoded.kind === "message" && decoded.text.length).toBe(4096);
  });
});

describe("a chat command", () => {
  const code = "A".repeat(32);

  test("/start carries the app's link code", () => {
    expect(parseTelegramCommandV1(`/start ${code}`)).toEqual({
      name: "start",
      code,
    });
    expect(parseTelegramCommandV1("/start")).toEqual({ name: "start" });
    expect(parseTelegramCommandV1("/start not-a-code")).toEqual({
      name: "start",
    });
  });

  test("/bots, /bot and /help, with or without the bot's name", () => {
    expect(parseTelegramCommandV1("/bots@frockbot_bot")).toEqual({
      name: "bots",
    });
    expect(parseTelegramCommandV1("/bot  Research ")).toEqual({
      name: "bot",
      argument: "Research",
    });
    expect(parseTelegramCommandV1("/bot")).toEqual({ name: "bots" });
    expect(parseTelegramCommandV1("/HELP")).toEqual({ name: "help" });
  });

  test("anything else is something the person said", () => {
    expect(parseTelegramCommandV1("/weather in Sydney")).toBeUndefined();
    expect(parseTelegramCommandV1("hello /bots")).toBeUndefined();
  });
});

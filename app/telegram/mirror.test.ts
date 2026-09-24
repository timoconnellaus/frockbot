import { describe, expect, test } from "bun:test";
import {
  TELEGRAM_MESSAGE_MAX_CHARS_V1,
  telegramMessageTextV1,
  telegramMirrorTextV1,
} from "./mirror.js";

describe("a Bot's message in Telegram", () => {
  test("text is itself; everything else points back to the app", () => {
    expect(telegramMirrorTextV1({ type: "text", text: "Hi" })).toBe("Hi");
    expect(
      telegramMirrorTextV1({
        type: "widget",
        widget: { prompt: "Which one?", options: ["A", "B"] },
      }),
    ).toBe("Which one?\n• A\n• B\nAnswer here or in FrockBot.");
    expect(
      telegramMirrorTextV1({
        type: "secret-request",
        prompt: "Your key",
        secretName: "KEY",
      }),
    ).toContain("never send it here");
    expect(
      telegramMirrorTextV1({ type: "card", surfaceId: "s", messages: [] }),
    ).toBe("Sent a card. Open FrockBot to see it.");
  });

  test("a long reply is cut under Telegram's ceiling, on a whole character", () => {
    const emoji = "😀".repeat(TELEGRAM_MESSAGE_MAX_CHARS_V1);
    const cut = telegramMessageTextV1(emoji);
    expect(cut.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS_V1);
    expect(cut).toEndWith("(The rest is in FrockBot.)");
    // No lone surrogate: every code unit before the note pairs up.
    expect(cut.slice(0, cut.indexOf("…"))).toMatch(/^(?:😀)+$/u);
    expect(telegramMessageTextV1("  ")).toBe("(empty message)");
    expect(telegramMessageTextV1("short")).toBe("short");
  });
});

import { describe, expect, test } from "bun:test";
import {
  draftSendableV1,
  resendableTurnTextV1,
  sendReadyV1,
} from "./send-readiness.js";
import { TURN_TEXT_MAX_CHARACTERS_V1 } from "./turn-limits.js";

const READY = {
  connection: "ready",
  modelReady: true,
  activeBotId: "scout",
} as const;

describe("what the composer needs and what a retry needs", () => {
  test("a client with a Bot, a model and a connection can start a Turn", () => {
    expect(sendReadyV1(READY)).toBe(true);
  });

  test("nothing is sent while the shell is not connected to its Bot", () => {
    expect(sendReadyV1({ ...READY, connection: "connecting" })).toBe(false);
    expect(sendReadyV1({ ...READY, modelReady: false })).toBe(false);
    expect(sendReadyV1({ ...READY, activeBotId: undefined })).toBe(false);
  });

  test("an empty or oversized draft is not sendable", () => {
    expect(draftSendableV1("")).toBe(false);
    expect(draftSendableV1("book it")).toBe(true);
    expect(draftSendableV1("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1 + 1))).toBe(
      false,
    );
  });

  /**
   * The case the button exists for. The message was admitted, so the composer
   * was cleared; the Turn then failed retryably. Readiness is the whole of what
   * trying again needs — the words come off the person's own line in the
   * thread, not out of the empty composer.
   */
  test("trying again is available with an empty composer", () => {
    const draft = "";
    expect(sendReadyV1(READY) && draftSendableV1(draft)).toBe(false);
    expect(sendReadyV1(READY)).toBe(true);
    expect(resendableTurnTextV1("book it")).toBe("book it");
  });

  test("the retry sends the original words, not what is typed", () => {
    expect(resendableTurnTextV1("  book it  ")).toBe("book it");
  });

  test("a Turn with nothing to say again is not offered again", () => {
    expect(resendableTurnTextV1(undefined)).toBeUndefined();
    expect(resendableTurnTextV1("   ")).toBeUndefined();
    expect(
      resendableTurnTextV1("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1 + 1)),
    ).toBeUndefined();
  });
});

const source = await Bun.file(
  new URL("./FrockBotApp.vue", import.meta.url),
).text();

describe("the shell binds each control to its own question", () => {
  test("Try again is enabled by readiness, not by the draft", () => {
    expect(source).toContain(`v-if="message.retry === 'resend-turn'"`);
    expect(source).toContain(`:disabled="!canRetryTurn(message)"`);
    expect(source).toContain(
      `function canRetryTurn(message: WebChatMessage): boolean {\n  return sendReady.value && retryTurnText(message) !== undefined;\n}`,
    );
  });

  test("the composer's own send still requires a draft", () => {
    expect(source).toContain(
      `const canSend = computed(\n  () => sendReady.value && draftSendableV1(draftText.value),\n);`,
    );
  });
});

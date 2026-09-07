// The send payload codec, and the two durable events that carry it.
import { describe, expect, test } from "bun:test";
import {
  decodeSendToUserPayloadV1,
  decodeSessionEvent,
  SEND_TO_USER_LIMITS_V1,
  type SendToUserPayloadV1,
} from "./index.js";

const AT = "2026-08-31T10:00:00.000Z";

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return { seq: 3, timestamp: AT, ...overrides };
}

describe("the send payload codec", () => {
  test("round-trips every declared payload type", () => {
    const payloads: SendToUserPayloadV1[] = [
      { type: "text", text: "Booked." },
      {
        type: "attachment",
        url: "https://files.example/receipt.pdf",
        name: "receipt.pdf",
        mediaType: "application/pdf",
      },
      {
        type: "widget",
        widget: {
          prompt: "Which one?",
          helpText: "Either is fine.",
          options: ["Tuesday", "Thursday"],
          allowCustom: true,
          dismissOnMoveOn: false,
        },
      },
      { type: "secret-request", prompt: "Your API key", secretName: "api_key" },
      { type: "agent-card", agentId: "bot-2", title: "School", body: "Term 3" },
      {
        type: "approval",
        approvalId: "ap-1",
        action: "Delete the staging database",
        rationale: "It has been idle for a month.",
        risk: "high",
        expiresInSeconds: 3_600,
      },
    ];

    for (const payload of payloads) {
      expect(decodeSendToUserPayloadV1(payload)).toEqual(payload);
    }
  });

  test("keeps optional fields absent rather than undefined", () => {
    expect(
      decodeSendToUserPayloadV1({
        type: "attachment",
        url: "https://files.example/a",
      }),
    ).toEqual({ type: "attachment", url: "https://files.example/a" });
    expect(
      decodeSendToUserPayloadV1({
        type: "widget",
        widget: { prompt: "Go?", options: ["Yes"] },
      }),
    ).toEqual({ type: "widget", widget: { prompt: "Go?", options: ["Yes"] } });
  });

  test("bounds an approval and refuses everything outside its exact keys", () => {
    const approval = {
      type: "approval" as const,
      approvalId: "ap-1",
      action: "Restart the host",
      risk: "medium" as const,
    };

    // A card with no rationale and no window is the common case, and the
    // absent fields stay absent rather than becoming undefined.
    expect(decodeSendToUserPayloadV1(approval)).toEqual(approval);
    expect(() =>
      decodeSendToUserPayloadV1({ ...approval, risk: "catastrophic" }),
    ).toThrow("risk must be low, medium or high");
    expect(() =>
      decodeSendToUserPayloadV1({ ...approval, decision: "approved" }),
    ).toThrow('unexpected key "decision"');
    expect(() =>
      decodeSendToUserPayloadV1({ ...approval, expiresInSeconds: 0 }),
    ).toThrow("expiresInSeconds");
    expect(() =>
      decodeSendToUserPayloadV1({ ...approval, expiresInSeconds: 1.5 }),
    ).toThrow("expiresInSeconds");
    // The id is a URL path segment and a durable key, so it is narrower than a
    // bounded string: an id that cannot be addressed cannot be answered.
    expect(() =>
      decodeSendToUserPayloadV1({ ...approval, approvalId: "ap 1" }),
    ).toThrow("approvalId must be letters");
    expect(() =>
      decodeSendToUserPayloadV1({
        ...approval,
        approvalId: "a".repeat(SEND_TO_USER_LIMITS_V1.approvalId + 1),
      }),
    ).toThrow("approvalId exceeds");
    expect(() =>
      decodeSendToUserPayloadV1({
        ...approval,
        action: "a".repeat(SEND_TO_USER_LIMITS_V1.action + 1),
      }),
    ).toThrow("action exceeds");
    const { risk: _risk, ...withoutRisk } = approval;
    expect(() => decodeSendToUserPayloadV1(withoutRisk)).toThrow("risk");
  });

  test("refuses an unknown type, a missing field and an extra key", () => {
    expect(() =>
      decodeSendToUserPayloadV1({ type: "sms", text: "hi" }),
    ).toThrow("send payload.type is invalid");
    expect(() => decodeSendToUserPayloadV1({ type: "text" })).toThrow(
      "send payload.text must be a string",
    );
    expect(() =>
      decodeSendToUserPayloadV1({ type: "text", text: "hi", tone: "warm" }),
    ).toThrow('send payload has an unexpected key "tone"');
    expect(() => decodeSendToUserPayloadV1("text")).toThrow(
      "send payload must be an object",
    );
    expect(() => decodeSendToUserPayloadV1(["text"])).toThrow(
      "send payload must be an object",
    );
  });

  test("bounds the widget at one to six distinct options", () => {
    const widget = (options: string[]) => ({
      type: "widget",
      widget: { prompt: "Pick", options },
    });

    expect(() => decodeSendToUserPayloadV1(widget([]))).toThrow(
      "must hold 1 to 6 entries",
    );
    expect(() =>
      decodeSendToUserPayloadV1(widget(["a", "b", "c", "d", "e", "f", "g"])),
    ).toThrow("must hold 1 to 6 entries");
    expect(() => decodeSendToUserPayloadV1(widget(["a", "a"]))).toThrow(
      "send payload.widget.options has duplicates",
    );
    expect(
      decodeSendToUserPayloadV1(widget(["a", "b", "c", "d", "e", "f"])),
    ).toMatchObject({ type: "widget" });
  });

  test("bounds every string it carries", () => {
    const limits = SEND_TO_USER_LIMITS_V1;
    expect(() =>
      decodeSendToUserPayloadV1({
        type: "text",
        text: "x".repeat(limits.text + 1),
      }),
    ).toThrow(`exceeds ${limits.text} characters`);
    expect(() => decodeSendToUserPayloadV1({ type: "text", text: "" })).toThrow(
      "send payload.text must not be empty",
    );
    expect(() =>
      decodeSendToUserPayloadV1({
        type: "widget",
        widget: { prompt: "p", options: ["x".repeat(limits.option + 1)] },
      }),
    ).toThrow(`exceeds ${limits.option} characters`);
  });

  test("refuses an attachment that is not an absolute http URL", () => {
    for (const url of ["/local/file.pdf", "not a url"]) {
      expect(() =>
        decodeSendToUserPayloadV1({ type: "attachment", url }),
      ).toThrow("send payload.url must be an absolute URL");
    }
    expect(() =>
      decodeSendToUserPayloadV1({
        type: "attachment",
        url: "javascript:alert(1)",
      }),
    ).toThrow("send payload.url must be an http or https URL");
  });

  test("names the field it refused", () => {
    expect(() =>
      decodeSendToUserPayloadV1(
        { type: "text", text: 1 },
        "send_to_user.input",
      ),
    ).toThrow("send_to_user.input.text must be a string");
  });
});

describe("the durable send and hand-off events", () => {
  test("decodes a recorded send and rejects a malformed payload", () => {
    const send = event({
      type: "send/to-user",
      turn: 4,
      step: 2,
      occurrenceId: "tool:4:2:0",
      payload: { type: "text", text: "Done." },
    });

    expect(decodeSessionEvent(send)).toEqual(send as never);
    expect(() =>
      decodeSessionEvent({ ...send, payload: { type: "text" } }),
    ).toThrow("session event.payload.text must be a string");
    expect(() => decodeSessionEvent({ ...send, occurrenceId: 4 })).toThrow(
      "session event.occurrenceId",
    );
  });

  test("decodes a recorded hand-off and requires its exact keys", () => {
    const wake = event({
      type: "wake/parent",
      turn: 4,
      step: 2,
      occurrenceId: "tool:4:2:0",
      message: "The invoice is paid.",
    });

    expect(decodeSessionEvent(wake)).toEqual(wake as never);
    expect(() =>
      decodeSessionEvent({ ...wake, payload: { type: "text", text: "x" } }),
    ).toThrow();
    const { message: _message, ...withoutMessage } = wake;
    expect(() => decodeSessionEvent(withoutMessage)).toThrow();
  });

  test("leaves an event recorded before sends existed decoding unchanged", () => {
    const started = event({ type: "step/start", turn: 4, step: 2 });

    expect(decodeSessionEvent(started)).toEqual(started as never);
  });
});

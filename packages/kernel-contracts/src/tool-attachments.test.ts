// Tool result attachments: what may be recorded, and what may not.
//
// The one rule worth a suite of its own is that resolved bytes are never
// durable. The session event log is one Durable Object value; a base64
// screenshot recorded in it would be a record that grows past what the object
// can hold, so the decoder refuses `dataBase64` on the durable side rather
// than trimming it somewhere further down.
import { describe, expect, test } from "bun:test";
import {
  decodeToolAttachmentsV1,
  decodeSessionEvent,
  type ToolAttachmentV1,
} from "./types.js";

const HASH = "a".repeat(64);

const attachment: ToolAttachmentV1 = {
  kind: "image",
  mediaType: "image/png",
  workspacePath: {
    root: {
      kind: "package-declared",
      userId: "user-1",
      packageId: "computer",
      rootId: "screenshots",
    },
    path: "bot-1/run-9-1.png",
  },
  contentHash: HASH,
  bytes: 2048,
};

describe("decodeToolAttachmentsV1", () => {
  test("accepts an exact image reference", () => {
    expect(decodeToolAttachmentsV1([attachment], "attachments", true)).toEqual([
      attachment,
    ]);
  });

  test("refuses resolved bytes on the durable side and accepts them in a request", () => {
    const resolved = [{ ...attachment, dataBase64: "AAAA" }];
    expect(() =>
      decodeToolAttachmentsV1(resolved, "attachments", true),
    ).toThrow(/never durable/);
    expect(decodeToolAttachmentsV1(resolved, "attachments", false)).toEqual(
      resolved,
    );
  });

  test("refuses an unknown media type, a bad hash, and an unknown field", () => {
    expect(() =>
      decodeToolAttachmentsV1(
        [{ ...attachment, mediaType: "application/pdf" }],
        "attachments",
        true,
      ),
    ).toThrow(/mediaType/);
    expect(() =>
      decodeToolAttachmentsV1(
        [{ ...attachment, contentHash: "short" }],
        "attachments",
        true,
      ),
    ).toThrow(/sha-256/);
    expect(() =>
      decodeToolAttachmentsV1(
        [{ ...attachment, extra: 1 }],
        "attachments",
        true,
      ),
    ).toThrow(/invalid fields/);
  });
});

describe("a recorded tool result", () => {
  test("carries its attachments through the session event decoder", () => {
    const event = {
      type: "tool/result" as const,
      seq: 0,
      timestamp: "2026-08-31T00:00:00.000Z",
      turn: 1,
      step: 1,
      occurrenceId: "1:1:0",
      name: "computer_screenshot",
      content: "{}",
      isError: false,
      status: "completed" as const,
      attachments: [attachment],
    };
    expect(decodeSessionEvent(event)).toMatchObject({
      attachments: [attachment],
    });
    expect(() =>
      decodeSessionEvent({
        ...event,
        attachments: [{ ...attachment, dataBase64: "AAAA" }],
      }),
    ).toThrow(/never durable/);
  });
});

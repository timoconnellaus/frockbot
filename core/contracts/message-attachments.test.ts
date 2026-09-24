import { describe, expect, test } from "bun:test";
import {
  decodeMessageAttachmentsV1,
  decodeUploadRefsV1,
  durableMessageAttachmentV1,
  messageAttachmentKindV1,
  userMessagePartsV1,
  type MessageAttachmentV1,
} from "./message-attachments.js";
import { decodeSessionEvent } from "./types.js";

const IMAGE: MessageAttachmentV1 = {
  kind: "image",
  uploadId: "a".repeat(64),
  name: "beach.jpg",
  mediaType: "image/jpeg",
  bytes: 482_113,
};
const DOCUMENT: MessageAttachmentV1 = {
  kind: "document",
  uploadId: "b".repeat(64),
  name: "Q3 report.pdf",
  mediaType: "application/pdf",
  bytes: 1_048_576,
};

describe("message attachments", () => {
  test("a media type names its kind, and an unknown one names none", () => {
    expect(messageAttachmentKindV1("image/webp")).toBe("image");
    expect(messageAttachmentKindV1("text/csv")).toBe("document");
    expect(messageAttachmentKindV1("application/zip")).toBeUndefined();
    expect(messageAttachmentKindV1("image/heic")).toBeUndefined();
  });

  test("refs are bounded, unique and exact", () => {
    expect(decodeUploadRefsV1([{ uploadId: IMAGE.uploadId }])).toEqual([
      { uploadId: IMAGE.uploadId },
    ]);
    expect(() => decodeUploadRefsV1([])).toThrow();
    expect(() =>
      decodeUploadRefsV1(
        [..."abcdef"].map((c) => ({ uploadId: c.repeat(64) })),
      ),
    ).toThrow(/at most 5/);
    expect(() =>
      decodeUploadRefsV1([
        { uploadId: IMAGE.uploadId },
        { uploadId: IMAGE.uploadId },
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      decodeUploadRefsV1([{ uploadId: IMAGE.uploadId, name: "x" }]),
    ).toThrow();
    expect(() => decodeUploadRefsV1([{ uploadId: "beach.jpg" }])).toThrow();
  });

  test("a durable decode refuses resolved bytes and text", () => {
    expect(
      decodeMessageAttachmentsV1([IMAGE, DOCUMENT], "attachments", true),
    ).toEqual([IMAGE, DOCUMENT]);
    expect(() =>
      decodeMessageAttachmentsV1(
        [{ ...IMAGE, dataBase64: "AAAA" }],
        "attachments",
        true,
      ),
    ).toThrow();
    expect(() =>
      decodeMessageAttachmentsV1(
        [{ ...DOCUMENT, text: "words" }],
        "attachments",
        true,
      ),
    ).toThrow();
    expect(
      decodeMessageAttachmentsV1(
        [{ ...IMAGE, dataBase64: "AAAA" }],
        "attachments",
        false,
      ),
    ).toEqual([{ ...IMAGE, dataBase64: "AAAA" }]);
  });

  test("the kind must match the media type, and a name is one segment", () => {
    for (const bad of [
      { ...IMAGE, kind: "document" },
      { ...IMAGE, mediaType: "image/svg+xml" },
      { ...IMAGE, name: "../etc/passwd" },
      { ...IMAGE, name: "a\nb" },
      { ...IMAGE, name: "   " },
      { ...IMAGE, bytes: 0 },
      { ...IMAGE, bytes: 21 * 1024 * 1024 },
    ]) {
      expect(() =>
        decodeMessageAttachmentsV1([bad], "attachments", true),
      ).toThrow();
    }
  });

  test("the durable reference drops what a dispatch resolved", () => {
    expect(
      durableMessageAttachmentV1({ ...DOCUMENT, text: "the whole report" }),
    ).toEqual(DOCUMENT);
  });

  test("a user message's parts show what can be shown and name the rest", () => {
    const parts = userMessagePartsV1(
      {
        content: "What do you make of these?",
        attachments: [
          { ...IMAGE, dataBase64: "AAAA" },
          { ...DOCUMENT, text: "Revenue rose." },
          { ...IMAGE, uploadId: "c".repeat(64), name: "old.png" },
        ],
      },
      { images: true },
    );
    expect(parts[0]).toEqual({
      type: "text",
      text: "What do you make of these?",
    });
    expect(parts[1]).toEqual({
      type: "image",
      mediaType: "image/jpeg",
      dataBase64: "AAAA",
      name: "beach.jpg",
    });
    expect(parts[2]).toEqual({
      type: "text",
      text: '<attachment name="Q3 report.pdf" type="application/pdf">\nRevenue rose.\n</attachment>',
    });
    expect(parts[3]).toMatchObject({
      type: "text",
      text: expect.stringContaining("It is not shown in this request."),
    });
  });

  test("a model that cannot see images is told one was attached", () => {
    const parts = userMessagePartsV1(
      { content: "", attachments: [{ ...IMAGE, dataBase64: "AAAA" }] },
      { images: false },
    );
    expect(parts).toEqual([
      {
        type: "text",
        text: '[Image "beach.jpg" (image/jpeg, 471 KB) is attached to this message. This model cannot see images.]',
      },
    ]);
  });

  test("session events carry references and nothing more", () => {
    const base = {
      seq: 3,
      timestamp: "2026-09-24T00:00:00.000Z",
    };
    expect(
      decodeSessionEvent({
        ...base,
        type: "user/message",
        turn: 1,
        step: 1,
        messageId: "m-1",
        text: "",
        attachments: [IMAGE],
      }),
    ).toMatchObject({ attachments: [IMAGE] });
    expect(() =>
      decodeSessionEvent({
        ...base,
        type: "input/queued",
        messageId: "m-1",
        text: "",
        attachments: [{ ...IMAGE, dataBase64: "AAAA" }],
      }),
    ).toThrow();
  });
});

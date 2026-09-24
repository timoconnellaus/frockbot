import { describe, expect, test } from "bun:test";
import {
  DOCX_MEDIA_TYPE_V1,
  PPTX_MEDIA_TYPE_V1,
} from "@frockbot/core/contracts";
import {
  classifyUploadV1,
  decodeStoredUploadV1,
  normalizeUploadNameV1,
  uploadObjectKeyV1,
  uploadTextKeyV1,
} from "./shared.js";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0]);
const HEIC = new Uint8Array([
  0,
  0,
  0,
  24,
  ...new TextEncoder().encode("ftypheic"),
  0,
  0,
]);
const text = (value: string) => new TextEncoder().encode(value);

describe("what an upload is", () => {
  test("the bytes decide an image, whatever it is called", () => {
    expect(classifyUploadV1({ name: "photo.png", bytes: JPEG })).toEqual({
      status: "ok",
      kind: "image",
      mediaType: "image/jpeg",
    });
    expect(
      classifyUploadV1({
        name: "screen",
        declaredType: "application/octet-stream",
        bytes: PNG,
      }),
    ).toEqual({ status: "ok", kind: "image", mediaType: "image/png" });
    expect(classifyUploadV1({ name: "report", bytes: PDF })).toEqual({
      status: "ok",
      kind: "document",
      mediaType: "application/pdf",
    });
  });

  test("a ZIP is only ever an Office document", () => {
    expect(classifyUploadV1({ name: "deck.pptx", bytes: ZIP })).toEqual({
      status: "ok",
      kind: "document",
      mediaType: PPTX_MEDIA_TYPE_V1,
    });
    expect(
      classifyUploadV1({
        name: "letter",
        declaredType: DOCX_MEDIA_TYPE_V1,
        bytes: ZIP,
      }),
    ).toEqual({
      status: "ok",
      kind: "document",
      mediaType: DOCX_MEDIA_TYPE_V1,
    });
    expect(classifyUploadV1({ name: "photos.zip", bytes: ZIP })).toMatchObject({
      status: "refused",
    });
  });

  test("HEIC is refused with the way through", () => {
    expect(classifyUploadV1({ name: "IMG_1.heic", bytes: HEIC })).toEqual({
      status: "refused",
      reason: expect.stringContaining("JPEG"),
    });
  });

  test("text is text when its name says so and it decodes", () => {
    expect(
      classifyUploadV1({ name: "main.py", bytes: text("print('hi')\n") }),
    ).toEqual({ status: "ok", kind: "document", mediaType: "text/plain" });
    expect(
      classifyUploadV1({ name: "notes.md", bytes: text("# Notes") }),
    ).toEqual({ status: "ok", kind: "document", mediaType: "text/markdown" });
    expect(
      classifyUploadV1({ name: "data.csv", bytes: text("a,b\n1,2") }),
    ).toEqual({ status: "ok", kind: "document", mediaType: "text/csv" });
    expect(
      classifyUploadV1({ name: "Dockerfile", bytes: text("FROM node") }),
    ).toEqual({ status: "ok", kind: "document", mediaType: "text/plain" });
    // A binary with a text name is not text.
    expect(
      classifyUploadV1({
        name: "notes.txt",
        bytes: new Uint8Array([0x66, 0x00, 0x6f]),
      }),
    ).toMatchObject({ status: "refused" });
    // Readable bytes with no reason to read them are not a document.
    expect(
      classifyUploadV1({ name: "program.exe", bytes: text("MZ") }),
    ).toMatchObject({ status: "refused" });
  });

  test("a name is its last segment, cleaned and bounded", () => {
    expect(normalizeUploadNameV1("C:\\Users\\me\\report.pdf")).toBe(
      "report.pdf",
    );
    expect(normalizeUploadNameV1("../../etc/passwd")).toBe("passwd");
    expect(normalizeUploadNameV1("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(normalizeUploadNameV1("   ")).toBe("file");
    expect(normalizeUploadNameV1(null)).toBe("file");
    expect(normalizeUploadNameV1("x".repeat(400))).toHaveLength(255);
  });

  test("keys live under the Bot's own prefix", () => {
    const id = "c".repeat(64);
    expect(uploadObjectKeyV1("user-1", "bot-1", id)).toBe(
      `uploads/user-1/bot-1/${id}`,
    );
    expect(uploadTextKeyV1("user-1", "bot-1", id)).toBe(
      `uploads/user-1/bot-1/${id}.md`,
    );
    expect(() => uploadObjectKeyV1("user-1", "bot-1", "../x")).toThrow();
  });

  test("a stored record decodes exactly", () => {
    const record = {
      schemaVersion: 1,
      uploadId: "c".repeat(64),
      kind: "document",
      name: "notes.md",
      mediaType: "text/markdown",
      bytes: 7,
      uploadedAt: "2026-09-24T00:00:00.000Z",
      textChars: 7,
    };
    expect(decodeStoredUploadV1(record)).toEqual(record as never);
    expect(() => decodeStoredUploadV1({ ...record, kind: "image" })).toThrow();
    expect(() => decodeStoredUploadV1({ ...record, extra: 1 })).toThrow();
  });
});

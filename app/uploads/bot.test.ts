import { describe, expect, test } from "bun:test";
import {
  createUploadReaderV1,
  recordUploadV1,
  resolveUploadRefsV1,
  UploadNotFoundError,
  type UploadBucketV1,
} from "./bot.js";
import type { StoredUploadV1 } from "./shared.js";

const upload: StoredUploadV1 = {
  schemaVersion: 1,
  uploadId: "a".repeat(64),
  kind: "image",
  name: "beach.jpg",
  mediaType: "image/jpeg",
  bytes: 482_113,
  uploadedAt: "2026-09-24T00:00:00.000Z",
};

function storage() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

describe("the uploads a Bot holds", () => {
  test("a ref resolves to the attachment the Bot recorded", async () => {
    const held = storage();
    await recordUploadV1(held, upload);
    expect(
      await resolveUploadRefsV1(held, [{ uploadId: upload.uploadId }]),
    ).toEqual([
      {
        kind: "image",
        uploadId: upload.uploadId,
        name: "beach.jpg",
        mediaType: "image/jpeg",
        bytes: 482_113,
      },
    ]);
    expect(await resolveUploadRefsV1(held, undefined)).toBeUndefined();
  });

  test("a ref to a file this Bot was never given is refused", async () => {
    const held = storage();
    await expect(
      resolveUploadRefsV1(held, [{ uploadId: "b".repeat(64) }]),
    ).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  test("the latest name wins, and a bad record is refused before it lands", async () => {
    const held = storage();
    await recordUploadV1(held, upload);
    await recordUploadV1(held, { ...upload, name: "sunset.jpg" });
    const [attachment] = (await resolveUploadRefsV1(held, [
      { uploadId: upload.uploadId },
    ]))!;
    expect(attachment!.name).toBe("sunset.jpg");
    await expect(
      recordUploadV1(held, { ...upload, kind: "document" }),
    ).rejects.toThrow();
  });

  test("an excerpt reads only the front of the text, and knows its length", async () => {
    const ranges: unknown[] = [];
    const text = "é".repeat(50);
    const bucket: UploadBucketV1 = {
      get: async (key, options) => {
        ranges.push({ key, range: options?.range });
        const bytes = new TextEncoder().encode(text);
        const slice = options?.range
          ? bytes.subarray(0, options.range.length)
          : bytes;
        return {
          arrayBuffer: async () =>
            slice.buffer.slice(
              slice.byteOffset,
              slice.byteOffset + slice.byteLength,
            ) as ArrayBuffer,
          customMetadata: { chars: "50" },
        };
      },
    };
    const reader = createUploadReaderV1(bucket, {
      userId: "user-1",
      botId: "bot-1",
    });
    expect(await reader.excerpt(upload.uploadId, 10)).toEqual({
      text: "é".repeat(10),
      chars: 50,
    });
    expect(ranges).toEqual([
      {
        key: `uploads/user-1/bot-1/${upload.uploadId}.md`,
        range: { offset: 0, length: 40 },
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  createUploadReaderV1,
  findBotUploadsV1,
  keepBotFilesV1,
  recordUploadV1,
  removeBotFilesV1,
  resolveUploadRefsV1,
  UploadNotFoundError,
  type BotFileStoreV1,
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

describe("finding the files a list names", () => {
  function listed() {
    const held = storage();
    return {
      ...held,
      list: async <T>(options: { prefix: string }) =>
        new Map(
          [...held.values.entries()].filter(([key]) =>
            key.startsWith(options.prefix),
          ),
        ) as Map<string, T>,
    };
  }

  test("by upload id, or by name meaning the newest file of that name", async () => {
    const held = listed();
    await recordUploadV1(held, upload);
    await recordUploadV1(held, {
      ...upload,
      uploadId: "b".repeat(64),
      uploadedAt: "2026-09-25T00:00:00.000Z",
    });
    await recordUploadV1(held, {
      ...upload,
      uploadId: "c".repeat(64),
      name: "notes.png",
    });

    const found = await findBotUploadsV1(held, [
      "beach.jpg",
      "c".repeat(64),
      "b".repeat(64),
    ]);
    expect(found.status).toBe("ok");
    if (found.status !== "ok") return;
    // The newest beach.jpg, and each file once.
    expect(found.attachments.map((attachment) => attachment.uploadId)).toEqual([
      "b".repeat(64),
      "c".repeat(64),
    ]);
  });

  test("says which entry names nothing this Bot holds", async () => {
    const held = listed();
    await recordUploadV1(held, upload);
    expect(await findBotUploadsV1(held, ["beach.jpg", "gone.pdf"])).toEqual({
      status: "missing",
      entry: "gone.pdf",
    });
    expect(await findBotUploadsV1(held, ["f".repeat(64)])).toEqual({
      status: "missing",
      entry: "f".repeat(64),
    });
    expect(await findBotUploadsV1(held, [])).toEqual({
      status: "ok",
      attachments: [],
    });
  });
});

describe("the files a Bot keeps of its own", () => {
  const owner = { userId: "user-1", botId: "bot-1" };

  function fileStore(full = false) {
    const held = storage();
    const objects = new Map<string, Uint8Array | string>();
    const reserved: string[] = [];
    const released: string[][] = [];
    const store: BotFileStoreV1 = {
      bucket: {
        put: async (key, value) => {
          objects.set(key, value);
        },
        delete: async (keys) => {
          for (const key of keys) objects.delete(key);
        },
      },
      storage: {
        ...held,
        delete: async (key) => held.values.delete(key),
      },
      reserveQuota: async ({ uploadId, bytes }) => {
        reserved.push(uploadId);
        return full
          ? { status: "full", usedBytes: 0, quotaBytes: bytes }
          : { status: "reserved", usedBytes: bytes };
      },
      releaseQuota: async (uploadIds) => {
        released.push(uploadIds);
      },
      now: () => new Date("2026-09-24T00:00:00.000Z"),
    };
    return { store, held, objects, reserved, released };
  }

  const log = {
    name: "demonstration-0123456789abcdef.json",
    mediaType: "application/json",
    bytes: new TextEncoder().encode('{"steps":[]}\n'),
    text: '{"steps":[]}\n',
  };
  const shot = {
    name: "demonstration-0123456789abcdef-screenshot-1.jpg",
    mediaType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]),
  };

  test("are kept like an attached file: counted, stored, and recorded for a message to name", async () => {
    const { store, held, objects, reserved } = fileStore();
    const kept = await keepBotFilesV1(store, owner, [log, shot]);

    expect(kept.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "document", name: log.name },
      { kind: "image", name: shot.name },
    ]);
    expect(reserved).toEqual(kept.map((attachment) => attachment.uploadId));
    // The document's text sits beside its bytes, where a request reads it.
    expect(objects.get(`uploads/user-1/bot-1/${kept[0]!.uploadId}.md`)).toBe(
      log.text,
    );
    expect(
      await resolveUploadRefsV1(
        held,
        kept.map(({ uploadId }) => ({ uploadId })),
      ),
    ).toEqual(kept);
  });

  test("a full account keeps nothing and says so", async () => {
    const { store, objects } = fileStore(true);
    await expect(keepBotFilesV1(store, owner, [shot])).rejects.toThrow(
      "upload space",
    );
    expect(objects.size).toBe(0);
  });

  test("are deleted with their text, their records and their space", async () => {
    const { store, held, objects, released } = fileStore();
    const kept = await keepBotFilesV1(store, owner, [log, shot]);
    const ids = kept.map(({ uploadId }) => uploadId);
    await removeBotFilesV1(store, owner, [...ids, ids[0]!]);

    expect(objects.size).toBe(0);
    expect(released).toEqual([ids]);
    await expect(
      resolveUploadRefsV1(held, [{ uploadId: ids[0]! }]),
    ).rejects.toBeInstanceOf(UploadNotFoundError);
  });
});

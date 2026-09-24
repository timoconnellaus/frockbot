import { describe, expect, test } from "bun:test";
import {
  releaseBotUploadQuotaV1,
  reserveUploadQuotaV1,
  UPLOAD_QUOTA_TOTAL_KEY_V1,
  type UploadQuotaStorageV1,
} from "./quota.js";

function memory(): UploadQuotaStorageV1 & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (keys) => {
      let removed = 0;
      for (const key of keys) if (values.delete(key)) removed += 1;
      return removed;
    },
    list: async <T>(options: { prefix: string; limit?: number }) =>
      new Map(
        [...values.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, options.limit ?? Number.POSITIVE_INFINITY),
      ) as Map<string, T>,
  };
}

const id = (c: string) => c.repeat(64);

describe("the account's upload space", () => {
  test("one file sent to one Bot counts once", async () => {
    const storage = memory();
    const upload = { botId: "bot-1", uploadId: id("a"), bytes: 100 };
    expect(await reserveUploadQuotaV1(storage, upload, 1_000)).toEqual({
      status: "reserved",
      usedBytes: 100,
    });
    expect(await reserveUploadQuotaV1(storage, upload, 1_000)).toEqual({
      status: "reserved",
      usedBytes: 100,
    });
    // The same bytes held by another Bot are that Bot's too.
    await reserveUploadQuotaV1(storage, { ...upload, botId: "bot-2" }, 1_000);
    expect(storage.values.get(UPLOAD_QUOTA_TOTAL_KEY_V1)).toBe(200);
  });

  test("a file past the account's space is refused and counts nothing", async () => {
    const storage = memory();
    await reserveUploadQuotaV1(
      storage,
      { botId: "bot-1", uploadId: id("a"), bytes: 900 },
      1_000,
    );
    expect(
      await reserveUploadQuotaV1(
        storage,
        { botId: "bot-1", uploadId: id("b"), bytes: 200 },
        1_000,
      ),
    ).toEqual({ status: "full", usedBytes: 900, quotaBytes: 1_000 });
    expect(storage.values.get(UPLOAD_QUOTA_TOTAL_KEY_V1)).toBe(900);
  });

  test("a deleted Bot's files give their space back, page by page", async () => {
    const storage = memory();
    for (const c of "abc") {
      await reserveUploadQuotaV1(storage, {
        botId: "bot-1",
        uploadId: id(c),
        bytes: 10,
      });
    }
    await reserveUploadQuotaV1(storage, {
      botId: "bot-2",
      uploadId: id("d"),
      bytes: 5,
    });
    expect(await releaseBotUploadQuotaV1(storage, "bot-1", 2)).toEqual({
      released: 20,
      more: true,
    });
    expect(await releaseBotUploadQuotaV1(storage, "bot-1", 2)).toEqual({
      released: 10,
      more: false,
    });
    expect(await releaseBotUploadQuotaV1(storage, "bot-1", 2)).toEqual({
      released: 0,
      more: false,
    });
    expect(storage.values.get(UPLOAD_QUOTA_TOTAL_KEY_V1)).toBe(5);
  });
});

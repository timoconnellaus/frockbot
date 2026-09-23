import { describe, expect, test } from "bun:test";
import {
  COMPUTER_SCREENSHOT_CLEANUP_PAGE_V1,
  COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1,
  cleanRetiredComputerScreenshotsV1,
} from "./computer-screenshot-cleanup.js";

const PREFIX = "workspace/package-declared:user-1:computer:screenshots/bob/";

function storage() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function bucket(keys: string[]) {
  const objects = new Set(keys);
  return {
    objects,
    list: ({
      prefix,
      limit,
      cursor,
    }: {
      prefix: string;
      limit: number;
      cursor?: string;
    }) => {
      const all = [...objects].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? all.findIndex((key) => key > cursor) : 0;
      const page = start < 0 ? [] : all.slice(start, start + limit);
      const truncated = start >= 0 && start + limit < all.length;
      return Promise.resolve({
        keys: page,
        truncated,
        ...(truncated ? { cursor: page[page.length - 1] } : {}),
      });
    },
    delete: (key: string) => {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}

describe("retired Computer screenshots", () => {
  test("removes this Bot's screenshot objects once, and nobody else's", async () => {
    const kept = [
      "workspace/package-declared:user-1:computer:screenshots/bobby/user-1.png",
      "workspace/package-declared:user-1:image:generated/cat.png",
    ];
    const objects = bucket([
      `${PREFIX}user-1.png`,
      `${PREFIX}user-2.png`,
      `${PREFIX}user-2.png.conflict/g-1`,
      ...kept,
    ]);
    const records = storage();

    expect(
      await cleanRetiredComputerScreenshotsV1(records, objects, PREFIX),
    ).toBe(3);
    expect([...objects.objects].sort()).toEqual([...kept].sort());
    expect(records.values.get(COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1)).toEqual({
      schemaVersion: 1,
      done: true,
      prefix: PREFIX,
      removed: 3,
    });

    objects.objects.add(`${PREFIX}user-3.png`);
    expect(
      await cleanRetiredComputerScreenshotsV1(records, objects, PREFIX),
    ).toBe(0);
  });

  test("a long backlog is removed a bounded run at a time and resumes where it stopped", async () => {
    const total = COMPUTER_SCREENSHOT_CLEANUP_PAGE_V1 * 5;
    const objects = bucket(
      Array.from(
        { length: total },
        (_, index) => `${PREFIX}${String(index).padStart(4, "0")}.png`,
      ),
    );
    const records = storage();

    const first = await cleanRetiredComputerScreenshotsV1(
      records,
      objects,
      PREFIX,
    );
    expect(first).toBe(COMPUTER_SCREENSHOT_CLEANUP_PAGE_V1 * 4);
    expect(
      records.values.get(COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1),
    ).toMatchObject({ done: false });

    await cleanRetiredComputerScreenshotsV1(records, objects, PREFIX);
    expect(objects.objects.size).toBe(0);
    expect(
      records.values.get(COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1),
    ).toMatchObject({ done: true });
  });
});

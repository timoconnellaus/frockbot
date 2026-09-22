import { describe, expect, test } from "bun:test";
import {
  cleanRetiredMemoryFactObjectsV1,
  isRetiredMemoryFactObjectKeyV1,
} from "./cleanup.ts";

describe("retired memory fact objects", () => {
  test("profile and log files are fact roots; other workspace files are not", () => {
    expect(
      isRetiredMemoryFactObjectKeyV1(
        "bot-memory:u:b/by-agent/b/profile.md",
      ),
    ).toBe(true);
    expect(
      isRetiredMemoryFactObjectKeyV1("bot-memory:u:b/by-agent/b/log/2026-09.md"),
    ).toBe(true);
    expect(
      isRetiredMemoryFactObjectKeyV1("bot-instructions:u:b/skills/kiln/SKILL.md"),
    ).toBe(false);
    expect(
      isRetiredMemoryFactObjectKeyV1("user-memory:u/notes/ordinary.txt"),
    ).toBe(false);
  });

  test("cleanup deletes a bounded page and can resume", async () => {
    const objects = [
      "user-memory:u/by-agent/b/profile.md",
      "user-memory:u/by-agent/b/log/2026-09.md",
      "user-memory:u/by-agent/b/readme.txt",
    ];
    const storage = new Map<string, unknown>();
    let listed = 0;
    const removed = await cleanRetiredMemoryFactObjectsV1(
      {
        get: async (key) => storage.get(key),
        put: async (key, value) => {
          storage.set(key, value);
        },
      },
      {
        list: async () => {
          listed += 1;
          return { keys: [...objects], truncated: false };
        },
        delete: async (key) => {
          const index = objects.indexOf(key);
          if (index >= 0) objects.splice(index, 1);
        },
      },
      "user-memory:u/",
    );
    expect(removed).toBe(2);
    expect(objects).toEqual(["user-memory:u/by-agent/b/readme.txt"]);
    const again = await cleanRetiredMemoryFactObjectsV1(
      {
        get: async (key) => storage.get(key),
        put: async (key, value) => {
          storage.set(key, value);
        },
      },
      {
        list: async () => {
          listed += 1;
          return { keys: [...objects], truncated: false };
        },
        delete: async () => {
          throw new Error("completed cleanup must not list again");
        },
      },
      "user-memory:u/",
    );
    expect(again).toBe(0);
    expect(listed).toBe(1);
  });
});

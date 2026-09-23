import { describe, expect, test } from "bun:test";
import {
  ACTIVE_RUN_KEY,
  pendingUserRunKey,
  RUN_PREFIX,
  runIndexKey,
} from "@frockbot/core/durable";
import { cleanUnpreparedRunsV1 } from "./prepared-input-cleanup.js";

function storageFrom(initial: Record<string, unknown>) {
  const held = new Map(Object.entries(initial));
  return {
    held,
    get: async (key: string) => held.get(key),
    put: async (key: string, value: unknown) => {
      held.set(key, value);
    },
    delete: async (key: string) => held.delete(key),
    list: async (options: {
      prefix?: string;
      limit?: number;
      start?: string;
    }) => {
      const entries = [...held.entries()]
        .filter(([key]) => {
          if (options.prefix && !key.startsWith(options.prefix)) return false;
          if (options.start !== undefined && key < options.start) return false;
          return true;
        })
        .sort(([left], [right]) => left.localeCompare(right));
      const limited =
        options.limit === undefined ? entries : entries.slice(0, options.limit);
      return new Map(limited);
    },
  };
}

function run(status: string, prepared = false) {
  return {
    runId: status,
    status,
    phase: status === "running" ? "executing" : "admitted",
    ...(prepared ? { preparedInputs: { schemaVersion: 1 } } : {}),
  };
}

describe("prepared input cleanup", () => {
  test("removes non-terminal runs that have no admitted preparation", async () => {
    const storage = storageFrom({
      [`${RUN_PREFIX}running`]: run("running"),
      [`${RUN_PREFIX}completed`]: run("completed"),
      [`${RUN_PREFIX}prepared`]: run("prepared", true),
      [ACTIVE_RUN_KEY]: "running",
      [pendingUserRunKey("2026-09-22T00:00:00.000Z", "running")]: "running",
      [runIndexKey("2026-09-22T00:00:00.000Z", "running")]: "running",
      [runIndexKey("2026-09-22T00:00:00.000Z", "completed")]: "completed",
    });

    await cleanUnpreparedRunsV1(storage);

    expect(await storage.get(`${RUN_PREFIX}running`)).toBeUndefined();
    expect(await storage.get(`${RUN_PREFIX}completed`)).toMatchObject({
      status: "completed",
    });
    expect(await storage.get(`${RUN_PREFIX}prepared`)).toMatchObject({
      preparedInputs: { schemaVersion: 1 },
    });
    expect(await storage.get(ACTIVE_RUN_KEY)).toBeUndefined();
    expect(
      await storage.get(
        pendingUserRunKey("2026-09-22T00:00:00.000Z", "running"),
      ),
    ).toBeUndefined();
    expect(
      await storage.get(runIndexKey("2026-09-22T00:00:00.000Z", "running")),
    ).toBeUndefined();
    expect(
      await storage.get(runIndexKey("2026-09-22T00:00:00.000Z", "completed")),
    ).toBe("completed");

    await storage.put(`${RUN_PREFIX}later`, run("running"));
    await cleanUnpreparedRunsV1(storage);
    expect(await storage.get(`${RUN_PREFIX}later`)).toMatchObject({
      status: "running",
    });
  });
});

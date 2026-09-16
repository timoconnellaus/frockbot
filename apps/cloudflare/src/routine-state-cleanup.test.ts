import { describe, expect, test } from "bun:test";
import {
  ROUTINE_PREFIX,
  routineFireKeyV1,
  routineHookKeyRecordV1,
  routineQueueKeyV1,
  routineRunKeyV1,
  routineScheduleKeyV1,
} from "@frockbot/app/routines/storage-keys";
import { cleanRetiredRoutineStateV1 } from "./routine-state-cleanup.js";

function storage(initial: Record<string, unknown>) {
  const held = new Map(Object.entries(initial));
  const api = {
    get: async (key: string) => held.get(key),
    put: async (key: string, value: unknown) => void held.set(key, value),
    delete: async (keys: string | string[]) => {
      const targets = Array.isArray(keys) ? keys : [keys];
      let deleted = 0;
      for (const key of targets) if (held.delete(key)) deleted++;
      return deleted;
    },
    list: async ({ prefix = "", limit }: { prefix?: string; limit?: number }) =>
      new Map(
        [...held.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, limit),
      ),
  };
  return {
    held,
    durable: {
      ...api,
      transaction: async <T>(run: (tx: typeof api) => Promise<T>) => run(api),
    } as unknown as DurableObjectStorage,
  };
}

const readable = {
  schemaVersion: 1,
  routineId: "kept",
  name: "Kept",
  prompt: "Still works.",
  schedule: "0 8 * * *",
  enabled: true,
  createdBy: { kind: "user" },
  updatedBy: { kind: "user" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("retired Routine cleanup", () => {
  test("keeps readable Routines and removes an unreadable Routine's firing state", async () => {
    const stale = "stale";
    const { schedule: _schedule, ...staleBase } = readable;
    const subject = storage({
      [`${ROUTINE_PREFIX}kept`]: readable,
      [`${ROUTINE_PREFIX}${stale}`]: {
        ...staleBase,
        routineId: stale,
        trigger: { kind: "connection", connectionId: "old" },
      },
      [routineHookKeyRecordV1(stale)]: { old: true },
      [routineScheduleKeyV1(stale)]: { old: true },
      [routineFireKeyV1(stale)]: { old: true },
      [routineQueueKeyV1(stale, 0)]: { old: true },
      [routineRunKeyV1(stale, 0)]: { old: true },
    });

    await cleanRetiredRoutineStateV1(subject.durable);

    expect(subject.held.get(`${ROUTINE_PREFIX}kept`)).toEqual(readable);
    expect(
      [...subject.held.keys()].filter((key) => key.includes(stale)),
    ).toEqual([]);
    expect(
      subject.held.get("maintenance:retired-routine-state:2026-09-16"),
    ).toMatchObject({ retired: 1, deleted: 6 });
  });

  test("runs once", async () => {
    const subject = storage({ [`${ROUTINE_PREFIX}kept`]: readable });
    await cleanRetiredRoutineStateV1(subject.durable);
    subject.held.set(`${ROUTINE_PREFIX}later`, { retired: true });
    await cleanRetiredRoutineStateV1(subject.durable);
    expect(subject.held.has(`${ROUTINE_PREFIX}later`)).toBeTrue();
  });
});

import { describe, expect, test } from "bun:test";
import { RoutineStore, RoutineNotFoundError } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import { ROUTINE_RUN_LOG_LIMIT } from "./storage-keys.js";
import type { RoutineCommandV1 } from "./shared.js";
import type { RoutineRunEntryV1, RoutineWriterV1 } from "./records.js";

const USER: RoutineWriterV1 = { kind: "user" };
const BOT: RoutineWriterV1 = {
  kind: "bot",
  botId: "scout",
  sessionId: "tim:scout",
  turnId: "turn-7",
};

function store(): RoutineStore {
  return new RoutineStore(createMemoryRoutineStorageV1(), {
    defaultTimezone: "Australia/Sydney",
  });
}

function create(
  overrides: Partial<
    Extract<RoutineCommandV1, { type: "routine/create" }>
  > = {},
): RoutineCommandV1 {
  return {
    schemaVersion: 1,
    type: "routine/create",
    commandId: "cmd-1",
    botId: "scout",
    routineId: "brief",
    name: "Morning brief",
    prompt: "Summarize overnight email.",
    schedule: "0 7 * * *",
    ...overrides,
  };
}

describe("RoutineStore.execute", () => {
  test("creates a Routine, records its writer, and lists it", async () => {
    const routines = store();
    const receipt = await routines.execute(create(), USER);
    expect(receipt).toMatchObject({ status: "applied" });
    if (receipt.status !== "applied") throw new Error("unreachable");
    expect(receipt.routine).toMatchObject({
      routineId: "brief",
      enabled: true,
      timezone: "Australia/Sydney",
      createdBy: { kind: "user" },
      updatedBy: { kind: "user" },
    });
    const listed = await routines.list("scout");
    expect(listed.routines).toHaveLength(1);
  });

  test("records a Bot writer as the Bot, and the view names no Session", async () => {
    const routines = store();
    const receipt = await routines.execute(create(), BOT);
    if (receipt.status !== "applied") throw new Error("unreachable");
    expect(receipt.routine.createdBy).toEqual({ kind: "bot", botId: "scout" });
    const stored = await routines.read("brief");
    expect(stored?.createdBy).toEqual(BOT);
  });

  test("replays one command id and refuses a reused id with new bytes", async () => {
    const routines = store();
    const first = await routines.execute(create(), USER);
    const replay = await routines.execute(create(), USER);
    expect(replay).toEqual(first);
    expect((await routines.list("scout")).routines).toHaveLength(1);
    await expect(
      routines.execute(create({ name: "Something else" }), USER),
    ).rejects.toThrow(/was reused for a different command/);
  });

  test("updates only the fields the command carries", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    const receipt = await routines.execute(
      {
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-2",
        botId: "scout",
        routineId: "brief",
        prompt: "Summarize overnight email and calendar.",
      },
      BOT,
    );
    if (receipt.status !== "applied") throw new Error("unreachable");
    expect(receipt.routine).toMatchObject({
      name: "Morning brief",
      prompt: "Summarize overnight email and calendar.",
      schedule: "0 7 * * *",
      updatedBy: { kind: "bot", botId: "scout" },
      createdBy: { kind: "user" },
    });
  });

  test("naming a trigger on an update clears the schedule, and the reverse", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    const toWebhook = await routines.execute(
      {
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-2",
        botId: "scout",
        routineId: "brief",
        trigger: { kind: "webhook" },
      },
      USER,
    );
    if (toWebhook.status !== "applied") throw new Error("unreachable");
    expect(toWebhook.routine.schedule).toBeUndefined();
    expect(toWebhook.routine.trigger).toEqual({ kind: "webhook" });

    const back = await routines.execute(
      {
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-3",
        botId: "scout",
        routineId: "brief",
        schedule: "@daily",
      },
      USER,
    );
    if (back.status !== "applied") throw new Error("unreachable");
    expect(back.routine.trigger).toBeUndefined();
    expect(back.routine.schedule).toBe("@daily");
  });

  test("pause and resume move only `enabled`", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    const paused = await routines.execute(
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-2",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    if (paused.status !== "applied") throw new Error("unreachable");
    expect(paused.routine.enabled).toBe(false);
    const resumed = await routines.execute(
      {
        schemaVersion: 1,
        type: "routine/resume",
        commandId: "cmd-3",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    if (resumed.status !== "applied") throw new Error("unreachable");
    expect(resumed.routine.enabled).toBe(true);
  });

  test("delete removes the record and its run log", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    await routines.recordRun(runEntry(1));
    const receipt = await routines.execute(
      {
        schemaVersion: 1,
        type: "routine/delete",
        commandId: "cmd-2",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    expect(receipt).toMatchObject({ status: "deleted", routineId: "brief" });
    expect((await routines.list("scout")).routines).toHaveLength(0);
    await expect(routines.listRuns("scout", "brief")).rejects.toThrow(
      RoutineNotFoundError,
    );
  });

  test("refuses a write whose cron or time zone cannot be parsed", async () => {
    const routines = store();
    await expect(
      routines.execute(create({ schedule: "not a cron" }), USER),
    ).rejects.toThrow(/five fields/);
    await expect(
      routines.execute(
        create({ commandId: "cmd-tz", timezone: "Mars/Olympus" }),
        USER,
      ),
    ).rejects.toThrow(/not an IANA time zone/);
    expect((await routines.list("scout")).routines).toHaveLength(0);
  });

  test("acting on an unknown Routine is not found", async () => {
    const routines = store();
    await expect(
      routines.execute(
        {
          schemaVersion: 1,
          type: "routine/pause",
          commandId: "cmd-2",
          botId: "scout",
          routineId: "missing",
        },
        USER,
      ),
    ).rejects.toThrow(RoutineNotFoundError);
  });
});

function runEntry(seq: number): RoutineRunEntryV1 {
  return {
    schemaVersion: 1,
    entryId: `entry-${seq}`,
    routineId: "brief",
    runId: `fire-${seq}`,
    fireId: `fire-${seq}`,
    trigger: "cron",
    status: "ok",
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
  };
}

describe("RoutineStore run log", () => {
  test("is empty until something fires", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    expect((await routines.listRuns("scout", "brief")).entries).toEqual([]);
  });

  test("keeps the newest entries first and trims to its bound", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    for (let seq = 1; seq <= ROUTINE_RUN_LOG_LIMIT + 10; seq += 1) {
      await routines.recordRun(runEntry(seq));
    }
    const log = await routines.listRuns("scout", "brief");
    expect(log.entries).toHaveLength(ROUTINE_RUN_LOG_LIMIT);
    expect(log.entries[0]?.entryId).toBe(`entry-${ROUTINE_RUN_LOG_LIMIT + 10}`);
    expect(log.entries.at(-1)?.entryId).toBe("entry-11");
  });

  test("settling a firing rewrites its entry rather than appending a second", async () => {
    const routines = store();
    await routines.execute(create(), USER);
    await routines.recordRun({ ...runEntry(1), status: "running" });
    await routines.recordRun({
      ...runEntry(1),
      status: "failed",
      finishedAt: "2026-01-01T00:05:00.000Z",
    });
    const log = await routines.listRuns("scout", "brief");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ status: "failed" });
  });
});

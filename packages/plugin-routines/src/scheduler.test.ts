import { describe, expect, test } from "bun:test";
import {
  RoutineScheduler,
  routineDeadlineV1,
  type RoutineFireOutcomeV1,
} from "./scheduler.js";
import { decodeRoutineScheduleStateV1, type RoutineFireV1 } from "./firing.js";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import {
  routineFireKeyV1,
  routineScheduleKeyV1,
  ROUTINE_QUEUE_LIMIT,
} from "./storage-keys.js";
import type { RoutineCommandV1 } from "./shared.js";

const USER = { kind: "user" } as const;

/** A clock a test drives, so nothing here waits on real time. */
function clock(start: string) {
  let at = new Date(start);
  return {
    now: () => at,
    set(next: string) {
      at = new Date(next);
    },
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

function harness(options: { start: string; schedule?: string }) {
  const storage = createMemoryRoutineStorageV1();
  const time = clock(options.start);
  const scheduler = new RoutineScheduler(storage, { now: time.now });
  const store = new RoutineStore(storage, {
    now: time.now,
    firings: scheduler,
    defaultTimezone: "UTC",
  });
  const create: RoutineCommandV1 = {
    schemaVersion: 1,
    type: "routine/create",
    commandId: "cmd-create",
    botId: "scout",
    routineId: "brief",
    name: "Morning brief",
    prompt: "Summarize overnight email.",
    timezone: "UTC",
    ...(options.schedule === undefined
      ? { trigger: { kind: "webhook" as const } }
      : { schedule: options.schedule }),
  };
  return { storage, time, scheduler, store, create };
}

async function state(storage: ReturnType<typeof createMemoryRoutineStorageV1>) {
  return decodeRoutineScheduleStateV1(
    await storage.get(routineScheduleKeyV1("brief")),
  );
}

/** Drains, recording each firing, and answers with the outcome the test names. */
function drain(
  scheduler: RoutineScheduler,
  outcome: RoutineFireOutcomeV1 = { status: "ok", summary: "done" },
): Promise<RoutineFireV1[]> {
  const fired: RoutineFireV1[] = [];
  return scheduler
    .settle(async (fire) => {
      fired.push(fire);
      return outcome;
    })
    .then(() => fired);
}

describe("RoutineScheduler deadlines", () => {
  test("arms on the next occurrence of an enabled scheduled Routine", async () => {
    const { storage, scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);

    expect(await scheduler.deadlines(storage)).toEqual([
      Date.parse("2026-01-01T09:00:00.000Z"),
    ]);
  });

  test("arms on nothing for a paused Routine or a webhook Routine", async () => {
    const paused = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await paused.store.execute(paused.create, USER);
    await paused.store.execute(
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-pause",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    expect(await paused.scheduler.deadlines(paused.storage)).toEqual([]);

    const webhook = harness({ start: "2026-01-01T00:00:00.000Z" });
    await webhook.store.execute(webhook.create, USER);
    expect(await webhook.scheduler.deadlines(webhook.storage)).toEqual([]);
  });

  test("a deferral holds the alarm off and never moves the debt", async () => {
    const { storage, time, scheduler, store, create } = harness({
      start: "2026-01-01T08:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);
    // Nothing has written a clock yet: it is computed from the record until a
    // deferral or a firing has cause to persist one.
    const due = (await scheduler.deadlines(storage))[0]!;
    expect(due).toBe(Date.parse("2026-01-01T09:00:00.000Z"));

    // The Turn overruns the occurrence: the alarm fires, the object is busy,
    // and the deferral holds.
    time.set("2026-01-01T09:00:30.000Z");
    await scheduler.defer(storage);

    const deferred = await state(storage);
    expect(deferred.dueAt).toBe(due);
    expect(deferred.deferredUntil).toBe(Date.parse("2026-01-01T09:00:45.000Z"));
    // The debt is in the past, so the deadline is the hold — not the past due
    // time, which would re-arm an immediate alarm and spin.
    expect(routineDeadlineV1(deferred)).toBe(
      Date.parse("2026-01-01T09:00:45.000Z"),
    );

    // And when the hold lapses the firing still lands: nothing was skipped.
    time.set("2026-01-01T09:00:46.000Z");
    const fired = await drain(scheduler);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ trigger: "cron", dueAt: due });
  });

  test("recomputes the clock when the Routine's timing is rewritten", async () => {
    const { storage, scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);
    expect(await scheduler.deadlines(storage)).toEqual([
      Date.parse("2026-01-01T09:00:00.000Z"),
    ]);

    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-update",
        botId: "scout",
        routineId: "brief",
        schedule: "0 6 * * *",
      },
      USER,
    );
    expect(await scheduler.deadlines(storage)).toEqual([
      Date.parse("2026-01-01T06:00:00.000Z"),
    ]);
  });
});

describe("RoutineScheduler settle", () => {
  test("mints one firing per occurrence and advances the clock before it runs", async () => {
    const { storage, time, scheduler, store, create } = harness({
      start: "2026-01-01T08:59:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);

    expect(await drain(scheduler)).toEqual([]);

    time.set("2026-01-01T09:00:00.000Z");
    const fired = await drain(scheduler);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      routineId: "brief",
      trigger: "cron",
      dueAt: Date.parse("2026-01-01T09:00:00.000Z"),
    });
    expect(fired[0]!.cue).toContain("Summarize overnight email.");
    expect((await state(storage)).dueAt).toBe(
      Date.parse("2026-01-02T09:00:00.000Z"),
    );

    // The lock is released and the log records the settled outcome.
    expect(await scheduler.readFire("brief")).toBeUndefined();
    const runs = await store.listRuns("scout", "brief");
    expect(runs.entries).toHaveLength(1);
    expect(runs.entries[0]).toMatchObject({
      status: "ok",
      trigger: "cron",
      summary: "done",
    });
  });

  test("records the firing durably before the Turn runs, and unlocks after", async () => {
    const { storage, time, scheduler, store, create } = harness({
      start: "2026-01-01T08:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);
    time.set("2026-01-01T09:00:00.000Z");

    let lockedDuringRun: unknown;
    await scheduler.settle(async () => {
      lockedDuringRun = await storage.get(routineFireKeyV1("brief"));
      return { status: "ok" };
    });

    expect(lockedDuringRun).toMatchObject({ routineId: "brief" });
    expect(await storage.get(routineFireKeyV1("brief"))).toBeUndefined();
  });

  test("a failed Turn is a failed run-log entry, not a lost firing", async () => {
    const { time, scheduler, store, create } = harness({
      start: "2026-01-01T08:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);
    time.set("2026-01-01T09:00:00.000Z");

    await scheduler.settle(() => {
      throw new Error("the provider refused");
    });

    const runs = await store.listRuns("scout", "brief");
    expect(runs.entries).toHaveLength(1);
    expect(runs.entries[0]).toMatchObject({
      status: "failed",
      summary: "the provider refused",
    });
    expect(await scheduler.readFire("brief")).toBeUndefined();
  });

  test("a Routine three hours late fires once and says what it slept through", async () => {
    const { storage, time, scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 * * * *",
    });
    await store.execute(create, USER);
    // Three hours pass with the object evicted.
    time.set("2026-01-01T04:30:00.000Z");

    const fired = await drain(scheduler);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ missedCount: 4 });
    expect(fired[0]!.cue).toContain("4 scheduled occurrences elapsed");

    // Forward from now, never backfilled.
    expect((await state(storage)).dueAt).toBe(
      Date.parse("2026-01-01T05:00:00.000Z"),
    );

    const runs = await store.listRuns("scout", "brief");
    expect(runs.entries.map((entry) => entry.status).sort()).toEqual([
      "ok",
      "skipped",
    ]);
    expect(
      runs.entries.find((entry) => entry.status === "skipped")?.summary,
    ).toContain("3 scheduled occurrences elapsed");
  });

  test("a firing that is not late records no skipped entry", async () => {
    const { time, scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 * * * *",
    });
    await store.execute(create, USER);
    time.set("2026-01-01T01:00:30.000Z");

    await drain(scheduler);
    const runs = await store.listRuns("scout", "brief");
    expect(runs.entries).toHaveLength(1);
    expect(runs.entries[0]).toMatchObject({ status: "ok" });
  });

  test("drains a queue in order and never runs two firings of one Routine at once", async () => {
    const { time, scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
    });
    await store.execute(create, USER);

    await scheduler.enqueue({
      routineId: "brief",
      trigger: "manual",
      discriminator: "first",
    });
    time.advance(1_000);
    await scheduler.enqueue({
      routineId: "brief",
      trigger: "manual",
      discriminator: "second",
    });

    const concurrent: number[] = [];
    let running = 0;
    await scheduler.settle(async () => {
      running += 1;
      concurrent.push(running);
      running -= 1;
      return { status: "ok" };
    });
    expect(concurrent).toEqual([1, 1]);

    const runs = await store.listRuns("scout", "brief");
    expect(runs.entries.map((entry) => entry.runId)).toEqual([
      "rf-brief-second",
      "rf-brief-first",
    ]);
  });

  test("the same request twice is one firing", async () => {
    const { scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
    });
    await store.execute(create, USER);
    const first = await scheduler.enqueue({
      routineId: "brief",
      trigger: "manual",
      discriminator: "same",
    });
    const second = await scheduler.enqueue({
      routineId: "brief",
      trigger: "manual",
      discriminator: "same",
    });

    expect(second.fireId).toBe(first.fireId);
    expect(second.queued).toBe(false);
    expect(await drain(scheduler)).toHaveLength(1);
  });

  test("refuses a ninth waiting firing rather than dropping one in silence", async () => {
    const { scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
    });
    await store.execute(create, USER);
    for (let index = 0; index < ROUTINE_QUEUE_LIMIT; index += 1) {
      await scheduler.enqueue({
        routineId: "brief",
        trigger: "manual",
        discriminator: `q-${index}`,
      });
    }
    await expect(
      scheduler.enqueue({
        routineId: "brief",
        trigger: "manual",
        discriminator: "overflow",
      }),
    ).rejects.toThrow(/8 firings waiting/);
  });
});

describe("routine/run", () => {
  test("queues a manual firing and answers with the run id it will take", async () => {
    const { scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);

    const receipt = await store.execute(
      {
        schemaVersion: 1,
        type: "routine/run",
        commandId: "cmd-run",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    expect(receipt).toMatchObject({
      status: "fired",
      routineId: "brief",
      fireId: "rf-brief-manual-cmd-run",
    });

    const fired = await drain(scheduler);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      trigger: "manual",
      fireId: "rf-brief-manual-cmd-run",
    });
  });

  test("a replayed command id fires once", async () => {
    const { scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);
    const command = {
      schemaVersion: 1,
      type: "routine/run",
      commandId: "cmd-run",
      botId: "scout",
      routineId: "brief",
    } satisfies RoutineCommandV1;

    expect(await store.execute(command, USER)).toEqual(
      await store.execute(command, USER),
    );
    expect(await drain(scheduler)).toHaveLength(1);
  });

  test("deleting a Routine forgets its clock, its firing and its queue", async () => {
    const { storage, scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);
    await scheduler.enqueue({
      routineId: "brief",
      trigger: "manual",
      discriminator: "pending",
    });
    await scheduler.deadlines(storage);

    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/delete",
        commandId: "cmd-delete",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );

    expect(storage.keys().filter((key) => key.startsWith("routine"))).toEqual([
      "routine-receipt:cmd-create",
      "routine-receipt:cmd-delete",
    ]);
    expect(await drain(scheduler)).toEqual([]);
  });
});

describe("nextRuns", () => {
  test("reports the moment the alarm is armed on, and only for a live schedule", async () => {
    const { scheduler, store, create } = harness({
      start: "2026-01-01T00:00:00.000Z",
      schedule: "0 9 * * *",
    });
    await store.execute(create, USER);

    expect(await scheduler.nextRuns()).toEqual(
      new Map([["brief", "2026-01-01T09:00:00.000Z"]]),
    );
    expect(
      (await store.list("scout", await scheduler.nextRuns())).routines[0],
    ).toMatchObject({ nextRunAt: "2026-01-01T09:00:00.000Z" });

    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-pause",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    expect(await scheduler.nextRuns()).toEqual(new Map());
    expect(
      (await store.list("scout", await scheduler.nextRuns())).routines[0]
        ?.nextRunAt,
    ).toBeUndefined();
  });
});

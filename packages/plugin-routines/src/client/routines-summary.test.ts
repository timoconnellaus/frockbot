import { describe, expect, test } from "bun:test";
import type { RoutineViewV1 } from "../shared.js";
import { summarizeRoutinesV1 } from "./routines-summary.js";

function routine(overrides: Partial<RoutineViewV1>): RoutineViewV1 {
  const writer = { kind: "user" as const };
  return {
    schemaVersion: 1,
    routineId: "r1",
    name: "Morning brief",
    prompt: "Summarize the inbox",
    schedule: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    createdBy: writer,
    updatedBy: writer,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as RoutineViewV1;
}

describe("routines summary", () => {
  test("an empty list promises nothing", () => {
    expect(summarizeRoutinesV1([])).toEqual({
      total: 0,
      enabled: 0,
      webhooks: 0,
    });
  });

  test("counts Routines, live Routines and webhook triggers apart", () => {
    const summary = summarizeRoutinesV1([
      routine({ routineId: "r1" }),
      routine({ routineId: "r2", enabled: false }),
      routine({
        routineId: "r3",
        schedule: undefined,
        trigger: { kind: "webhook" },
      }),
    ]);
    expect(summary).toMatchObject({ total: 3, enabled: 2, webhooks: 1 });
  });

  test("takes the soonest armed firing and the most recent one", () => {
    const summary = summarizeRoutinesV1([
      routine({
        routineId: "r1",
        name: "Later",
        nextRunAt: "2026-09-02T09:00:00.000Z",
        lastRunAt: "2026-08-30T09:00:00.000Z",
      }),
      routine({
        routineId: "r2",
        name: "Sooner",
        nextRunAt: "2026-09-01T09:00:00.000Z",
        lastRunAt: "2026-08-29T09:00:00.000Z",
      }),
    ]);
    expect(summary.nextRunAt).toBe("2026-09-01T09:00:00.000Z");
    expect(summary.nextRunName).toBe("Sooner");
    expect(summary.lastRunAt).toBe("2026-08-30T09:00:00.000Z");
    expect(summary.lastRunName).toBe("Later");
  });

  test("a paused or webhook Routine contributes no next run", () => {
    const summary = summarizeRoutinesV1([
      routine({ routineId: "r1", enabled: false }),
      routine({
        routineId: "r2",
        schedule: undefined,
        trigger: { kind: "webhook" },
      }),
    ]);
    expect(summary.nextRunAt).toBeUndefined();
    expect(summary.lastRunAt).toBeUndefined();
  });
});

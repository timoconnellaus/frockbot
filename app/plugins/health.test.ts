import { describe, expect, test } from "bun:test";
import {
  PLUGIN_QUARANTINE_THRESHOLD_V1,
  clearPluginHealthV1,
  decodePluginHealthRecordV1,
  pluginHealthKeyV1,
  pluginQuarantineCopyV1,
  readPluginHealthMapV1,
  recordPluginFailureV1,
  settlePluginHealthV1,
} from "./health.js";

function storage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(map.delete(key)),
    list: <T>(options: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...map].filter(([key]) => key.startsWith(options.prefix)) as [
            string,
            T,
          ][],
        ),
      ),
  };
}

const at = (n: number) => new Date(`2026-09-12T00:0${n}:00.000Z`);

describe("a Plugin's health on one Bot", () => {
  test("counts failing Turns in a row, once per Turn, and quarantines at three", async () => {
    const store = storage();
    const failure = (runId: string, minute: number) =>
      recordPluginFailureV1(store, {
        pluginId: "weather",
        runId,
        phase: "hook",
        message: "exploded",
        now: at(minute),
      });
    expect((await failure("run-1", 1)).health.consecutiveFailures).toBe(1);
    // A second failure in the same Turn is the same Turn's failure.
    expect((await failure("run-1", 1)).health.consecutiveFailures).toBe(1);
    expect((await failure("run-2", 2)).quarantined).toBe(false);
    const third = await failure("run-3", 3);
    expect(third).toMatchObject({
      quarantined: true,
      health: {
        consecutiveFailures: PLUGIN_QUARANTINE_THRESHOLD_V1,
        quarantinedAt: at(3).toISOString(),
      },
    });
    // Quarantined once: a later failure does not quarantine again.
    const fourth = await failure("run-4", 4);
    expect(fourth.quarantined).toBe(false);
    expect(fourth.health.quarantinedAt).toBe(at(3).toISOString());
    expect(
      decodePluginHealthRecordV1(store.map.get(pluginHealthKeyV1("weather"))),
    ).toEqual(fourth.health);
  });

  test("a clean Turn resets the count; a failing Turn and a quarantine keep it", async () => {
    const store = storage();
    await recordPluginFailureV1(store, {
      pluginId: "weather",
      runId: "run-1",
      phase: "health",
      message: "mismatch",
      now: at(1),
    });
    await recordPluginFailureV1(store, {
      pluginId: "notes",
      runId: "run-1",
      phase: "hook",
      message: "slow",
      now: at(1),
    });
    // Turn 1 ends: both failed in it, both keep their count.
    expect(
      await settlePluginHealthV1(store, {
        runId: "run-1",
        ran: ["weather", "notes"],
      }),
    ).toEqual([]);
    // Turn 2 ends with only notes failing again: weather is well.
    await recordPluginFailureV1(store, {
      pluginId: "notes",
      runId: "run-2",
      phase: "hook",
      message: "slow",
      now: at(2),
    });
    expect(
      await settlePluginHealthV1(store, {
        runId: "run-2",
        ran: ["weather", "notes"],
      }),
    ).toEqual(["weather"]);
    expect(
      (await readPluginHealthMapV1(store)).get("notes")?.consecutiveFailures,
    ).toBe(2);
    expect((await readPluginHealthMapV1(store)).has("weather")).toBe(false);
    // A quarantined Plugin stays quarantined through clean Turns until a
    // person clears it.
    await recordPluginFailureV1(store, {
      pluginId: "notes",
      runId: "run-3",
      phase: "hook",
      message: "slow",
      now: at(3),
    });
    expect(
      await settlePluginHealthV1(store, { runId: "run-4", ran: ["notes"] }),
    ).toEqual([]);
    await clearPluginHealthV1(store, "notes");
    expect((await readPluginHealthMapV1(store)).size).toBe(0);
  });

  test("the page's words name the count and the last reason", () => {
    expect(
      pluginQuarantineCopyV1({
        schemaVersion: 1,
        pluginId: "weather",
        consecutiveFailures: 3,
        failureKinds: ["turn"],
        lastFailure: {
          runId: "run-3",
          phase: "hook",
          message: "exceeded its deadline",
          at: at(3).toISOString(),
        },
        quarantinedAt: at(3).toISOString(),
      }),
    ).toBe(
      "Turned off after 3 Turns in a row with a failure (last: exceeded its deadline). Turn it on to try again.",
    );
  });

  // The count is the total whatever the run held, but only a run of Turns is
  // read back to the person as Turns.
  test("the page's words describe the run, not just its count", () => {
    const health = {
      schemaVersion: 1,
      pluginId: "weather",
      consecutiveFailures: 3,
      lastFailure: {
        runId: "run-3",
        phase: "hook",
        message: "the handler threw",
        at: at(3).toISOString(),
      },
      quarantinedAt: at(3).toISOString(),
    } as const;
    expect(
      pluginQuarantineCopyV1({ ...health, failureKinds: ["press"] }),
    ).toContain("Turned off after 3 card presses in a row that failed");
    expect(
      pluginQuarantineCopyV1({ ...health, failureKinds: ["turn", "press"] }),
    ).toContain("Turned off after 3 failures in a row");
  });

  // The run's kinds are carried on the record so a notice can describe the
  // run rather than guess from whichever failure landed last.
  test("a run carries every kind of failure it is made of", async () => {
    const store = storage();
    const failure = (runId: string, kind: "turn" | "press", minute: number) =>
      recordPluginFailureV1(store, {
        pluginId: "weather",
        runId,
        phase: "hook",
        message: "exploded",
        kind,
        now: at(minute),
      });
    expect((await failure("run-1", "press", 1)).health.failureKinds).toEqual([
      "press",
    ]);
    expect((await failure("run-2", "press", 2)).health.failureKinds).toEqual([
      "press",
    ]);
    expect((await failure("run-3", "turn", 3)).health).toMatchObject({
      consecutiveFailures: 3,
      failureKinds: ["turn", "press"],
    });
  });

  // A record written before the run carried its kinds still reads, and says
  // nothing about what it was made of rather than claiming Turns.
  test("a record without kinds reads as a run of unknown make-up", () => {
    const decoded = decodePluginHealthRecordV1({
      schemaVersion: 1,
      pluginId: "weather",
      consecutiveFailures: 2,
      lastFailure: {
        runId: "run-2",
        phase: "hook",
        message: "exploded",
        at: at(2).toISOString(),
      },
    });
    expect(decoded.failureKinds).toEqual([]);
    expect(pluginQuarantineCopyV1(decoded)).toContain(
      "Turned off after 2 failures in a row",
    );
  });

  test("refuses a record it cannot read", () => {
    expect(() =>
      decodePluginHealthRecordV1({ schemaVersion: 1, pluginId: "x" }),
    ).toThrow(/invalid fields/);
  });
});

import { describe, expect, test } from "bun:test";
import {
  decodeRoutineCommandV1,
  decodeRoutineCommandReceiptV1,
  decodeRoutineListViewV1,
  decodeRoutineRunListViewV1,
  decodeRoutineViewV1,
  routineCommandFingerprintV1,
} from "./shared.js";
import { RoutineStore, routineViewV1 } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";

const CREATE = {
  schemaVersion: 1,
  type: "routine/create",
  commandId: "cmd-1",
  botId: "scout",
  name: "Morning brief",
  prompt: "Summarize overnight email.",
  schedule: "0 7 * * *",
};

describe("decodeRoutineCommandV1", () => {
  test("decodes each command in the vocabulary", () => {
    expect(decodeRoutineCommandV1(CREATE)).toMatchObject({
      type: "routine/create",
    });
    for (const type of ["routine/pause", "routine/resume", "routine/delete"]) {
      expect(
        decodeRoutineCommandV1({
          schemaVersion: 1,
          type,
          commandId: "cmd-2",
          botId: "scout",
          routineId: "brief",
        }),
      ).toMatchObject({ type });
    }
  });

  test("refuses a create carrying both a schedule and a trigger, or neither", () => {
    expect(() =>
      decodeRoutineCommandV1({ ...CREATE, trigger: { kind: "webhook" } }),
    ).toThrow(/never both/);
    const { schedule: _schedule, ...rest } = CREATE;
    expect(() => decodeRoutineCommandV1(rest)).toThrow(
      /needs a schedule or a trigger/,
    );
  });

  test("refuses an update that changes nothing and one with unknown fields", () => {
    expect(() =>
      decodeRoutineCommandV1({
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-2",
        botId: "scout",
        routineId: "brief",
      }),
    ).toThrow(/changes nothing/);
    expect(() => decodeRoutineCommandV1({ ...CREATE, sneaky: true })).toThrow(
      /unknown field "sneaky"/,
    );
  });

  test("refuses an unknown type and an unsupported version", () => {
    expect(() =>
      decodeRoutineCommandV1({ ...CREATE, type: "routine/run" }),
    ).toThrow(/type is unknown/);
    expect(() =>
      decodeRoutineCommandV1({ ...CREATE, schemaVersion: 2 }),
    ).toThrow(/schemaVersion is unsupported/);
  });
});

describe("routineCommandFingerprintV1", () => {
  test("ignores the command id and key order, and separates meanings", () => {
    const a = decodeRoutineCommandV1(CREATE);
    const b = decodeRoutineCommandV1({ ...CREATE, commandId: "cmd-99" });
    expect(routineCommandFingerprintV1(a)).toBe(routineCommandFingerprintV1(b));
    const c = decodeRoutineCommandV1({ ...CREATE, name: "Evening brief" });
    expect(routineCommandFingerprintV1(a)).not.toBe(
      routineCommandFingerprintV1(c),
    );
    expect(routineCommandFingerprintV1(a)).toStartWith("routine-command-v1:");
  });
});

describe("RoutineViewV1", () => {
  test("carries no key material, and round-trips through its codec", async () => {
    const store = new RoutineStore(createMemoryRoutineStorageV1());
    const receipt = await store.execute(decodeRoutineCommandV1(CREATE), {
      kind: "bot",
      botId: "scout",
      sessionId: "tim:scout",
      turnId: "turn-1",
    });
    if (receipt.status !== "applied") throw new Error("unreachable");
    const view = receipt.routine;
    // The Bot writer's Session and Turn stay in the durable record.
    expect(view.createdBy).toEqual({ kind: "bot", botId: "scout" });
    expect(JSON.stringify(view)).not.toContain("tim:scout");
    expect(JSON.stringify(view)).not.toContain("turn-1");
    expect(decodeRoutineViewV1(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(
      decodeRoutineCommandReceiptV1(JSON.parse(JSON.stringify(receipt))),
    ).toEqual(receipt);

    const record = await store.read(view.routineId);
    expect(record?.createdBy).toMatchObject({ sessionId: "tim:scout" });
    expect(routineViewV1(record!)).toEqual(view);

    const listed = await store.list("scout");
    expect(decodeRoutineListViewV1(JSON.parse(JSON.stringify(listed)))).toEqual(
      listed,
    );
    const runs = await store.listRuns("scout", view.routineId);
    expect(
      decodeRoutineRunListViewV1(JSON.parse(JSON.stringify(runs))),
    ).toEqual(runs);
  });

  test("refuses a view with an unknown field", () => {
    expect(() =>
      decodeRoutineViewV1({
        schemaVersion: 1,
        routineId: "brief",
        name: "Brief",
        prompt: "Do it",
        schedule: "@daily",
        timezone: "UTC",
        enabled: true,
        createdBy: { kind: "user" },
        updatedBy: { kind: "user" },
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
        webhookKey: "secret",
      }),
    ).toThrow(/unknown field "webhookKey"/);
  });
});

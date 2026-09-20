import { describe, expect, test } from "bun:test";
import {
  decodeRoutineCommandV1,
  decodeRoutineCommandReceiptV1,
  decodeRoutineInboxViewV1,
  decodeRoutineListViewV1,
  decodeRoutineRunListViewV1,
  decodeRoutineViewV1,
  routineCommandFingerprintV1,
} from "./shared.js";
import { routineInboxEntryViewV1 } from "./bot.js";
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

  test("a connection create accepts only a Gmail query on trigger config", () => {
    const { schedule: _schedule, ...rest } = CREATE;
    const trigger = {
      kind: "connection" as const,
      connectionId: "conn-gmail",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    };
    expect(
      decodeRoutineCommandV1({
        ...rest,
        trigger: { ...trigger, config: { query: "from:stripe.com" } },
      }),
    ).toMatchObject({
      trigger: { ...trigger, config: { query: "from:stripe.com" } },
    });
    expect(() =>
      decodeRoutineCommandV1({
        ...rest,
        trigger: {
          ...trigger,
          config: { labelIds: "INBOX", userId: "someone", interval: 15 },
        },
      }),
    ).toThrow(/unknown field/);
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
    expect(() =>
      decodeRoutineCommandV1({ ...CREATE, timezone: "Australia/Sydney" }),
    ).toThrow(/unknown field "timezone"/);
  });

  test("refuses an unknown type and an unsupported version", () => {
    expect(() =>
      decodeRoutineCommandV1({ ...CREATE, type: "routine/backfill" }),
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
  test("uses the durable writer codec for projected provenance", () => {
    const boundary = "a".repeat(256);
    const decoded = decodeRoutineViewV1({
      schemaVersion: 1,
      routineId: "brief",
      name: "Brief",
      prompt: "Do it",
      schedule: "@daily",
      timezone: "UTC",
      enabled: true,
      createdBy: {
        kind: "bot",
        botId: "scout",
        sessionId: boundary,
        turnId: boundary,
      },
      updatedBy: { kind: "user" },
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    expect(decoded.createdBy).toMatchObject({
      sessionId: boundary,
      turnId: boundary,
    });
  });

  test("carries no key material, and round-trips through its codec", async () => {
    const store = new RoutineStore(createMemoryRoutineStorageV1());
    const receipt = await store.execute(
      decodeRoutineCommandV1(CREATE),
      {
        kind: "bot",
        botId: "scout",
        sessionId: "tim:scout",
        turnId: "turn-1",
      },
      "UTC",
    );
    if (receipt.status !== "applied") throw new Error("unreachable");
    const view = receipt.routine;
    // The Bot writer's Session and Turn travel with it: they are provenance,
    // not key material, and the journey asks the record to name the Turn.
    expect(view.createdBy).toEqual({
      kind: "bot",
      botId: "scout",
      sessionId: "tim:scout",
      turnId: "turn-1",
    });
    expect(decodeRoutineViewV1(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(
      decodeRoutineCommandReceiptV1(JSON.parse(JSON.stringify(receipt))),
    ).toEqual(receipt);

    const record = await store.read(view.routineId);
    expect(record?.createdBy).toMatchObject({ sessionId: "tim:scout" });
    expect(routineViewV1(record!, "UTC")).toEqual(view);

    const listed = await store.list("scout", undefined, "UTC");
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

describe("decodeRoutineInboxViewV1", () => {
  const failed = {
    schemaVersion: 1 as const,
    entryId: "ri-run-1",
    runId: "run-1",
    routineId: "brief",
    text: "It stopped without saying why.",
    attribution: "Automation: Morning brief",
    createdAt: "2026-09-02T23:00:10.000Z",
    acknowledged: false,
    failure: true as const,
    repeatCount: 3,
  };

  test("keeps a failed or repeated completion, which the document read re-decodes", () => {
    const produced = routineInboxEntryViewV1({
      schemaVersion: 1,
      entryId: failed.entryId,
      runId: failed.runId,
      routineId: failed.routineId,
      text: failed.text,
      attribution: failed.attribution,
      createdAt: failed.createdAt,
      acknowledged: false,
      failure: true,
      repeatCount: 3,
    });
    const view = {
      schemaVersion: 1 as const,
      botId: "scout",
      entries: [produced],
      unacknowledged: 1,
    };
    // The gateway re-decodes the view it just produced. A failed firing used
    // to throw here — exact keys had never heard of `failure` or `repeatCount`
    // — and `GET …/routines?as=document` answered 500, which the app draws as
    // "Routines couldn’t load".
    expect(decodeRoutineInboxViewV1(view)).toEqual(view);
  });

  test("refuses a completion view with an unknown field", () => {
    expect(() =>
      decodeRoutineInboxViewV1({
        schemaVersion: 1,
        botId: "scout",
        unacknowledged: 0,
        entries: [{ ...failed, diagnostic: "stack" }],
      }),
    ).toThrow(/unknown field "diagnostic"/);
  });
});

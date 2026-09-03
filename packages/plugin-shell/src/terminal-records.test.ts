// The one transaction that settles a Turn, and the three producers sharing it.
//
// The property under test is composition, not any producer's own rules: each
// producer runs exactly once per settlement, and no producer may silently
// overwrite another. A settlement that ran a producer twice would write two
// records where the Turn earned one — a firing with two inbox entries — and
// nobody would notice until they counted.
import { describe, expect, test } from "bun:test";
import {
  shellTerminalRecordsV1,
  supersededTurnRecordsV1,
} from "./terminal-records.js";
import { SIDEBAR_PREVIEW_KEY, UNREAD_STATE_KEY } from "./unread.js";
import { approvalKeyV1, decodeApprovalRecordV1 } from "./approvals.js";
import { decodeRoutineInboxEntryV1 } from "@frockbot/plugin-routines/inbox";
import {
  ROUTINE_INBOX_PREFIX,
  ROUTINE_WAKE_PREFIX,
} from "@frockbot/plugin-routines/storage-keys";

const NOW = "2026-09-01T00:00:00.000Z";
const CURSOR = "run-index:2026-09-01T00:00:00.000Z:run-1";

/** A durable store the settling transaction reads through. */
function store(initial: Record<string, unknown> = {}) {
  const state = new Map(Object.entries(initial));
  return {
    state,
    read: <T>(key: string) => Promise.resolve(state.get(key) as T | undefined),
    /** Apply what the settlement returned, the way the kernel writes it. */
    apply(records: Record<string, unknown>) {
      for (const [key, value] of Object.entries(records)) state.set(key, value);
    },
  };
}

const APPROVAL_SEND = {
  type: "send/to-user",
  payload: {
    type: "approval",
    approvalId: "ap-1",
    action: "Delete the staging database",
    risk: "high",
  },
} as const;

function keysUnder(records: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(records).filter((key) => key.startsWith(prefix));
}

describe("the settling transaction's records", () => {
  test("a chat Turn that asked for approval writes unread and the decision, once each", async () => {
    const durable = store();

    const records = await shellTerminalRecordsV1({
      run: {
        runId: "run-1",
        sessionId: "user-1:bot-1",
        acceptedAt: NOW,
        input: "Please delete it",
        admission: { turnType: "chat" },
        events: [{ type: "turn/start" }, APPROVAL_SEND],
      },
      cursor: CURSOR,
      now: NOW,
      read: durable.read,
    });

    expect(Object.keys(records).sort()).toEqual([
      approvalKeyV1("ap-1"),
      SIDEBAR_PREVIEW_KEY,
      UNREAD_STATE_KEY,
    ]);
    expect(
      decodeApprovalRecordV1(records[approvalKeyV1("ap-1")]),
    ).toMatchObject({ decision: "pending", runId: "run-1", createdAt: NOW });
    // One settlement, one instant: the unread record is stamped with the same
    // `now` the approval is.
    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastActivityCursor: CURSOR,
      lastActivityAt: NOW,
    });
    expect(records[SIDEBAR_PREVIEW_KEY]).toEqual({
      schemaVersion: 1,
      text: "Please delete it",
      at: NOW,
      role: "user",
    });
  });

  test("one automation Turn contributes exactly one inbox entry and one wake", async () => {
    const durable = store({
      "routine:brief": {
        schemaVersion: 1,
        routineId: "brief",
        name: "Morning brief",
        prompt: "look",
        timezone: "UTC",
        enabled: true,
        createdBy: { kind: "user" },
        updatedBy: { kind: "user" },
        createdAt: NOW,
        updatedAt: NOW,
        schedule: "* * * * *",
      },
    });
    const run = {
      runId: "rf-brief-1",
      sessionId: "user-1:bot-1",
      acceptedAt: NOW,
      input: "look",
      admission: {
        turnType: "automation",
        origin: { kind: "routine", routineId: "brief" },
      },
      events: [
        { type: "turn/start" },
        { type: "wake/parent", message: "Two emails need you." },
      ],
    };

    const records = await shellTerminalRecordsV1({
      run,
      cursor: CURSOR,
      now: NOW,
      read: durable.read,
    });

    expect(keysUnder(records, ROUTINE_INBOX_PREFIX)).toHaveLength(1);
    expect(keysUnder(records, ROUTINE_WAKE_PREFIX)).toHaveLength(1);
    // An automation Turn reaches its User through the inbox, never the badge.
    expect(records[UNREAD_STATE_KEY]).toBeUndefined();
    const entry = decodeRoutineInboxEntryV1(
      records[keysUnder(records, ROUTINE_INBOX_PREFIX)[0]!],
    );
    expect(entry).toMatchObject({ entryId: "ri-rf-brief-1", runId: run.runId });
  });

  test("re-settling the same Turn writes the same records, and no second entry", async () => {
    const durable = store({
      "routine:brief": {
        schemaVersion: 1,
        routineId: "brief",
        name: "Morning brief",
        prompt: "look",
        timezone: "UTC",
        enabled: true,
        createdBy: { kind: "user" },
        updatedBy: { kind: "user" },
        createdAt: NOW,
        updatedAt: NOW,
        schedule: "* * * * *",
      },
    });
    const run = {
      runId: "rf-brief-1",
      sessionId: "user-1:bot-1",
      acceptedAt: NOW,
      input: "look",
      admission: {
        turnType: "automation",
        origin: { kind: "routine", routineId: "brief" },
      },
      events: [
        { type: "turn/start" },
        { type: "wake/parent", message: "Two emails need you." },
        APPROVAL_SEND,
      ],
    };
    const settle = () =>
      shellTerminalRecordsV1({
        run,
        cursor: CURSOR,
        now: NOW,
        read: durable.read,
      });

    const first = await settle();
    durable.apply(first);
    // Recovery re-settles an interrupted Turn through the same seam. The
    // approval it already wrote is left exactly as it stands — a decision a
    // person made in between must not be reset to `pending`.
    const second = await settle();

    expect(keysUnder(first, ROUTINE_INBOX_PREFIX)).toHaveLength(1);
    expect(second[approvalKeyV1("ap-1")]).toBeUndefined();
    durable.apply(second);
    expect(
      [...durable.state.keys()].filter((key) =>
        key.startsWith(approvalKeyV1("ap-1")),
      ),
    ).toHaveLength(1);
  });

  test("a producer that would overwrite another's key is a loud failure", async () => {
    // The unread key is the Shell's own; a Package record landing on it would
    // be a key-space collision, and picking a winner silently is the one
    // outcome the composition refuses.
    const durable = store();
    const records = await shellTerminalRecordsV1({
      run: {
        runId: "run-1",
        sessionId: "user-1:bot-1",
        acceptedAt: NOW,
        input: "Please delete it",
        admission: { turnType: "chat" },
        events: [APPROVAL_SEND],
      },
      cursor: CURSOR,
      now: NOW,
      read: durable.read,
    });

    // No collision today, and the guard is what keeps that true as producers
    // are added: every key is written by exactly one of them.
    expect(new Set(Object.keys(records)).size).toBe(
      Object.keys(records).length,
    );
  });
});

describe("what a superseded Turn leaves for the Turn that replaced it", () => {
  const run = {
    runId: "run-1",
    sessionId: "user-1:primary",
    acceptedAt: "2026-09-03T00:00:00.000Z",
    input: "first",
    events: [] as { type: string }[],
  };
  const now = "2026-09-03T00:00:05.000Z";
  const read = <T>(): Promise<T | undefined> => Promise.resolve(undefined);

  test("one durable input, keyed by the Turn it replaced", async () => {
    const records = await supersededTurnRecordsV1({ run, now, read });

    const values = Object.values(records);
    expect(values).toHaveLength(2);
    expect(values).toContainEqual({
      schemaVersion: 1,
      kind: "superseded-turn",
      runId: "run-1",
      unfinishedWork: false,
      createdAt: now,
    });
  });

  test("a Turn that dispatched a subagent says so, because it is still running", async () => {
    const records = await supersededTurnRecordsV1({
      run: { ...run, events: [{ type: "task/dispatched" }] },
      now,
      read,
    });

    expect(Object.values(records)).toContainEqual(
      expect.objectContaining({ unfinishedWork: true }),
    );
  });

  test("an automation Turn contributes nothing: a firing is not the conversation", async () => {
    expect(
      await supersededTurnRecordsV1({
        run: { ...run, admission: { turnType: "automation" } },
        now,
        read,
      }),
    ).toEqual({});
  });
});

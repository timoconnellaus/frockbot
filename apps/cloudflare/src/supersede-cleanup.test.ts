import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_ROW_PREFIX,
  CONVERSATION_UPDATE_PREFIX,
  pendingUserRunKey,
  RUN_PREFIX,
} from "@frockbot/core/durable";
import {
  ROUTINE_DRAIN_PREFIX,
  ROUTINE_WAKE_PREFIX,
} from "@frockbot/app/routines/storage-keys";
import { cleanSupersedeStateV1 } from "./supersede-cleanup.js";

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

const at = "2026-09-23T00:00:00.000Z";

describe("supersede cleanup", () => {
  test("turns superseded state into what steering reads", async () => {
    const storage = storageFrom({
      [`${RUN_PREFIX}replaced`]: {
        runId: "replaced",
        acceptedAt: at,
        status: "superseded",
        phase: "executing",
        supersededAt: "2026-09-23T00:00:05.000Z",
        supersededBy: "next",
        hasModelIntent: true,
      },
      [`${RUN_PREFIX}done`]: {
        runId: "done",
        acceptedAt: at,
        status: "completed",
        phase: "executing",
        responseText: "Hi",
        hasModelIntent: true,
      },
      [`${RUN_PREFIX}waiting`]: {
        runId: "waiting",
        acceptedAt: at,
        status: "running",
        phase: "queued",
      },
      "pending-run": "waiting",
      [`${CONVERSATION_ROW_PREFIX}run:replaced`]: {
        schemaVersion: 1,
        kind: "run-status",
        payload: {
          run: {
            runId: "replaced",
            admittedAt: at,
            status: "superseded",
            outcome: {
              type: "superseded",
              message: "Interrupted by your next message.",
            },
          },
        },
      },
      [`${CONVERSATION_UPDATE_PREFIX}0000000000000001`]: {
        schemaVersion: 1,
        kind: "message",
        payload: { runId: "done" },
      },
      [`${ROUTINE_WAKE_PREFIX}0000000001`]: {
        schemaVersion: 1,
        kind: "superseded-turn",
        runId: "replaced",
        unfinishedWork: false,
        createdAt: at,
      },
      [`${ROUTINE_WAKE_PREFIX}0000000002`]: {
        schemaVersion: 1,
        kind: "approval",
      },
      [`${ROUTINE_DRAIN_PREFIX}next`]: {
        schemaVersion: 1,
        runId: "next",
        inputs: [{ kind: "superseded-turn" }],
      },
      [`${ROUTINE_DRAIN_PREFIX}other`]: {
        schemaVersion: 1,
        runId: "other",
        inputs: [{ kind: "wake" }],
      },
    });

    await cleanSupersedeStateV1(storage);

    expect(storage.held.get(`${RUN_PREFIX}replaced`)).toEqual({
      runId: "replaced",
      acceptedAt: at,
      status: "cancelled",
      phase: "executing",
      stopRequestedAt: "2026-09-23T00:00:05.000Z",
    });
    expect(storage.held.get(`${RUN_PREFIX}done`)).toEqual({
      runId: "done",
      acceptedAt: at,
      status: "completed",
      phase: "executing",
      responseText: "Hi",
    });
    expect(storage.held.has("pending-run")).toBe(false);
    expect(storage.held.get(pendingUserRunKey(at, "waiting"))).toBe("waiting");
    expect(
      storage.held.get(`${CONVERSATION_ROW_PREFIX}run:replaced`),
    ).toMatchObject({
      payload: {
        run: {
          status: "cancelled",
          stopRequestedAt: at,
          outcome: {
            type: "cancelled",
            message: "Interrupted by your next message.",
          },
        },
      },
    });
    expect(storage.held.has(`${ROUTINE_WAKE_PREFIX}0000000001`)).toBe(false);
    expect(storage.held.has(`${ROUTINE_WAKE_PREFIX}0000000002`)).toBe(true);
    expect(storage.held.has(`${ROUTINE_DRAIN_PREFIX}next`)).toBe(false);
    expect(storage.held.has(`${ROUTINE_DRAIN_PREFIX}other`)).toBe(true);

    // Once per Bot: a later record in the retired shape is not rewritten.
    await storage.put(`${RUN_PREFIX}later`, {
      runId: "later",
      status: "superseded",
    });
    await cleanSupersedeStateV1(storage);
    expect(storage.held.get(`${RUN_PREFIX}later`)).toMatchObject({
      status: "superseded",
    });
  });
});

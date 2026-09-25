import { describe, expect, test } from "bun:test";
import type {
  StoredRunAdmissionV1,
  StoredRunOriginV1,
} from "@frockbot/core/durable";
import {
  namedRunCauseV1,
  runCauseOfRunV1,
  runCauseV1,
  type RunCauseReadersV1,
} from "./run-cause";

function readers(
  runs: Record<string, StoredRunOriginV1 | undefined>,
): RunCauseReadersV1 {
  return {
    readRun: async (runId) =>
      runId in runs
        ? {
            admission: {
              schemaVersion: 1,
              turnType: "chat",
              ...(runs[runId] ? { origin: runs[runId] } : {}),
            } as StoredRunAdmissionV1,
          }
        : undefined,
  };
}

const firing: StoredRunOriginV1 = {
  kind: "routine",
  routineId: "digest",
  fireId: "fire-1",
  trigger: "cron",
};

describe("what a Turn's spending is charged to", () => {
  test("a person talking, or answering a card, is the conversation", async () => {
    const none = readers({});
    expect(await runCauseV1("bot-1", undefined, none)).toEqual({
      kind: "chat",
      botId: "bot-1",
    });
    expect(
      await runCauseV1("bot-1", { kind: "input-delivery", inputId: "i" }, none),
    ).toEqual({ kind: "chat", botId: "bot-1" });
  });

  test("a firing is its Routine, named only for this Bot's own ledger entry", async () => {
    const cause = await runCauseV1("bot-1", firing, readers({}));
    // What travels to another Bot is durable: no name read at the time.
    expect(cause).toEqual({
      kind: "routine",
      botId: "bot-1",
      id: "digest",
      trigger: "cron",
    });
    const names = async (id: string) =>
      id === "digest" ? "Morning digest" : undefined;
    expect(await namedRunCauseV1("bot-1", cause, names)).toEqual({
      ...cause,
      label: "Morning digest",
    });
    // Another Bot's Routine is not this Bot's to name.
    expect(await namedRunCauseV1("bot-2", cause, names)).toEqual(cause);
  });

  test("a hand-off and a delivery are charged to the firing that set them going", async () => {
    const chain = readers({
      "fire-1": firing,
      "handoff-1": { kind: "handoff", parentRunId: "fire-1", depth: 1 },
    });
    const routine = {
      kind: "routine" as const,
      botId: "bot-1",
      id: "digest",
      trigger: "cron" as const,
    };
    expect(
      await runCauseV1(
        "bot-1",
        { kind: "handoff", parentRunId: "fire-1", depth: 1 },
        chain,
      ),
    ).toEqual(routine);
    expect(
      await runCauseV1(
        "bot-1",
        { kind: "routine-delivery", wakeRunId: "fire-1" },
        chain,
      ),
    ).toEqual(routine);
    expect(await runCauseOfRunV1("bot-1", "handoff-1", chain)).toEqual(routine);
  });

  test("another Bot's question carries the cause its asker wrote", async () => {
    const cause = {
      kind: "routine" as const,
      botId: "bot-2",
      id: "digest",
      trigger: "cron" as const,
    };
    expect(
      await runCauseV1(
        "bot-1",
        {
          kind: "bot",
          fromBotId: "bot-2",
          fromBotName: "Two",
          messageId: "m",
          cause,
        },
        readers({}),
      ),
    ).toEqual(cause);
    expect(
      await runCauseV1(
        "bot-1",
        { kind: "bot", fromBotId: "bot-2", fromBotName: "Two", messageId: "m" },
        readers({}),
      ),
    ).toEqual({ kind: "chat", botId: "bot-2" });
  });

  test("a parent that no longer reads is the conversation, and a loop ends", async () => {
    expect(
      await runCauseV1(
        "bot-1",
        { kind: "handoff", parentRunId: "gone", depth: 1 },
        readers({}),
      ),
    ).toEqual({ kind: "chat", botId: "bot-1" });
    const loop = readers({
      a: { kind: "handoff", parentRunId: "b", depth: 1 },
      b: { kind: "handoff", parentRunId: "a", depth: 1 },
    });
    expect(await runCauseOfRunV1("bot-1", "a", loop)).toEqual({
      kind: "chat",
      botId: "bot-1",
    });
  });

  test("a Group Chat is the group", async () => {
    expect(
      await runCauseV1(
        "bot-1",
        {
          kind: "group",
          groupId: "g1",
          groupName: "Planning",
          members: [{ botId: "bot-1", name: "One" }],
          throughSeq: 3,
          reason: "mention",
        },
        readers({}),
      ),
    ).toEqual({ kind: "group", botId: "bot-1", id: "g1", label: "Planning" });
  });
});

import { describe, expect, test } from "bun:test";
import {
  decodeSessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import { SessionEventLog } from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import "./working-context-store.js";
import {
  deferToolResultPruningV1,
  PRUNE_AFTER_IDLE_MS_V1,
  settleToolResultPruningV1,
  TOOL_RESULT_PRUNE_DEFERRAL_MS_V1,
  TOOL_RESULT_PRUNE_DUE_PREFIX_V1,
  toolResultPruneDeadlinesV1,
  toolResultPruneTerminalRecordsV1,
  type ToolResultPruneInputV1,
  type ToolResultPrunerV1,
} from "./tool-result-pruning.js";

const SESSION = "user:bot";
const NOW = "2026-09-27T10:00:00.000Z";
const SETTLED = Date.parse(NOW);

function chatTurn(turn: number, toolText: string): SessionEventInput[] {
  return [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    {
      type: "user/message",
      turn,
      step: 1,
      messageId: `m-${turn}`,
      text: `question ${turn}`,
    },
    {
      type: "assistant/message",
      turn,
      step: 1,
      requestId: `r-${turn}`,
      text: "",
      toolCalls: [{ id: `c-${turn}`, name: "web_fetch", input: {} }],
    },
    {
      type: "tool/result",
      turn,
      step: 1,
      occurrenceId: `tool:${turn}:1:0`,
      name: "web_fetch",
      content: toolText,
      isError: false,
      status: "completed",
    },
    { type: "step/end", turn, step: 1, outcome: "completed" },
    { type: "turn/end", turn, outcome: "completed" },
  ];
}

async function conversation(storage: MemoryStorage): Promise<number> {
  const inputs = [
    ...chatTurn(1, "A".repeat(600)),
    ...chatTurn(2, "short"),
    ...chatTurn(3, "C".repeat(600)),
  ];
  const events = inputs.map((input, seq) =>
    decodeSessionEvent({ ...input, seq, timestamp: NOW }),
  );
  await new SessionEventLog(storage).append(SESSION, events);
  return events.length;
}

async function owe(storage: MemoryStorage, dueAt = SETTLED) {
  await storage.put(`${TOOL_RESULT_PRUNE_DUE_PREFIX_V1}${SESSION}`, {
    schemaVersion: 1,
    sessionId: SESSION,
    runId: "run-3",
    dueAt,
  });
}

describe("owing a pass", () => {
  test("a settled chat run owes one five minutes after it settled", () => {
    expect(
      toolResultPruneTerminalRecordsV1({
        run: { runId: "run-3", sessionId: SESSION },
        now: NOW,
      }),
    ).toEqual({
      [`${TOOL_RESULT_PRUNE_DUE_PREFIX_V1}${SESSION}`]: {
        schemaVersion: 1,
        sessionId: SESSION,
        runId: "run-3",
        dueAt: SETTLED + PRUNE_AFTER_IDLE_MS_V1,
      },
    });
  });

  test("an automation run owes none", () => {
    expect(
      toolResultPruneTerminalRecordsV1({
        run: {
          runId: "run-3",
          sessionId: SESSION,
          admission: { turnType: "automation" },
        },
        now: NOW,
      }),
    ).toEqual({});
  });

  test("its due time rides the alarm, and a Turn pushes a past-due one back", async () => {
    const storage = new MemoryStorage();
    await owe(storage, SETTLED);
    expect(await toolResultPruneDeadlinesV1(storage)).toEqual([SETTLED]);
    await deferToolResultPruningV1(storage, SETTLED + 1);
    expect(await toolResultPruneDeadlinesV1(storage)).toEqual([
      SETTLED + 1 + TOOL_RESULT_PRUNE_DEFERRAL_MS_V1,
    ]);
  });
});

describe("a due pass", () => {
  test("shows the judge the larger results and records the ones it prunes", async () => {
    const storage = new MemoryStorage();
    const count = await conversation(storage);
    await owe(storage);
    const judged: ToolResultPruneInputV1[] = [];
    const pruner: ToolResultPrunerV1 = async (input) => {
      judged.push(input);
      return [true, false];
    };
    const appended: unknown[] = [];
    await settleToolResultPruningV1({
      storage,
      pruner,
      append: async (input) => {
        appended.push(input);
        return true;
      },
      now: () => SETTLED,
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]!.results.map((r) => r.text[0])).toEqual(["A", "C"]);
    expect(judged[0]!.conversation.map((l) => l.text)).toEqual([
      "question 1",
      "question 2",
      "question 3",
    ]);
    expect(appended).toEqual([
      {
        runId: "run-3",
        sessionId: SESSION,
        expectedEventCount: count,
        events: [
          {
            type: "conversation/tool-results-pruned",
            results: [{ turn: 1, callId: "c-1" }],
          },
        ],
      },
    ]);
    expect(await toolResultPruneDeadlinesV1(storage)).toEqual([]);
  });

  test("waits until it is due", async () => {
    const storage = new MemoryStorage();
    await conversation(storage);
    await owe(storage, SETTLED + 1);
    let asked = false;
    await settleToolResultPruningV1({
      storage,
      pruner: async () => {
        asked = true;
        return [];
      },
      append: async () => true,
      now: () => SETTLED,
    });
    expect(asked).toBe(false);
    expect(await toolResultPruneDeadlinesV1(storage)).toEqual([SETTLED + 1]);
  });

  test("an unsure or failed judge prunes nothing and spends the pass", async () => {
    const storage = new MemoryStorage();
    await conversation(storage);
    await owe(storage);
    let appended = false;
    await settleToolResultPruningV1({
      storage,
      pruner: async () => undefined,
      append: async () => {
        appended = true;
        return true;
      },
      now: () => SETTLED,
    });
    expect(appended).toBe(false);
    expect(await toolResultPruneDeadlinesV1(storage)).toEqual([]);
  });

  test("a newer run's pass owed meanwhile is kept", async () => {
    const storage = new MemoryStorage();
    await conversation(storage);
    await owe(storage);
    await settleToolResultPruningV1({
      storage,
      pruner: async (input) => {
        await storage.put(`${TOOL_RESULT_PRUNE_DUE_PREFIX_V1}${SESSION}`, {
          schemaVersion: 1,
          sessionId: SESSION,
          runId: "run-4",
          dueAt: SETTLED + PRUNE_AFTER_IDLE_MS_V1,
        });
        return input.results.map(() => false);
      },
      append: async () => true,
      now: () => SETTLED,
    });
    expect(await toolResultPruneDeadlinesV1(storage)).toEqual([
      SETTLED + PRUNE_AFTER_IDLE_MS_V1,
    ]);
  });
});

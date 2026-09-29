import { describe, expect, test } from "bun:test";
import { decodeProtocol } from "@frockbot/core/protocol-schemas";
import type { ApprovalRecordV1 } from "./approvals.ts";
import type { ShellBotStateV1 } from "./backend-state.ts";
import {
  decodeWorkLogQueryV1,
  projectWorkLogTurnV1,
  readWorkLogV1,
  WORK_LOG_MAX_ENTRIES_V1,
  WORK_LOG_PAGE_TURNS_V1,
} from "./work-log.ts";

const run = {
  runId: "run-42",
  acceptedAt: "2026-09-28T09:14:18.000Z",
  status: "completed" as const,
  input: "Find a free Thursday evening and book Diggies for 4",
};

let seq = 0;
function at(ms: number): string {
  return new Date(Date.parse("2026-09-28T09:14:18.000Z") + ms).toISOString();
}
function event(ms: number, type: string, fields: Record<string, unknown>) {
  return { type, seq: seq++, timestamp: at(ms), ...fields };
}

function booking() {
  seq = 0;
  return [
    event(0, "turn/start", { turn: 42 }),
    event(10, "user/message", {
      turn: 42,
      step: 0,
      messageId: "m1",
      text: run.input,
    }),
    event(200, "supervision/turn-start", {
      turn: 42,
      latencyMs: 180,
      directive: {
        acknowledge: false,
        complexity: "moderate",
        consequence: 3,
        ambiguity: "clear",
        requiredCapabilities: ["web"],
        steering: [],
        judgments: [
          { question: "Does it reach outside?", answer: "yes", value: 1 },
        ],
        model: "jev-1",
      },
    }),
    event(240, "memory/injected", {
      turn: 42,
      sources: [],
      facts: [
        {
          scope: "user",
          groupId: "g",
          tier: "profile",
          via: "chat",
          learnedAt: at(0),
          text: "Sam is vegetarian",
        },
      ],
      omissions: [],
    }),
    event(300, "step/start", { turn: 42, step: 1 }),
    event(310, "model/request", {
      turn: 42,
      step: 1,
      request: {
        requestId: "req-1",
        provider: "frock-ai",
        model: "auto",
        messageCount: 4,
        toolCount: 14,
        truncated: true,
        excerpt: { system: "You are Pixel.", lastMessage: "Book Diggies" },
      },
    }),
    event(320, "model/retry", {
      turn: 42,
      step: 1,
      attempt: 2,
      classification: "transient",
      delayMs: 2000,
    }),
    event(2200, "model/usage", {
      turn: 42,
      step: 1,
      requestId: "req-1",
      provider: "frock-ai",
      model: "auto",
      inputTokens: 14210,
      outputTokens: 188,
      cachedInputTokens: 11980,
      latencyMs: 1840,
      estimated: false,
    }),
    event(2210, "assistant/message", {
      turn: 42,
      step: 1,
      requestId: "req-1",
      text: "Checking Thursday.",
      toolCalls: [{ id: "c1", name: "calendar_freebusy", input: {} }],
    }),
    event(2300, "supervision/call", {
      turn: 42,
      step: 1,
      occurrenceId: "o1",
      tool: "calendar_freebusy",
      latencyMs: 212,
      decision: {
        decision: "allow",
        reasonCode: "matches_request",
        judgments: [],
      },
    }),
    event(2400, "tool/call", {
      turn: 42,
      step: 1,
      occurrenceId: "o1",
      name: "calendar_freebusy",
      input: { day: "Thu" },
    }),
    event(2412, "computer/timing", {
      turn: 42,
      scope: "tool",
      tool: "calendar_freebusy",
      ms: { attach: 4, operation: 400, total: 410 },
    }),
    event(2812, "tool/result", {
      turn: 42,
      step: 1,
      occurrenceId: "o1",
      name: "calendar_freebusy",
      content: "Free after 6:00 pm\nbusy before",
      isError: false,
      status: "completed",
    }),
    event(2900, "send/to-user", {
      turn: 42,
      step: 1,
      occurrenceId: "o2",
      payload: {
        type: "approval",
        approvalId: "ap-1",
        action: "Book Diggies, Thu 7 pm, 4 people",
        risk: "high",
      },
    }),
    event(3000, "computer/sync", {
      turn: 42,
      reason: "turn-end",
      status: "degraded",
      detail: "one file refused",
      pulled: 0,
      pushed: 3,
      restored: 0,
      removed: 0,
      adopted: 0,
      conflicts: 0,
      failures: 1,
    }),
    event(38200, "turn/end", { turn: 42, outcome: "completed" }),
  ];
}

const approval: ApprovalRecordV1 = {
  schemaVersion: 1,
  approvalId: "ap-1",
  runId: "run-42",
  sessionId: "s",
  action: "Book Diggies, Thu 7 pm, 4 people",
  risk: "high",
  createdAt: at(2900),
  expiresAt: at(86_400_000),
  decision: "approved",
  decidedAt: at(16_900),
  decidedBy: "user",
};

describe("projectWorkLogTurnV1", () => {
  test("reads one Turn as a validated, step-grouped log", () => {
    const turn = projectWorkLogTurnV1(
      run,
      booking(),
      new Map([["ap-1", approval]]),
    );
    expect(() => decodeProtocol("WorkLogTurn", turn)).not.toThrow();
    expect(turn.turn).toBe(42);
    expect(turn.via).toBe("You");
    expect(turn.durationMs).toBe(38200);
    expect(turn.outcome).toBe("Completed");
    expect(turn.entries.map((entry) => entry.kind)).toEqual([
      "input",
      "jev",
      "memory",
      "model",
      "retry",
      "jev",
      "tool",
      "send",
      "computer",
    ]);
    expect(turn.totals).toEqual({
      steps: 1,
      modelRequests: 1,
      inputTokens: 14210,
      cachedInputTokens: 11980,
      outputTokens: 188,
      reasoningTokens: 0,
      toolCalls: 1,
      toolErrors: 0,
      jevChecks: 2,
      retries: 1,
      computerMs: 410,
    });
  });

  test("pairs a model request with its usage and reply", () => {
    const model = projectWorkLogTurnV1(run, booking()).entries.find(
      (entry) => entry.kind === "model",
    )!;
    expect(model.title).toBe("Checking Thursday.");
    expect(model.detail).toBe("1 tool call");
    expect(model.durationMs).toBe(1840);
    expect(model.tokens).toEqual({
      input: 14210,
      cachedInput: 11980,
      output: 188,
      reasoning: 0,
    });
    expect(model.fields).toContainEqual({
      label: "Provider",
      value: "Frock AI",
    });
  });

  test("pairs a tool call with its result, time and Computer breakdown", () => {
    const tool = projectWorkLogTurnV1(run, booking()).entries.find(
      (entry) => entry.kind === "tool",
    )!;
    expect(tool.title).toBe("calendar_freebusy");
    expect(tool.detail).toBe("Free after 6:00 pm");
    expect(tool.durationMs).toBe(412);
    expect(tool.fields).toContainEqual({
      label: "Operation",
      value: "400 ms",
    });
    expect(tool.sections?.map((section) => section.label)).toEqual([
      "Input",
      "Result",
    ]);
  });

  test("says how an approval was answered, and a degraded sync is an error", () => {
    const entries = projectWorkLogTurnV1(
      run,
      booking(),
      new Map([["ap-1", approval]]),
    ).entries;
    const ask = entries.find((entry) => entry.kind === "send")!;
    expect(ask.title).toBe(
      "Asked you to approve: Book Diggies, Thu 7 pm, 4 people",
    );
    expect(ask.detail).toBe("approved by you in 14.0 s");
    const sync = entries.find((entry) => entry.kind === "computer")!;
    expect(sync.isError).toBe(true);
    expect(sync.detail).toBe("degraded · 3 pushed · 1 failures");
  });

  test("an unanswered approval is waiting, and Jev judgments are shown", () => {
    const entries = projectWorkLogTurnV1(run, booking()).entries;
    expect(entries.find((entry) => entry.kind === "send")!.detail).toBe(
      "waiting for you",
    );
    const read = entries.find((entry) => entry.title === "Turn read")!;
    expect(read.detail).toBe("moderate · consequence 3 · clear · needs web");
    expect(read.durationMs).toBe(180);
    expect(read.sections?.[0]?.text).toContain("Does it reach outside?");
  });

  test("a Routine firing is said to come from the Routine", () => {
    const turn = projectWorkLogTurnV1(
      {
        ...run,
        admission: { turnType: "automation", origin: { kind: "routine" } },
      },
      booking(),
    );
    expect(turn.via).toBe("Routine");
  });

  test("caps a runaway Turn and says how much it left out", () => {
    seq = 0;
    const events = [event(0, "turn/start", { turn: 1 })];
    for (let index = 0; index < WORK_LOG_MAX_ENTRIES_V1 + 5; index += 1) {
      events.push(
        event(index, "model/retry", {
          turn: 1,
          step: 1,
          attempt: 1,
          classification: "transient",
          delayMs: 1,
        }),
      );
    }
    const turn = projectWorkLogTurnV1(run, events);
    expect(turn.entries).toHaveLength(WORK_LOG_MAX_ENTRIES_V1);
    expect(turn.omittedEntries).toBe(5);
    expect(() => decodeProtocol("WorkLogTurn", turn)).not.toThrow();
  });

  test("a cut event shows what the projection kept", () => {
    seq = 0;
    const turn = projectWorkLogTurnV1(run, [
      event(0, "tool/call", {
        turn: 1,
        step: 1,
        occurrenceId: "o1",
        name: "shell",
        truncated: true,
        excerpt: '{"input":{"command":"ls',
      }),
    ]);
    expect(turn.entries[0]!.sections?.[0]?.label).toBe(
      "Excerpt — the full event is too large to show",
    );
  });
});

describe("the inspector's shape", () => {
  test("a tool call carries how it got to run", () => {
    const tool = projectWorkLogTurnV1(run, booking()).entries.find(
      (entry) => entry.kind === "tool",
    )!;
    expect(tool.label).toBe("Tool call");
    expect(tool.chain).toEqual([
      { kind: "model", title: "Asked for by request #1" },
      {
        kind: "jev",
        title: "Jev · allow",
        detail: "matches request",
        durationMs: 212,
      },
      {
        kind: "tool",
        title: "Ran",
        detail: "Free after 6:00 pm",
        durationMs: 412,
      },
    ]);
    expect(tool.fields).toContainEqual({ label: "Effect key", value: "o1" });
    expect(tool.sections?.map((section) => section.tab)).toEqual([
      "input",
      "result",
    ]);
  });

  test("a model request is numbered, and its prompt and output are tabbed", () => {
    const model = projectWorkLogTurnV1(run, booking()).entries.find(
      (entry) => entry.kind === "model",
    )!;
    expect(model.label).toBe("Request #1");
    expect(
      model.sections?.map((section) => [section.label, section.tab]),
    ).toEqual([
      ["System prompt", "prompt"],
      ["Last message in", "prompt"],
      ["What the model said", "output"],
      ["Tool calls", "tools"],
    ]);
  });

  test("a Jev check says its verdict", () => {
    const entries = projectWorkLogTurnV1(run, booking()).entries;
    const review = entries.find((entry) => entry.label === "Call review")!;
    expect(review.verdict).toBe("Allow");
    expect(entries.find((entry) => entry.title === "Turn read")!.verdict).toBe(
      "Moderate",
    );
  });

  test("a compaction before the Turn began is marked as between Turns", () => {
    seq = 0;
    const turn = projectWorkLogTurnV1(run, [
      event(0, "conversation/compaction-intent", {
        effectId: "e",
        throughTurn: 38,
        provider: "frock-ai",
        model: "auto",
      }),
      event(4100, "conversation/compacted", {
        effectId: "e",
        fromTurn: 1,
        throughTurn: 38,
        summary: "Tim books dinners with Sam.",
        identifiers: ["Sam"],
        provider: "frock-ai",
        model: "auto",
      }),
      event(4200, "turn/start", { turn: 39 }),
    ]);
    expect(turn.entries[0]).toMatchObject({
      kind: "compaction",
      beforeTurn: true,
      durationMs: 4100,
    });
    expect(() => decodeProtocol("WorkLogTurn", turn)).not.toThrow();
  });
});

describe("decodeWorkLogQueryV1", () => {
  test("takes a run cursor and nothing else", () => {
    expect(decodeWorkLogQueryV1({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    });
    const before = "run-index:2026-09-28T09:14:18.000Z:run-42";
    expect(decodeWorkLogQueryV1({ schemaVersion: 1, before })).toEqual({
      schemaVersion: 1,
      before,
    });
    expect(() =>
      decodeWorkLogQueryV1({ schemaVersion: 1, before: "nope" }),
    ).toThrow();
    expect(() => decodeWorkLogQueryV1({ schemaVersion: 1, x: 1 })).toThrow();
  });
});

describe("readWorkLogV1", () => {
  test("reads a page, answers approvals from the record, and skips a run it cannot read", async () => {
    const runIds = Array.from(
      { length: WORK_LOG_PAGE_TURNS_V1 + 1 },
      (_, index) => `run-${index}`,
    );
    const asked: unknown[] = [];
    const state = {
      authority: {
        listRunIndex: async (query: unknown) => {
          asked.push(query);
          return runIds.map((runId) => ({
            cursor: `run-index:2026-09-28T09:14:18.000Z:${runId}`,
            runId,
          }));
        },
        readRunEventProjections: async (runId: string) => {
          if (runId === "run-1") throw new Error("incomplete event range");
          return {
            run: { ...run, runId },
            events: booking(),
            eventCount: booking().length,
          };
        },
      },
      ctx: {
        storage: {
          get: async (key: string) =>
            key.endsWith("ap-1") ? approval : undefined,
        },
      },
    } as unknown as ShellBotStateV1;
    const page = await readWorkLogV1(state, { schemaVersion: 1 });
    expect(asked).toEqual([{ limit: WORK_LOG_PAGE_TURNS_V1 + 1 }]);
    expect(page.turns.map((turn) => turn.runId)).toEqual(
      runIds.slice(0, WORK_LOG_PAGE_TURNS_V1).filter((id) => id !== "run-1"),
    );
    expect(page.nextCursor).toBe(
      `run-index:2026-09-28T09:14:18.000Z:run-${WORK_LOG_PAGE_TURNS_V1 - 1}`,
    );
    expect(
      page.turns[0]!.entries.find((entry) => entry.kind === "send")!.detail,
    ).toBe("approved by you in 14.0 s");
  });
});

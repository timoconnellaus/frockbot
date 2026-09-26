import { describe, expect, test } from "bun:test";
import {
  decodeSessionEvent,
  emptyConversationHeadV1,
  type LlmMessage,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import {
  clearTurnToolResultsV1,
  historyCharsV1,
  PRUNED_TOOL_RESULT_V1,
  TURN_TOOL_CLEAR_TRIGGER_CHARS_V1,
} from "./compaction.js";
import { CHAT_HISTORY_BUDGET_CHARS_V1 } from "./history.js";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { SessionEventLog } from "@frockbot/core/durable";
import {
  applyWorkingContextAppendV1,
  selectStoredWorkingContextV1,
  WorkingContextUnavailableError,
} from "./working-context-store.js";
import {
  assembleJournalContextV1,
  chooseWorkingTurnsV1,
  TURN_GROWTH_CEILING_V1,
} from "./working-context.js";

const SESSION = "user:bot";

function stamp(
  inputs: SessionEventInput[],
  start = 0,
): ReturnType<typeof decodeSessionEvent>[] {
  return inputs.map((input, index) =>
    decodeSessionEvent({
      ...input,
      seq: start + index,
      timestamp: new Date(1_700_000_000_000 + start + index).toISOString(),
    }),
  );
}

function chatTurn(
  turn: number,
  text: string,
  toolChars = 0,
): SessionEventInput[] {
  const events: SessionEventInput[] = [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    {
      type: "user/message",
      turn,
      step: 1,
      messageId: `m-${turn}`,
      text,
    },
  ];
  if (toolChars > 0) {
    events.push(
      {
        type: "assistant/message",
        turn,
        step: 1,
        requestId: `r-${turn}`,
        text: "",
        toolCalls: [{ id: `c-${turn}`, name: "search", input: {} }],
        providerState: {
          provider: "openai-compatible",
          model: "m",
          connectionId: "conn",
          content: JSON.stringify({ replay: turn }),
        },
      },
      {
        type: "tool/result",
        turn,
        step: 1,
        occurrenceId: `tool:${turn}:1:0`,
        name: "search",
        content: "T".repeat(toolChars),
        isError: false,
        status: "completed",
      },
    );
  }
  events.push(
    {
      type: "assistant/message",
      turn,
      step: 1,
      requestId: `r2-${turn}`,
      text: `answer ${turn}`,
      toolCalls: [],
    },
    { type: "step/end", turn, step: 1, outcome: "completed" },
    { type: "turn/end", turn, outcome: "completed" },
  );
  return events;
}

class BoundedStorage extends MemoryStorage {
  gets: string[] = [];

  override get<T>(key: string): Promise<T | undefined> {
    this.gets.push(key);
    return super.get(key);
  }

  override list<T>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    if (
      options.limit === undefined &&
      (prefix.startsWith("session-events:") || prefix.startsWith("context:"))
    ) {
      throw new Error("unbounded archive read");
    }
    return super.list(options);
  }
}

async function projectTurns(
  storage: BoundedStorage,
  count: number,
  toolChars: number,
): Promise<number> {
  let seq = 0;
  for (let turn = 1; turn <= count; turn += 1) {
    const events = stamp(chatTurn(turn, `question ${turn}`, toolChars), seq);
    await applyWorkingContextAppendV1(storage, SESSION, events);
    seq += events.length;
  }
  return seq;
}

describe("working context projection", () => {
  test("old runs do not increase the pages fetched for a bounded request", async () => {
    const small = new BoundedStorage();
    const large = new BoundedStorage();
    await projectTurns(small, 4, 400);
    await projectTurns(large, 24, 400);
    small.gets = [];
    large.gets = [];
    const request = {
      sessionId: SESSION,
      currentTurn: 100,
      currentTurnType: "chat" as const,
      currentMessages: [{ role: "user" as const, content: "now" }],
      budget: 1_200,
    };
    await selectStoredWorkingContextV1(small, request);
    await selectStoredWorkingContextV1(large, request);
    const pages = (gets: string[]) =>
      gets.filter((key) => key.includes("context:page:")).length;
    expect(pages(large.gets)).toBe(pages(small.gets));
    expect(pages(large.gets)).toBeGreaterThan(0);
    expect(large.gets.some((key) => key.startsWith("session-events:"))).toBe(
      false,
    );
  });

  test("a replayed range is a no-op and a gap is refused", async () => {
    const storage = new BoundedStorage();
    const events = stamp(chatTurn(1, "hello"));
    await applyWorkingContextAppendV1(storage, SESSION, events);
    const before = await storage.get(
      `context:head:${encodeURIComponent(SESSION)}`,
    );
    await applyWorkingContextAppendV1(storage, SESSION, events);
    expect(
      JSON.stringify(
        await storage.get(`context:head:${encodeURIComponent(SESSION)}`),
      ),
    ).toBe(JSON.stringify(before));
    const gap = stamp([{ type: "turn/start", turn: 2 }], events.length + 5);
    await expect(
      applyWorkingContextAppendV1(storage, SESSION, gap),
    ).rejects.toThrow(/gap or overlap/);
  });

  test("eviction after each commit still selects the same request", async () => {
    const storage = new BoundedStorage();
    let seq = 0;
    for (const turn of [1, 2]) {
      const events = stamp(chatTurn(turn, `question ${turn}`), seq);
      await applyWorkingContextAppendV1(storage, SESSION, events);
      seq += events.length;
      const selected = await selectStoredWorkingContextV1(storage, {
        sessionId: SESSION,
        currentTurn: turn + 1,
        currentTurnType: "chat",
        currentMessages: [{ role: "user", content: "next" }],
        budget: 100_000,
      });
      expect(selected.map((message) => message.content)).toContain(
        `question ${turn}`,
      );
    }
  });

  test("a missing page is an unavailable context, not a shortened prompt", async () => {
    const storage = new BoundedStorage();
    await projectTurns(storage, 2, 10);
    const page = [...storage.values.keys()].find((key) =>
      key.startsWith("context:page:"),
    );
    expect(page).toBeTruthy();
    storage.values.delete(page!);
    await expect(
      selectStoredWorkingContextV1(storage, {
        sessionId: SESSION,
        currentTurn: 3,
        currentTurnType: "chat",
        currentMessages: [{ role: "user", content: "now" }],
      }),
    ).rejects.toBeInstanceOf(WorkingContextUnavailableError);
  });

  test("a stale compaction epoch does not replace the summary", async () => {
    const storage = new BoundedStorage();
    const first = stamp(chatTurn(1, "hello"));
    await applyWorkingContextAppendV1(storage, SESSION, first, {
      expectedEpoch: 1,
    });
    const head = await storage.get<{
      epoch: number;
      compaction?: { summary: string };
    }>(`context:head:${encodeURIComponent(SESSION)}`);
    await expect(
      applyWorkingContextAppendV1(
        storage,
        SESSION,
        stamp(
          [
            {
              type: "conversation/compacted",
              effectId: "late",
              fromTurn: 1,
              throughTurn: 1,
              summary: "replaced",
              identifiers: [],
              provider: "p",
              model: "m",
            },
          ],
          first.length,
        ),
        { expectedEpoch: (head?.epoch ?? 1) + 3 },
      ),
    ).rejects.toThrow(/epoch/);
    const after = await storage.get<{ compaction?: { summary: string } }>(
      `context:head:${encodeURIComponent(SESSION)}`,
    );
    expect(after?.compaction?.summary).toBeUndefined();
  });

  test("selecting context does not read archived model requests", async () => {
    const storage = new BoundedStorage();
    const events = stamp([
      ...chatTurn(1, "hello", 100),
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "req",
          provider: "p",
          model: "m",
          system: "x".repeat(10_000),
          messages: [],
          tools: [],
        },
      },
    ]);
    const log = new SessionEventLog(storage);
    await log.append(SESSION, events);
    storage.gets = [];
    await selectStoredWorkingContextV1(storage, {
      sessionId: SESSION,
      currentTurn: 2,
      currentTurnType: "chat",
      currentMessages: [{ role: "user", content: "later" }],
    });
    expect(
      storage.gets.some((key) => key.includes("session-events:payload:")),
    ).toBe(false);
  });

  test("provider replay and a long current turn stay intact", () => {
    const events = stamp([
      ...chatTurn(1, "hello", 50),
      { type: "turn/start", turn: 2 },
      { type: "turn/admission", turn: 2, turnType: "chat" },
      { type: "step/start", turn: 2, step: 1 },
      {
        type: "user/message",
        turn: 2,
        step: 1,
        messageId: "m-2",
        text: "x".repeat(500),
      },
    ]);
    const messages = assembleJournalContextV1({
      events,
      sessionId: SESSION,
      currentTurn: 2,
      currentTurnType: "chat",
      currentMessages: [{ role: "user", content: "x".repeat(500) }],
      budget: 40,
    });
    expect(messages.at(-1)?.content).toBe("x".repeat(500));
    expect(messages[0]?.content).toContain("not included here");
    const kept = assembleJournalContextV1({
      events,
      sessionId: SESSION,
      currentTurn: 2,
      currentTurnType: "chat",
      currentMessages: [{ role: "user", content: "now" }],
      budget: 100_000,
    });
    const assistant = kept.find((message) => message.role === "assistant");
    expect(
      assistant && "providerState" in assistant
        ? assistant.providerState
        : undefined,
    ).toMatchObject({ content: JSON.stringify({ replay: 1 }) });
  });
});

describe("history for one Turn", () => {
  const head = {
    ...emptyConversationHeadV1("user-1:bot-1"),
    messageBearingChatTurns: 10,
  };
  // Ten older Turns of 10k characters each, newest first.
  const turns = Array.from({ length: 10 }, (_, index) => ({
    turn: 10 - index,
    turnType: "chat" as const,
    fullChars: 10_000,
    prunedChars: 10_000,
    messageBearing: true,
  }));
  const choose = (currentChars: number) =>
    chooseWorkingTurnsV1({
      head,
      turns,
      currentTurn: 11,
      currentTurnType: "chat",
      currentChars,
      openingChars: 1_000,
      budget: 50_000,
    });

  test("is the same at every step, so each step hits the prompt cache", () => {
    const first = choose(1_000);
    // The Turn's own tool traffic grows; the history it carries does not move.
    expect(choose(20_000)).toEqual(first);
    expect(choose(30_000)).toEqual(first);
    expect(first.kept).toEqual([10, 9, 8, 7]);
  });

  test("is chosen again once the Turn outgrows its ceiling", () => {
    const first = choose(1_000);
    const grown = choose(50_000 * TURN_GROWTH_CEILING_V1);
    expect(grown.kept.length).toBeLessThan(first.kept.length);
  });
});

describe("a Turn whose tool traffic outgrows the whole budget", () => {
  const openTurn = (turn: number, text: string): SessionEventInput[] => [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    { type: "user/message", turn, step: 1, messageId: `m-${turn}`, text },
  ];
  const next = "can you give me a link to the email";
  const history = [
    ...chatTurn(1, "how do I book the smash room"),
    ...chatTurn(2, "find the voucher for Becky", 350_000),
  ];
  const contents = (messages: { content: string }[]) =>
    messages.map((message) => message.content);

  test("keeps the Turn before it, and the big Turn's own words, within budget", () => {
    const messages = assembleJournalContextV1({
      events: stamp([...history, ...openTurn(3, next)]),
      sessionId: SESSION,
      currentTurn: 3,
      currentTurnType: "chat",
      currentMessages: [{ role: "user", content: next }],
    });
    expect(contents(messages)).toContain("how do I book the smash room");
    expect(contents(messages)).toContain("find the voucher for Becky");
    expect(contents(messages)).toContain("answer 2");
    expect(contents(messages)).toContain(PRUNED_TOOL_RESULT_V1);
    expect(historyCharsV1(messages)).toBeLessThanOrEqual(
      CHAT_HISTORY_BUDGET_CHARS_V1,
    );
  });

  test("the stored projection chooses the same", async () => {
    const storage = new BoundedStorage();
    await applyWorkingContextAppendV1(storage, SESSION, stamp(history));
    const messages = await selectStoredWorkingContextV1(storage, {
      sessionId: SESSION,
      currentTurn: 3,
      currentTurnType: "chat",
      currentMessages: [{ role: "user", content: next }],
    });
    expect(contents(messages)).toContain("how do I book the smash room");
    expect(contents(messages)).toContain("answer 2");
    expect(historyCharsV1(messages)).toBeLessThanOrEqual(
      CHAT_HISTORY_BUDGET_CHARS_V1,
    );
  });

  test("the stored projection reads past a page with a skipped Turn", async () => {
    // Twenty Turns span two index pages. Turn 19 alone is too big to keep
    // even pruned; every other Turn, including the four on the older page,
    // still fits.
    const events = stamp([
      ...Array.from({ length: 20 }, (_, index) =>
        chatTurn(
          index + 1,
          index + 1 === 19 ? "y".repeat(151_000) : `said ${index + 1}`,
        ),
      ).flat(),
    ]);
    const storage = new BoundedStorage();
    await applyWorkingContextAppendV1(storage, SESSION, events);
    const request = {
      sessionId: SESSION,
      currentTurn: 21,
      currentTurnType: "chat" as const,
      currentMessages: [{ role: "user" as const, content: next }],
    };
    const stored = await selectStoredWorkingContextV1(storage, request);
    expect(contents(stored)).toContain("said 1");
    expect(contents(stored)).toEqual(
      contents(assembleJournalContextV1({ ...request, events })),
    );
  });

  test("an older Turn charged pruned is rendered pruned", () => {
    // Turn 4 is skipped whole but still spends a verbatim slot, so Turn 2 is
    // outside the window: it must not come back with its 140k payload.
    const messages = assembleJournalContextV1({
      events: stamp([
        ...chatTurn(1, "one", 60_000),
        ...chatTurn(2, "two", 140_000),
        ...chatTurn(3, "three", 10_000),
        ...chatTurn(4, "four", 350_000),
        ...openTurn(5, "now"),
      ]),
      sessionId: SESSION,
      currentTurn: 5,
      currentTurnType: "chat",
      currentMessages: [{ role: "user", content: "now" }],
    });
    expect(contents(messages)).toContain("two");
    expect(historyCharsV1(messages)).toBeLessThanOrEqual(
      CHAT_HISTORY_BUDGET_CHARS_V1,
    );
  });
});

describe("the Turn being assembled", () => {
  function toolLoop(results: number, chars: number): LlmMessage[] {
    const messages: LlmMessage[] = [{ role: "user", content: "find it" }];
    for (let index = 0; index < results; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: `c${index}`, name: "fetch", input: { id: `m${index}` } },
          ],
        },
        {
          role: "tool",
          callId: `c${index}`,
          name: "fetch",
          content: String(index).repeat(chars),
          isError: false,
        },
      );
    }
    return messages;
  }

  test("is untouched below the trigger", () => {
    const messages = toolLoop(3, 10_000);
    expect(clearTurnToolResultsV1(messages)).toEqual(messages);
  });

  test("a long tool loop stays bounded and keeps its newest result", () => {
    const messages = toolLoop(12, 85_000);
    const cleared = clearTurnToolResultsV1(messages);
    expect(historyCharsV1(cleared)).toBeLessThanOrEqual(
      TURN_TOOL_CLEAR_TRIGGER_CHARS_V1 + 85_000,
    );
    expect(cleared.at(-1)).toEqual(messages.at(-1));
    // Calls and their inputs survive, so the model can ask again.
    expect(cleared.filter((message) => message.role === "assistant")).toEqual(
      messages.filter((message) => message.role === "assistant"),
    );
  });

  test("never clears results the model has not read, however many one step made", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "x".repeat(40_000) },
      {
        role: "assistant",
        content: "",
        toolCalls: [0, 1, 2].map((index) => ({
          id: `c${index}`,
          name: "fetch",
          input: {},
        })),
      },
      ...[0, 1, 2].map((index): LlmMessage => ({
        role: "tool",
        callId: `c${index}`,
        name: "fetch",
        content: String(index).repeat(40_000),
        isError: false,
      })),
    ];
    expect(clearTurnToolResultsV1(messages)).toEqual(messages);
  });

  test("a cleared result stays cleared at every later step", () => {
    const messages = toolLoop(12, 30_000);
    let previous: LlmMessage[] = [];
    let clearings = 0;
    for (let step = 1; step <= messages.length; step += 1) {
      const cleared = clearTurnToolResultsV1(messages.slice(0, step));
      const unchanged = previous.every(
        (message, index) => cleared[index]!.content === message.content,
      );
      if (!unchanged) clearings += 1;
      for (const [index, message] of previous.entries()) {
        if (message.content === PRUNED_TOOL_RESULT_V1) {
          expect(cleared[index]!.content).toBe(PRUNED_TOOL_RESULT_V1);
        }
      }
      previous = cleared;
    }
    // Batches, not one clearing per step: most steps keep the prefix whole.
    expect(clearings).toBeGreaterThan(0);
    expect(clearings).toBeLessThan(6);
  });

  test("a long tool loop over a full history stays under the prepaid bound", () => {
    // Bob's Turn 119: twelve steps of 85k email bodies after a full history.
    // The bound counts the request's bytes; leave 70k for system and tools.
    const history = Array.from({ length: 30 }, (_, index) =>
      chatTurn(index + 1, `question ${index + 1}`, 6_000),
    ).flat();
    for (let step = 1; step <= 12; step += 1) {
      const messages = assembleJournalContextV1({
        events: stamp(history),
        sessionId: SESSION,
        currentTurn: 31,
        currentTurnType: "chat",
        currentMessages: toolLoop(step, 85_000),
      });
      const bytes = new TextEncoder().encode(JSON.stringify(messages)).length;
      expect(bytes).toBeLessThan(400_000 - 70_000);
    }
  });

  test("is cleared in the rendered request too", () => {
    const current = toolLoop(12, 85_000);
    const messages = assembleJournalContextV1({
      events: stamp(chatTurn(1, "earlier")),
      sessionId: SESSION,
      currentTurn: 2,
      currentTurnType: "chat",
      currentMessages: current,
    });
    expect(contents(messages)).toContain("earlier");
    expect(historyCharsV1(messages)).toBeLessThan(
      TURN_TOOL_CLEAR_TRIGGER_CHARS_V1 + 85_000 + 1_000,
    );
  });

  const contents = (messages: { content: string }[]) =>
    messages.map((message) => message.content);
});

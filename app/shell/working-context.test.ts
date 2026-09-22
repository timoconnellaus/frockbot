import { describe, expect, test } from "bun:test";
import {
  decodeSessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { SessionEventLog } from "@frockbot/core/durable";
import {
  applyWorkingContextAppendV1,
  selectStoredWorkingContextV1,
  WorkingContextUnavailableError,
} from "./working-context-store.js";
import { assembleJournalContextV1 } from "./working-context.js";

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

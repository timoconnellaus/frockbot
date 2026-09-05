import { describe, expect, test } from "bun:test";
import { Session, type SessionEvent } from "@frockbot/kernel-contracts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import {
  SESSION_EVENT_PAGE_BYTES_V1,
  SessionEventLog,
  sessionEventLogIndexKeyV1,
  sessionEventLogPagePrefixV1,
  sessionEventPayloadPrefixV1,
} from "./session-event-log.ts";

const SESSION_ID = "user-1:primary";

function journal(systemBytes = 80_000): SessionEvent[] {
  const session = new Session(SESSION_ID, () => {});
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "message-1",
      text: "hello",
    },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "request-1",
        provider: "fake",
        model: "large-context",
        system: "s".repeat(systemBytes),
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "done",
      toolCalls: [],
    },
    { type: "step/end", turn: 1, step: 1, outcome: "completed" },
    { type: "turn/end", turn: 1, outcome: "completed" },
  ]);
  return [...session.events];
}

describe("the paged Session event log", () => {
  test("keeps exact large requests behind bounded cut projections", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    const events = journal();

    await log.rewrite(SESSION_ID, events);

    expect(await log.read(SESSION_ID)).toEqual(events);
    const projection = (await log.readProjections(SESSION_ID)).find(
      (event) => (event as { type?: string }).type === "model/request",
    ) as {
      cut: { marker: string; originalBytes: number; sha256: string };
      request: {
        requestId: string;
        messageCount: number;
        toolCount: number;
        truncated: boolean;
      };
    };
    expect(projection).toMatchObject({
      cut: { marker: "content-cut", originalBytes: expect.any(Number) },
      request: {
        requestId: "request-1",
        messageCount: 1,
        toolCount: 0,
        truncated: true,
      },
    });
    expect(projection.cut.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      [...storage.values.entries()]
        .filter(([key]) =>
          key.startsWith(sessionEventLogPagePrefixV1(SESSION_ID)),
        )
        .every(
          ([, value]) =>
            new TextEncoder().encode(JSON.stringify(value)).byteLength <=
            SESSION_EVENT_PAGE_BYTES_V1,
        ),
    ).toBe(true);
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith(sessionEventPayloadPrefixV1(SESSION_ID)),
      ),
    ).toBe(true);
  });

  test("cuts large assistant and tool bodies without losing their exact events", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    const session = new Session(SESSION_ID, () => {});
    const assistantText = "assistant".repeat(4_000);
    const toolContent = "tool-result".repeat(4_000);
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: assistantText,
        toolCalls: [{ id: "call-1", name: "computer_exec", input: {} }],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "computer_exec",
        input: {},
      },
      {
        type: "tool/result",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "computer_exec",
        content: toolContent,
        isError: false,
        status: "completed",
      },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
      { type: "turn/end", turn: 1, outcome: "completed" },
    ]);
    const events = [...session.events];

    await log.rewrite(SESSION_ID, events);

    expect(await log.read(SESSION_ID)).toEqual(events);
    const cut = (await log.readProjections(SESSION_ID)).filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        Object.hasOwn(event, "cut"),
    ) as Array<{
      type: string;
      cut: { marker: string; originalBytes: number; sha256: string };
      truncated: boolean;
    }>;
    expect(cut.map((event) => event.type)).toEqual([
      "assistant/message",
      "tool/result",
    ]);
    expect(cut).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          truncated: true,
          cut: expect.objectContaining({
            marker: "content-cut",
            originalBytes: expect.any(Number),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        }),
      ]),
    );
  });

  test("appends across fixed-size pages and preserves contiguous ranges", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    const session = new Session(SESSION_ID, () => {});
    for (let turn = 1; turn <= 40; turn += 1) {
      session.appendBatch([
        { type: "turn/start", turn },
        { type: "step/start", turn, step: 1 },
        {
          type: "user/message",
          turn,
          step: 1,
          messageId: `message-${turn}`,
          text: "u".repeat(10_000),
        },
        { type: "step/end", turn, step: 1, outcome: "completed" },
        { type: "turn/end", turn, outcome: "completed" },
      ]);
    }
    const events = [...session.events];

    await log.rewrite(SESSION_ID, events.slice(0, 101));
    await log.append(SESSION_ID, events.slice(101));

    expect(await log.read(SESSION_ID)).toEqual(events);
    expect(await log.readRange(SESSION_ID, 95, 110)).toEqual(
      events.slice(95, 110),
    );
    const pages = [...storage.values.keys()].filter((key) =>
      key.startsWith(sessionEventLogPagePrefixV1(SESSION_ID)),
    );
    expect(pages.length).toBeGreaterThan(1);
  });

  test("rebases compact run ranges when repair inserts into the log", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    const timestamp = "2026-09-04T00:00:00.000Z";
    const before: SessionEvent[] = [
      { type: "turn/start", seq: 0, timestamp, turn: 1 },
      { type: "turn/start", seq: 1, timestamp, turn: 2 },
    ];
    await log.rewrite(SESSION_ID, before);
    await storage.put({
      "run:first": {
        sessionId: SESSION_ID,
        previousEventCount: 0,
        eventRange: { startSeq: 0, endSeq: 1 },
      },
      "run:second": {
        sessionId: SESSION_ID,
        previousEventCount: 1,
        eventRange: { startSeq: 1, endSeq: 2 },
      },
    });
    const repaired: SessionEvent[] = [
      before[0]!,
      {
        type: "turn/end",
        seq: 1,
        timestamp,
        turn: 1,
        outcome: "interrupted",
      },
      { ...before[1]!, seq: 2 },
    ];

    await log.rewrite(SESSION_ID, repaired);

    expect(
      await storage.get<{ eventRange: unknown }>("run:first"),
    ).toMatchObject({ eventRange: { startSeq: 0, endSeq: 2 } });
    expect(
      await storage.get<{ eventRange: unknown }>("run:second"),
    ).toMatchObject({
      previousEventCount: 2,
      eventRange: { startSeq: 2, endSeq: 3 },
    });
    expect(await log.readRange(SESSION_ID, 2, 3)).toEqual([repaired[2]]);
  });

  test("reads a range without hydrating unrelated model requests", async () => {
    const storage = new MemoryStorage();
    const session = new Session(SESSION_ID, () => {});
    for (let turn = 1; turn <= 12; turn += 1) {
      session.appendBatch([
        { type: "turn/start", turn },
        {
          type: "model/request",
          turn,
          step: 1,
          request: {
            requestId: `request-${turn}`,
            provider: "fake",
            model: "large-context",
            system: "s".repeat(80_000),
            messages: [],
            tools: [],
          },
        },
        { type: "turn/end", turn, outcome: "completed" },
      ]);
    }
    const log = new SessionEventLog(storage);
    await log.rewrite(SESSION_ID, [...session.events]);

    const reads: string[] = [];
    const get = storage.get.bind(storage);
    storage.get = <T>(key: string): Promise<T | undefined> => {
      reads.push(key);
      return get<T>(key);
    };

    const range = await log.readRange(SESSION_ID, 0, 1);

    expect(range).toEqual([session.events[0]!]);
    expect(
      reads.filter((key) =>
        key.startsWith(sessionEventPayloadPrefixV1(SESSION_ID)),
      ),
    ).toEqual([]);
    // The index, the bisected pages, and nothing else: the cost of a range is
    // the range, not every request the conversation has ever retained.
    expect(reads.length).toBeLessThanOrEqual(4);
  });

  test("hydrates only the payloads its own range references", async () => {
    const storage = new MemoryStorage();
    const session = new Session(SESSION_ID, () => {});
    for (let turn = 1; turn <= 12; turn += 1) {
      session.appendBatch([
        { type: "turn/start", turn },
        {
          type: "model/request",
          turn,
          step: 1,
          request: {
            requestId: `request-${turn}`,
            provider: "fake",
            model: "large-context",
            system: "s".repeat(80_000),
            messages: [],
            tools: [],
          },
        },
        { type: "turn/end", turn, outcome: "completed" },
      ]);
    }
    const log = new SessionEventLog(storage);
    await log.rewrite(SESSION_ID, [...session.events]);

    const reads: string[] = [];
    const get = storage.get.bind(storage);
    storage.get = <T>(key: string): Promise<T | undefined> => {
      reads.push(key);
      return get<T>(key);
    };

    const range = await log.readRange(SESSION_ID, 30, 33);

    expect(range).toEqual(session.events.slice(30, 33));
    const payloads = new Set(
      reads
        .filter((key) =>
          key.startsWith(sessionEventPayloadPrefixV1(SESSION_ID)),
        )
        .map((key) => key.slice(0, key.lastIndexOf(":"))),
    );
    const requestSeq = session.events
      .slice(30, 33)
      .find((event) => event.type === "model/request")!.seq;
    expect([...payloads]).toEqual([
      `${sessionEventPayloadPrefixV1(SESSION_ID)}${String(requestSeq).padStart(12, "0")}`,
    ]);
  });

  test("leaves exact model requests off the display range", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    const events = journal();
    await log.rewrite(SESSION_ID, events);

    const reads: string[] = [];
    const get = storage.get.bind(storage);
    storage.get = <T>(key: string): Promise<T | undefined> => {
      reads.push(key);
      return get<T>(key);
    };

    const display = await log.readDisplayRange(SESSION_ID, 0, events.length);

    expect(display.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
    expect(display.map((event) => event.seq)).toEqual(
      events.map((event) => event.seq),
    );
    expect(
      reads.filter((key) =>
        key.startsWith(sessionEventPayloadPrefixV1(SESSION_ID)),
      ),
    ).toEqual([]);
    const request = display.find((event) => event.type === "model/request");
    expect(request?.type === "model/request" && request.request.requestId).toBe(
      "request-1",
    );
    // The excerpt says what it is; the exact request stays on the audit path.
    expect(
      request?.type === "model/request" && request.request.system.length,
    ).toBeLessThan(80_000);
    expect(await log.readRange(SESSION_ID, 0, events.length)).toEqual(events);
  });

  test("migrates the legacy single value on demand", async () => {
    const storage = new MemoryStorage();
    const events = journal(1_900_000);
    storage.values.set("latest-events", structuredClone(events));
    const log = new SessionEventLog(storage);

    expect(await log.migrate(SESSION_ID)).toEqual(events);

    expect(storage.values.has("latest-events")).toBe(false);
    expect(storage.values.has(sessionEventLogIndexKeyV1(SESSION_ID))).toBe(
      true,
    );
    expect(await log.read(SESSION_ID)).toEqual(events);
  });
});

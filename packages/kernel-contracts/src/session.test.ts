import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  SessionStore,
  type SessionStoreConfig,
  validateToolOccurrenceJournal,
} from "./session.js";
import {
  decodeSessionEvent,
  type NormalizedModelRequest,
  type SessionEvent,
  type SessionEventInput,
} from "./types.js";

const roots: Context[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";

function durableEvents(inputs: SessionEventInput[]): SessionEvent[] {
  return inputs.map((input, seq) => ({
    ...input,
    seq,
    timestamp,
  })) as SessionEvent[];
}

async function createStore(
  initialSessions?: Readonly<Record<string, readonly SessionEvent[]>>,
  config: Omit<SessionStoreConfig, "initialSessions"> = {},
): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(SessionStore, { ...config, initialSessions });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("SessionStore", () => {
  test("accepts resumable tool crash states only while their step is open", () => {
    const assistant = [
      { type: "turn/start" as const, turn: 1 },
      { type: "step/start" as const, turn: 1, step: 1 },
      {
        type: "assistant/message" as const,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "",
        toolCalls: [
          { id: "provider-call", name: "write", input: { value: "x" } },
        ],
      },
    ] satisfies SessionEventInput[];
    const intent = {
      type: "tool/call" as const,
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: "write",
      input: { value: "x" },
    } satisfies SessionEventInput;

    const unjournaled = validateToolOccurrenceJournal(
      durableEvents(assistant),
    ).get("tool:1:1:0");
    expect(unjournaled?.intent).toBeUndefined();
    expect(unjournaled?.result).toBeUndefined();
    const journaled = validateToolOccurrenceJournal(
      durableEvents([...assistant, intent]),
    ).get("tool:1:1:0");
    expect(journaled?.intent).toMatchObject(intent);
    expect(journaled?.result).toBeUndefined();
  });

  test.each([
    [
      "tool intent after step end",
      [
        { type: "turn/start" as const, turn: 1 },
        { type: "step/start" as const, turn: 1, step: 1 },
        {
          type: "assistant/message" as const,
          turn: 1,
          step: 1,
          requestId: "request-1",
          text: "",
          toolCalls: [
            { id: "provider-call", name: "write", input: { value: "x" } },
          ],
        },
        {
          type: "step/end" as const,
          turn: 1,
          step: 1,
          outcome: "completed" as const,
        },
        {
          type: "tool/call" as const,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "write",
          input: { value: "x" },
        },
      ],
      "was not settled before step end",
    ],
    [
      "tool result after turn end",
      [
        { type: "turn/start" as const, turn: 1 },
        { type: "step/start" as const, turn: 1, step: 1 },
        {
          type: "assistant/message" as const,
          turn: 1,
          step: 1,
          requestId: "request-1",
          text: "",
          toolCalls: [
            { id: "provider-call", name: "write", input: { value: "x" } },
          ],
        },
        {
          type: "tool/call" as const,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "write",
          input: { value: "x" },
        },
        {
          type: "tool/result" as const,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "write",
          content: "done",
          isError: false,
          status: "completed" as const,
        },
        {
          type: "step/end" as const,
          turn: 1,
          step: 1,
          outcome: "completed" as const,
        },
        { type: "turn/end" as const, turn: 1, outcome: "completed" as const },
        {
          type: "tool/result" as const,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "write",
          content: "duplicate",
          isError: false,
          status: "completed" as const,
        },
      ],
      "outside its open step",
    ],
    [
      "mismatched step end",
      [
        { type: "turn/start" as const, turn: 1 },
        { type: "step/start" as const, turn: 1, step: 1 },
        {
          type: "step/end" as const,
          turn: 1,
          step: 2,
          outcome: "completed" as const,
        },
      ],
      "ended without its matching start",
    ],
    [
      "turn end with an open step",
      [
        { type: "turn/start" as const, turn: 1 },
        { type: "step/start" as const, turn: 1, step: 1 },
        { type: "turn/end" as const, turn: 1, outcome: "completed" as const },
      ],
      "ended while step 1 is open",
    ],
    [
      "nested turn start",
      [
        { type: "turn/start" as const, turn: 1 },
        { type: "turn/start" as const, turn: 2 },
      ],
      "started while turn 1 is open",
    ],
  ])(
    "rejects adversarial lifecycle ordering: %s",
    (_label, inputs, message) => {
      expect(() =>
        validateToolOccurrenceJournal(
          durableEvents(inputs as SessionEventInput[]),
        ),
      ).toThrow(message as string);
    },
  );

  test("replays the exact request under its recorded Composition generation", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-1");
    const request: NormalizedModelRequest = {
      requestId: "request-1",
      provider: "scripted",
      model: "test",
      system: "Be concise.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    };

    session.appendBatch([
      { type: "turn/start", turn: 1 },
      {
        type: "composition/pinned",
        turn: 1,
        generationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
        artifactSetHash: "a".repeat(64),
      },
      { type: "input/admitted", messageId: "message-1", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "user/message",
        turn: 1,
        step: 1,
        messageId: "message-1",
        text: "Hello",
      },
      { type: "model/request", turn: 1, step: 1, request },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "Hi",
        toolCalls: [],
      },
      // Self-modification is a durable effect the log reconstructs: the intent
      // is recorded before the bundler runs, the outcome after it.
      {
        type: "package/author-intent",
        turn: 1,
        step: 1,
        effectId: "author-0123456789abcdef",
        packageId: "weather-lookup",
        sourceHash: "c".repeat(64),
      },
      {
        type: "package/authored",
        turn: 1,
        step: 1,
        effectId: "author-0123456789abcdef",
        packageId: "weather-lookup",
        version: "0.0.1",
        contentHash: "d".repeat(64),
        generationId: "2026-08-31T01:00:00.000Z:fedcba9876543210",
      },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
      { type: "turn/end", turn: 1, outcome: "completed" },
    ]);

    const recorded = session.events.find(
      (event) => event.type === "model/request",
    );
    const pin = session.events.find(
      (event) => event.type === "composition/pinned",
    );
    expect(
      recorded?.type === "model/request" ? recorded.request : undefined,
    ).toEqual(request);
    expect(
      pin?.type === "composition/pinned"
        ? {
            generationId: pin.generationId,
            artifactSetHash: pin.artifactSetHash,
          }
        : undefined,
    ).toEqual({
      generationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
      artifactSetHash: "a".repeat(64),
    });
    const authored = session.events.find(
      (event) => event.type === "package/authored",
    );
    expect(
      authored?.type === "package/authored"
        ? {
            effectId: authored.effectId,
            packageId: authored.packageId,
            version: authored.version,
            generationId: authored.generationId,
          }
        : undefined,
    ).toEqual({
      effectId: "author-0123456789abcdef",
      packageId: "weather-lookup",
      version: "0.0.1",
      generationId: "2026-08-31T01:00:00.000Z:fedcba9876543210",
    });
    // The authoring events belong to the pinned generation, not the one they
    // produced: activation is at the next admitted Turn.
    expect(
      authored?.type === "package/authored"
        ? authored.generationId ===
            (pin?.type === "composition/pinned" ? pin.generationId : "")
        : undefined,
    ).toBe(false);
    expect(
      session.events.map((event) => decodeSessionEvent(structuredClone(event))),
    ).toEqual([...session.events]);
    expect(session.deriveMessages()).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi", toolCalls: [] },
    ]);
    expect(session.events.map((event) => event.seq)).toEqual(
      session.events.map((_, index) => index),
    );
  });

  test("flushes appended events through the durable seam in order", async () => {
    const persisted: Array<{ sessionId: string; types: string[] }> = [];
    const root = await createStore(undefined, {
      persistEvents: async (sessionId, events) => {
        await Promise.resolve();
        persisted.push({
          sessionId,
          types: events.map((event) => event.type),
        });
      },
    });
    const session = root.sessions.create("durable-session");
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "turn/end", turn: 1, outcome: "completed" },
    ]);

    expect(persisted).toEqual([]);
    await session.flush();
    expect(persisted).toEqual([
      { sessionId: "durable-session", types: ["session/created"] },
      {
        sessionId: "durable-session",
        types: ["turn/start", "turn/end"],
      },
    ]);
  });

  test("rehydrates a session and continues its sequence", async () => {
    const firstRoot = await createStore();
    const first = firstRoot.sessions.create("durable-session");
    first.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "turn/end", turn: 1, outcome: "completed" },
    ]);
    const stored = structuredClone([...first.events]);

    const secondRoot = await createStore({ "durable-session": stored });
    const rehydrated = secondRoot.sessions.create("durable-session");
    expect(rehydrated.events).toEqual(stored);
    expect(rehydrated.nextTurn()).toBe(2);
    expect(rehydrated.append({ type: "turn/start", turn: 2 }).seq).toBe(3);
  });

  test("rejects a non-contiguous durable event log", async () => {
    const root = await createStore({
      broken: [
        {
          type: "session/created",
          createdAt: "2026-08-27T00:00:00.000Z",
          seq: 1,
          timestamp: "2026-08-27T00:00:00.000Z",
        },
      ],
    });
    expect(() => root.sessions.create("broken")).toThrow(
      "non-contiguous event log",
    );
  });

  test("reconciles unmatched tools, steps, and turns in order", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-2");
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      {
        type: "composition/pinned",
        turn: 1,
        generationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
        artifactSetHash: "a".repeat(64),
      },
      { type: "input/admitted", messageId: "message-1", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "",
        toolCalls: [{ id: "call-1", name: "write", input: { value: "x" } }],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "write",
        input: { value: "x" },
      },
    ]);

    const repaired = session.reconcileInterrupted();
    expect(repaired.map((event) => event.type)).toEqual([
      "tool/result",
      "step/end",
      "turn/end",
    ]);
    expect(
      repaired.find((event) => event.type === "tool/result"),
    ).toMatchObject({
      occurrenceId: "tool:1:1:0",
      status: "interrupted",
      isError: true,
    });
    expect(session.deriveMessages().at(-1)).toMatchObject({
      role: "tool",
      callId: "call-1",
    });
    expect(session.reconcileInterrupted()).toEqual([]);
  });

  test("disposes all live sessions with its Cordis fiber", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-3");
    await root.fiber.dispose();
    roots.splice(roots.indexOf(root), 1);

    expect(session.disposed).toBe(true);
    expect(session.events.at(-1)?.type).toBe("session/disposed");
  });
});

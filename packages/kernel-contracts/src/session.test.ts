import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  SESSION_ATTACHMENT_MAX_BASE64,
  SessionStore,
  type SessionStoreConfig,
  validateToolOccurrenceJournal,
} from "./session.js";
import {
  decodeSessionEvent,
  type NormalizedModelRequest,
  type SessionEvent,
  type SessionEventInput,
  turnFailureMessage,
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

  test("preserves open tool intents for effect reconciliation on resume", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-resume-tool");
    session.appendBatch([
      { type: "turn/start", turn: 1 },
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

    expect(session.reconcileForResume()).toEqual([]);
    expect(
      validateToolOccurrenceJournal(session.events).get("tool:1:1:0"),
    ).toMatchObject({ intent: { occurrenceId: "tool:1:1:0" } });
    expect(
      session.events.some(
        (event) =>
          event.type === "tool/result" ||
          event.type === "step/end" ||
          event.type === "turn/end",
      ),
    ).toBe(false);
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
  test("decodes invoked Skills on an input, and refuses a malformed one", () => {
    const base = {
      type: "input/queued" as const,
      seq: 0,
      timestamp,
      messageId: "message-1",
      text: "run the standup",
    };
    // An input recorded before invocation existed still decodes unchanged.
    expect(decodeSessionEvent(structuredClone(base))).toEqual(base);
    const invoking = {
      ...base,
      skills: [
        { schemaVersion: 1 as const, source: "bot" as const, slug: "s" },
      ],
    };
    expect(decodeSessionEvent(structuredClone(invoking))).toEqual(invoking);
    expect(() =>
      decodeSessionEvent({ ...base, skills: [{ source: "bot", slug: "s" }] }),
    ).toThrow();
    expect(() => decodeSessionEvent({ ...base, skills: "bot/s" })).toThrow();
  });

  test("decodes skill/invoked with exact keys and a decoded ref", () => {
    const event = {
      type: "skill/invoked" as const,
      seq: 0,
      timestamp,
      turn: 1,
      ref: { schemaVersion: 1 as const, source: "bot" as const, slug: "s" },
      generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
      contentHash: "a".repeat(64),
    };
    expect(decodeSessionEvent(structuredClone(event))).toEqual(event);
    expect(() => decodeSessionEvent({ ...event, step: 1 })).toThrow(
      "session event has invalid fields",
    );
    expect(() =>
      decodeSessionEvent({
        ...event,
        ref: { schemaVersion: 1, source: "workflow", slug: "s" },
      }),
    ).toThrow();
  });

  test("decodes a turn/end reason only within its declared bound", () => {
    const base = {
      type: "turn/end" as const,
      seq: 0,
      timestamp,
      turn: 1,
      outcome: "model-error" as const,
    };
    const withReason = {
      ...base,
      reason: "Ollama Cloud responded 401: invalid api key",
    };
    expect(decodeSessionEvent(structuredClone(withReason))).toEqual(withReason);
    expect(
      decodeSessionEvent(structuredClone({ ...base, reason: "x".repeat(500) })),
    ).toMatchObject({ reason: "x".repeat(500) });
    expect(() =>
      decodeSessionEvent({ ...base, reason: "x".repeat(501) }),
    ).toThrow("session event.reason is too long");
    expect(() => decodeSessionEvent({ ...base, reason: "" })).toThrow(
      "session event.reason must be a string",
    );
    expect(() =>
      decodeSessionEvent({ ...base, reason: "why", cause: "extra" }),
    ).toThrow("session event has invalid fields");
  });

  test("decodes a rename announcement and refuses a malformed one", () => {
    // A rename happens outside any Turn, so the event carries no turn or step
    // and every other session event keeps decoding exactly as before.
    const renamed = {
      type: "bot/renamed" as const,
      seq: 4,
      timestamp,
      from: "Housework",
      to: "Atlas",
      namedBy: "bot" as const,
    };
    expect(decodeSessionEvent(structuredClone(renamed))).toEqual(renamed);
    expect(() => decodeSessionEvent({ ...renamed, namedBy: "admin" })).toThrow(
      "session event.namedBy is invalid",
    );
    expect(() => decodeSessionEvent({ ...renamed, from: "" })).toThrow(
      "session event.from must be a string",
    );
    expect(() => decodeSessionEvent({ ...renamed, turn: 1 })).toThrow(
      "session event has invalid fields",
    );
  });

  test("carries the Bot and Turn that renamed the Bot, when one did", () => {
    const writer = {
      kind: "bot" as const,
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      turnId: "turn-4",
    };
    const renamed = {
      type: "bot/renamed" as const,
      seq: 4,
      timestamp,
      from: "Housework",
      to: "Atlas",
      namedBy: "bot" as const,
      writer,
    };
    expect(decodeSessionEvent(structuredClone(renamed))).toEqual(renamed);
    // Only a Bot writer exists, so a User rename can never carry one.
    expect(() => decodeSessionEvent({ ...renamed, namedBy: "user" })).toThrow(
      "session event.writer is invalid",
    );
    expect(() =>
      decodeSessionEvent({ ...renamed, writer: { ...writer, kind: "user" } }),
    ).toThrow("session event.writer.kind is invalid");
    expect(() =>
      decodeSessionEvent({ ...renamed, writer: { ...writer, extra: 1 } }),
    ).toThrow("session event.writer has invalid fields");
  });

  test("composes a failure message from a turn outcome and its reason", () => {
    expect(turnFailureMessage("model-error", "provider said no")).toBe(
      "Bot turn ended with outcome model-error: provider said no",
    );
    expect(turnFailureMessage("interrupted")).toBe(
      "Bot turn ended with outcome interrupted",
    );
  });
});

describe("resolved attachment bytes", () => {
  const attachment = {
    kind: "image" as const,
    mediaType: "image/png" as const,
    workspacePath: {
      root: {
        kind: "package-declared" as const,
        userId: "user-1",
        packageId: "computer",
        rootId: "screenshots",
      },
      path: "bot-1/run-9-1.png",
    },
    contentHash: "c".repeat(64),
    bytes: 3,
  };

  async function sessionWithScreenshot() {
    const root = await createStore();
    const session = root.sessions.create("session-1");
    session.append({ type: "turn/start", turn: 1 });
    session.append({ type: "step/start", turn: 1, step: 1 });
    session.append({
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "",
      toolCalls: [{ id: "call-1", name: "computer_screenshot", input: {} }],
    });
    session.append({
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: "computer_screenshot",
      input: {},
    });
    session.append({
      type: "tool/result",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: "computer_screenshot",
      content: "{}",
      isError: false,
      status: "completed",
      attachments: [attachment],
    });
    return session;
  }

  // The reference is durable and the bytes are not: while the Session is
  // resident the request carries the picture, and on the far side of an
  // eviction it carries the path, which is the observable outcome rather than
  // a silent one.
  test("reaches the derived request only while the Session holds them", async () => {
    const session = await sessionWithScreenshot();

    const before = session.deriveMessages().at(-1);
    expect(before).toMatchObject({ attachments: [attachment] });

    session.offerAttachmentBytes(attachment.contentHash, "AAAA");
    const after = session.deriveMessages().at(-1);
    expect(after).toMatchObject({
      attachments: [{ ...attachment, dataBase64: "AAAA" }],
    });

    // And they never become durable: the event still holds a reference only.
    const recorded = session.events.findLast(
      (event) => event.type === "tool/result",
    );
    expect(JSON.stringify(recorded)).not.toContain("AAAA");
  });

  test("refuses an offer that is not a content hash or is oversized", async () => {
    const session = await sessionWithScreenshot();

    session.offerAttachmentBytes("not-a-hash", "AAAA");
    session.offerAttachmentBytes(
      attachment.contentHash,
      "A".repeat(SESSION_ATTACHMENT_MAX_BASE64 + 1),
    );

    expect(session.deriveMessages().at(-1)).toMatchObject({
      attachments: [attachment],
    });
  });
});

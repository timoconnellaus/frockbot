import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  latestModelRequestJournalState,
  planBotRunRecovery,
} from "./run-recovery.js";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.js";

// Distributive, so each member of the union keeps its own fields: a bare
// `Omit` over the union collapses to the keys they all share.
type UnstampedEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, "seq" | "timestamp">
    : never
  : never;

/** Stamp a journal in order, the way `Session.append` would have. */
function journal(...events: UnstampedEvent[]): SessionEvent[] {
  return events.map(
    (event, index) =>
      ({
        ...event,
        seq: index + 1,
        timestamp: new Date(Date.UTC(2026, 8, 3, 0, 0, index)).toISOString(),
      }) as SessionEvent,
  );
}

const request: UnstampedEvent = {
  type: "model/request",
  turn: 1,
  step: 1,
  request: {
    requestId: "request-1",
    provider: "flock-ai",
    model: "@frock/auto",
    system: "Be concise.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  },
};

describe("latestModelRequestJournalState", () => {
  test("reports a journaled request with no answer as unresolved", () => {
    const state = latestModelRequestJournalState(journal(request));

    expect(state.status).toBe("unresolved");
    // The whole request travels with the state: it is the idempotency key the
    // loop re-issues the call under.
    expect(
      state.status === "none" ? undefined : state.request.request.requestId,
    ).toBe("request-1");
  });

  test("reports a request its own answer closed as completed", () => {
    expect(
      latestModelRequestJournalState(
        journal(request, {
          type: "assistant/message",
          turn: 1,
          step: 1,
          requestId: "request-1",
          text: "hi",
          toolCalls: [],
        }),
      ).status,
    ).toBe("completed");
  });

  test("a dispatch re-issued under the same key is still one request", () => {
    const state = latestModelRequestJournalState(journal(request, request));

    expect(state.status).toBe("unresolved");
    expect(
      state.status === "none" ? undefined : state.request.request.requestId,
    ).toBe("request-1");
  });

  test("ignores an answer journaled against another request", () => {
    expect(
      latestModelRequestJournalState(
        journal(request, {
          type: "model/response-failed",
          turn: 1,
          step: 1,
          requestId: "request-0",
          failure: { code: "invalid-json", message: "an earlier call" },
        }),
      ).status,
    ).toBe("unresolved");
  });
});

// A restart mid-Turn used to park every in-flight run on a reconciliation
// nobody could perform: the providers this deployment uses expose no response
// retrieval, so the banner's Resolve action had one possible outcome and the
// Bot stayed wedged until somebody clicked it. A model request is keyed by its
// own `requestId`, so the run resumes and re-issues the same request instead.
describe("a restart with an unanswered model request", () => {
  const codec = createStoredRunCodecV1<null>({
    decodeRunId: (value) => String(value),
    decodeConfigurationSnapshot: () => null,
  });

  function runWith(events: SessionEvent[]): StoredRunV1<null> {
    return {
      runId: "run-1",
      commandFingerprint: "fingerprint-1",
      sessionId: "user-1:bot-1",
      acceptedAt: new Date(Date.UTC(2026, 8, 3)).toISOString(),
      input: "hello",
      events,
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "generation-1",
      configurationSnapshot: null,
      previousEventCount: 0,
    };
  }

  /** `Session` requires a zero-based contiguous log; this file's own stamper is one-based. */
  function durableJournal(...events: UnstampedEvent[]): SessionEvent[] {
    return events.map(
      (event, index) =>
        ({
          ...event,
          seq: index,
          timestamp: new Date(Date.UTC(2026, 8, 3, 0, 0, index)).toISOString(),
        }) as SessionEvent,
    );
  }

  const openTurn: UnstampedEvent[] = [
    {
      type: "session/created",
      createdAt: new Date(Date.UTC(2026, 8, 3)).toISOString(),
    },
    { type: "input/queued", messageId: "message-1", text: "hello" },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "message-1",
      text: "hello",
    },
  ];

  test("resumes rather than parking the run for a person to resolve", () => {
    const events = durableJournal(...openTurn, request);

    expect(planBotRunRecovery(runWith(events), events, codec).kind).toBe(
      "resume",
    );
  });

  test("resumes a request already re-issued under its key", () => {
    const events = durableJournal(...openTurn, request, request);

    expect(planBotRunRecovery(runWith(events), events, codec).kind).toBe(
      "resume",
    );
  });

  test("resumes an open tool occurrence, to run again under its effect id", () => {
    const events = durableJournal(
      ...openTurn,
      request,
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "",
        toolCalls: [{ id: "call-1", name: "echo", input: { text: "hi" } }],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "echo",
        input: { text: "hi" },
      },
    );

    expect(planBotRunRecovery(runWith(events), events, codec).kind).toBe(
      "resume",
    );
  });

  test("preserves the words the Turn had already streamed", () => {
    const events = durableJournal(...openTurn, request, {
      type: "assistant/chunk",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "Half a thought",
    });
    const plan = planBotRunRecovery(runWith(events), events, codec);

    expect(plan.kind).toBe("resume");
    // Nothing in the plan discards the journal: the resumed run carries its
    // own events, and the projection reads the partial answer back out.
    expect(
      events.some(
        (event) =>
          event.type === "assistant/chunk" && event.text === "Half a thought",
      ),
    ).toBe(true);
  });
});

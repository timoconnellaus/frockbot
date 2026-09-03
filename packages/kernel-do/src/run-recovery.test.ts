import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  latestModelRequestJournalState,
  planBotRunRecovery,
  UNRECONCILABLE_RUN_FAILURE_V1,
  unresolvedModelRequestFailure,
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
    model: "@flock/auto",
    system: "Be concise.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  },
};

function reconciliationRequired(
  requestId: string,
  reason: string,
): UnstampedEvent {
  return {
    type: "model/reconciliation-required",
    turn: 1,
    step: 1,
    requestId,
    reason,
  };
}

function unresolved(...events: UnstampedEvent[]): string {
  const stamped = journal(...events);
  const state = latestModelRequestJournalState(stamped);
  if (state.status !== "unresolved") {
    throw new Error(`expected an unresolved request, got ${state.status}`);
  }
  return unresolvedModelRequestFailure(stamped, state.request);
}

describe("unresolvedModelRequestFailure", () => {
  test("carries the Agent's journaled reason", () => {
    expect(
      unresolved(
        request,
        reconciliationRequired(
          "request-1",
          "Model response outcome is uncertain: Model response stream ended before a terminal marker",
        ),
      ),
    ).toBe(
      'Model request "request-1" has no durable provider outcome: Model response outcome is uncertain: Model response stream ended before a terminal marker',
    );
  });

  test("ignores a reason journaled against another request", () => {
    expect(
      unresolved(
        request,
        reconciliationRequired("request-0", "an earlier call"),
      ),
    ).toBe('Model request "request-1" has no durable provider outcome');
  });

  // A run wedged by isolate eviction never got as far as journaling a reason.
  test("summarizes when the Agent journaled no reason", () => {
    expect(unresolved(request)).toBe(
      'Model request "request-1" has no durable provider outcome',
    );
  });
});

// ADR 0028. A restart mid-Turn used to park every in-flight run on a
// reconciliation nobody could perform: the providers this deployment actually
// uses expose no response retrieval, so the banner's Resolve action had one
// possible outcome and the Bot stayed wedged until somebody clicked it.
describe("a restart with no retrievable provider outcome", () => {
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

  test("settles the run as failed rather than parking it", () => {
    const events = durableJournal(...openTurn, request);
    const plan = planBotRunRecovery(
      runWith(events),
      events,
      codec,
      (provider) => provider === "foundation",
    );

    expect(plan.kind).toBe("fail");
    expect(plan.kind === "fail" ? plan.failure : "").toBe(
      UNRECONCILABLE_RUN_FAILURE_V1,
    );
    // Whatever repairs the resume would have written travel with the
    // settlement, so an unresolved tool occurrence is closed rather than left
    // open in a record nothing will ever revisit. This journal needs none.
    expect(plan.kind === "fail" ? plan.repairs : undefined).toEqual([]);
  });

  test("keeps parking a run whose provider can be asked", () => {
    const events = durableJournal(...openTurn, request);
    const plan = planBotRunRecovery(runWith(events), events, codec, () => true);

    expect(plan.kind).toBe("reconcile");
  });

  test("parks by default, so a host that names no policy is unaffected", () => {
    const events = durableJournal(...openTurn, request);

    expect(planBotRunRecovery(runWith(events), events, codec).kind).toBe(
      "reconcile",
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
    const plan = planBotRunRecovery(
      runWith(events),
      events,
      codec,
      () => false,
    );

    expect(plan.kind).toBe("fail");
    // Nothing in the plan discards the journal: the settled record carries the
    // run's own events, and the projection reads the partial answer back out.
    expect(
      events.some(
        (event) =>
          event.type === "assistant/chunk" && event.text === "Half a thought",
      ),
    ).toBe(true);
  });
});

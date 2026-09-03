import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  latestModelRequestJournalState,
  unresolvedModelRequestFailure,
} from "./run-recovery.js";

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
  const plain = "This reply stopped partway. Try again to continue it.";

  test("gives the banner plain copy whatever the Agent journaled", () => {
    expect(
      unresolved(
        request,
        reconciliationRequired(
          "request-1",
          "Model response outcome is uncertain: Model response stream ended before a terminal marker",
        ),
      ),
    ).toBe(plain);
    expect(
      unresolved(
        request,
        reconciliationRequired("request-0", "an earlier call"),
      ),
    ).toBe(plain);
  });

  // A run wedged by isolate eviction never got as far as journaling a reason.
  test("says the same when the Agent journaled no reason", () => {
    expect(unresolved(request)).toBe(plain);
  });
});

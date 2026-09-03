import {
  Session,
  type SessionEvent,
  toolCallOccurrences,
  validateSettledToolOccurrenceJournal,
  validateToolOccurrenceJournal,
  turnFailureMessage,
} from "@frockbot/kernel-contracts";
import { BotTurnExecutionError } from "./turn-errors.js";
import type { StoredRunCodecV1, StoredRunV1 } from "./run-records.js";

export type BotRunRecoveryPlan =
  | { kind: "complete"; responseText: string }
  | { kind: "fail"; failure: string }
  | { kind: "restart"; previous: SessionEvent[] }
  | { kind: "resume" }
  | { kind: "reconcile"; repairs: SessionEvent[] };

export type ModelRequestJournalState =
  | { status: "none" }
  | {
      status: "unresolved" | "completed";
      request: Extract<SessionEvent, { type: "model/request" }>;
    }
  | {
      status: "no-effect";
      request: Extract<SessionEvent, { type: "model/request" }>;
      outcome: Extract<SessionEvent, { type: "model/effect-not-started" }>;
    };

function invalidToolJournal(error: unknown): BotRunRecoveryPlan {
  return {
    kind: "fail",
    failure: `Invalid durable tool journal: ${
      error instanceof Error ? error.message : "unknown structural error"
    }`,
  };
}

export function latestModelRequestJournalState(
  events: readonly SessionEvent[],
): ModelRequestJournalState {
  let state: ModelRequestJournalState = { status: "none" };
  for (const event of events) {
    if (event.type === "model/request") {
      state = { status: "unresolved", request: event };
    } else if (
      event.type === "model/effect-not-started" &&
      state.status === "unresolved" &&
      event.requestId === state.request.request.requestId
    ) {
      state = { status: "no-effect", request: state.request, outcome: event };
    } else if (
      event.type === "assistant/message" &&
      state.status !== "none" &&
      event.requestId === state.request.request.requestId
    ) {
      state = { status: "completed", request: state.request };
    }
  }
  return state;
}

/**
 * Why an unresolved Model request parked its run, in the operator's words
 * where the Agent recorded them.
 *
 * The request id alone names *which* call is unsettled but not what went
 * wrong, and the Agent's own reason is journaled on
 * `model/reconciliation-required` — an event the chat projection drops. Read
 * back here it reaches the banner the person is actually looking at.
 */
export function unresolvedModelRequestFailure(
  events: readonly SessionEvent[],
  request: Extract<SessionEvent, { type: "model/request" }>,
): string {
  // The journaled reason names provider internals, so it stays on the run
  // record for the debug surface; the banner gets a sentence about what to do.
  void events;
  void request;
  return "This reply stopped partway. Try again to continue it.";
}

export function planBotRunRecovery<Snapshot>(
  run: StoredRunV1<Snapshot>,
  latest: readonly SessionEvent[],
  codec: StoredRunCodecV1<Snapshot>,
): BotRunRecoveryPlan {
  codec.require(run);
  let toolJournal: ReturnType<typeof validateToolOccurrenceJournal>;
  try {
    toolJournal = validateToolOccurrenceJournal(run.events);
  } catch (error) {
    return invalidToolJournal(error);
  }
  const terminalTurn = run.events.findLast(
    (event) => event.type === "turn/end",
  );
  const lastAssistant = run.events.findLast(
    (event) => event.type === "assistant/message",
  );
  if (terminalTurn?.type === "turn/end") {
    try {
      validateSettledToolOccurrenceJournal(run.events);
    } catch (error) {
      return invalidToolJournal(error);
    }
    if (terminalTurn.outcome !== "completed") {
      return {
        kind: "fail",
        failure: turnFailureMessage(terminalTurn.outcome),
      };
    }
    return {
      kind: "complete",
      responseText:
        lastAssistant?.type === "assistant/message" ? lastAssistant.text : "",
    };
  }
  // A direct tool Turn has no model request by construction. Its single
  // synthetic assistant/tool occurrence is nevertheless resumable at every
  // durable boundary: before intent it can start, after intent it reconciles,
  // and after result it only needs its terminal events appended.
  if (run.directTool) return { kind: "resume" };
  const modelState = latestModelRequestJournalState(run.events);
  if (modelState.status === "no-effect") {
    try {
      validateSettledToolOccurrenceJournal(run.events);
    } catch (error) {
      return invalidToolJournal(error);
    }
    return { kind: "resume" };
  }
  if (modelState.status === "completed") {
    const resumableOccurrences = new Set(
      lastAssistant?.type === "assistant/message"
        ? toolCallOccurrences(
            lastAssistant.turn,
            lastAssistant.step,
            lastAssistant.toolCalls,
          ).map((occurrence) => occurrence.occurrenceId)
        : [],
    );
    const skippedOccurrence = [...toolJournal.values()].find(
      (entry) =>
        !entry.intent &&
        !entry.result &&
        !resumableOccurrences.has(entry.occurrence.occurrenceId),
    );
    if (skippedOccurrence) {
      return invalidToolJournal(
        new Error(
          `tool occurrence "${skippedOccurrence.occurrence.occurrenceId}" was skipped before recovery`,
        ),
      );
    }
    const unresolvedIntent = [...toolJournal.values()].some(
      (entry) => entry.intent && !entry.result,
    );
    if (!unresolvedIntent) return { kind: "resume" };
  }
  const hasExternalIntent = run.events.some(
    (event) => event.type === "model/request" || event.type === "tool/call",
  );
  if (!hasExternalIntent) {
    if (toolJournal.size > 0) {
      return invalidToolJournal(
        new Error("assistant tool occurrences have no durable model request"),
      );
    }
    return {
      kind: "restart",
      previous: [...latest.slice(0, run.previousEventCount)],
    };
  }
  const session = new Session(run.sessionId, () => {}, latest);
  return { kind: "reconcile", repairs: session.reconcileForResume() };
}

export function eventsForFailedRun(
  durableRun: { events: SessionEvent[] } | undefined,
  error: unknown,
): SessionEvent[] {
  if (durableRun) return structuredClone(durableRun.events);
  return error instanceof BotTurnExecutionError
    ? structuredClone(error.events)
    : [];
}

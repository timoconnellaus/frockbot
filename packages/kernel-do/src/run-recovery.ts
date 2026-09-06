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
  | { kind: "resume" };

export type ModelRequestJournalState =
  | { status: "none" }
  | {
      status: "unresolved" | "completed";
      request: Extract<SessionEvent, { type: "model/request" }>;
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
      (event.type === "assistant/message" ||
        event.type === "model/response-failed") &&
      state.status !== "none" &&
      event.requestId === state.request.request.requestId
    ) {
      state = { status: "completed", request: state.request };
    }
  }
  return state;
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
        failure: turnFailureMessage(terminalTurn.outcome, terminalTurn.reason),
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
  // durable boundary: before intent it can start, after intent it is sent
  // again under its own key, and after result it only needs its terminal
  // events appended.
  if (run.directTool) return { kind: "resume" };
  const modelState = latestModelRequestJournalState(run.events);
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
  // Every external effect the log carries is keyed — a model request by its
  // own id, a tool occurrence by its occurrence id — so an interrupted Turn is
  // dispatched again under those keys rather than investigated.
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
  return { kind: "resume" };
}

/** True when the durable log ends inside a Turn nothing is going to finish. */
export function hasOrphanedOpenTurnV1(
  events: readonly SessionEvent[],
): boolean {
  let openTurn: number | undefined;
  for (const event of events) {
    if (event.type === "turn/start") openTurn = event.turn;
    if (event.type === "turn/end" && event.turn === openTurn) {
      openTurn = undefined;
    }
  }
  return openTurn !== undefined;
}

/**
 * Closes a Turn the log was left inside, so the next one can start.
 *
 * A Turn that threw between `turn/start` and `turn/end` — an event the
 * encoder refused, a durable write that failed — leaves an open turn in the
 * durable log, and the next Turn on that Bot fails validation with "turn N
 * started while turn N-1 is open". Forever: nothing owned the repair, because
 * the run that would have written the `turn/end` is already terminal. This is
 * that repair, applied when no run is executing, so an interrupted Turn is
 * recorded as interrupted rather than wedging the Bot.
 *
 * A log too malformed to reconcile is left exactly as it is: repairing it
 * blindly would invent history.
 */
export function repairOrphanedOpenTurnV1(
  sessionId: string,
  latest: readonly SessionEvent[],
): SessionEvent[] {
  if (!hasOrphanedOpenTurnV1(latest)) return [];
  try {
    return new Session(sessionId, () => {}, latest).reconcileInterrupted();
  } catch {
    return [];
  }
}

/**
 * True when *any* Turn in the log was never closed — including one buried
 * behind later Turns that are themselves well formed.
 *
 * `hasOrphanedOpenTurnV1` only sees a log that *ends* inside a Turn, and that
 * is the shape a wedged Bot stops having after its very first retry. The Agent
 * loop journals `turn/start` durably and only then assembles the request, so
 * the Turn that discovers the invariant is broken has already written its own
 * `turn/start`, and its `finally` writes a matching `turn/end` carrying the
 * validation message. The log that comes out of that ends closed — with the
 * abandoned Turn still open several events back — so the trailing-open test
 * says there is nothing to repair, and every later message fails the same way.
 */
export function hasUnclosedTurnV1(events: readonly SessionEvent[]): boolean {
  let openTurn: number | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      if (openTurn !== undefined) return true;
      openTurn = event.turn;
    }
    if (event.type === "turn/end" && event.turn === openTurn) {
      openTurn = undefined;
    }
  }
  return openTurn !== undefined;
}

/**
 * The whole durable log with every abandoned Turn closed, or `undefined` when
 * there is nothing to repair or the log cannot be repaired without inventing
 * history.
 *
 * A Turn left open in the middle of the log cannot be closed by appending:
 * `turn/end` for it would land after the Turns that followed, and the log
 * would still read as "turn N started while turn N-1 is open". So the repair
 * *rewrites* the log, inserting the closing events at the point the Turn was
 * abandoned and resequencing what follows. The inserted events are the ones
 * the interrupted-run repair already writes — every unresolved tool occurrence
 * closed as `interrupted`, then `step/end`, then `turn/end` with outcome
 * `interrupted` — so a Turn nobody finished reads as one nobody finished.
 *
 * Only called where nothing is entitled to write those ends: at admission and
 * promotion with no run executing, and at settlement, where the run that owned
 * the Turn has just stopped.
 */
export function repairedSessionLogV1(
  sessionId: string,
  latest: readonly SessionEvent[],
): SessionEvent[] | undefined {
  if (!hasUnclosedTurnV1(latest)) return undefined;
  let repaired: SessionEvent[] = [];
  const closeOpenTurn = (): boolean => {
    if (repaired.length === 0 || !hasOrphanedOpenTurnV1(repaired)) return true;
    try {
      const session = new Session(sessionId, () => {}, repaired);
      session.reconcileInterrupted();
      repaired = [...session.events];
    } catch {
      return false;
    }
    return !hasOrphanedOpenTurnV1(repaired);
  };
  for (const event of latest) {
    if (event.type === "turn/start" && !closeOpenTurn()) return undefined;
    repaired.push({ ...event, seq: repaired.length });
  }
  if (!closeOpenTurn()) return undefined;
  return repaired;
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

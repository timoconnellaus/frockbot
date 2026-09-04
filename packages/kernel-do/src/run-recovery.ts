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
  | { kind: "fail"; failure: string; repairs?: SessionEvent[] }
  | { kind: "restart"; previous: SessionEvent[] }
  | { kind: "resume" }
  | { kind: "reconcile"; repairs: SessionEvent[] };

/**
 * What a Turn says when a restart caught it mid-answer and nobody can be asked
 * how it ended (ADR 0028).
 *
 * It is written for the person watching, not for an operator: they saw the Bot
 * start talking and then stop, and the only useful thing to tell them is that
 * it will not be finishing that sentence and sending again is safe.
 */
export const UNRECONCILABLE_RUN_FAILURE_V1 =
  "This Turn stopped partway — the service restarted while the model was answering, and there is no way to find out how that request ended. Try sending it again.";

/**
 * Whether the provider a run was talking to can be asked what happened to a
 * request it never answered.
 *
 * Given the provider id off the run's own durable `model/request`, so the
 * answer is the same on every recovery of the same run, with no dependency on
 * what happens to be mounted or resident.
 */
export type ProviderReconcilesV1 = (providerId: string) => boolean;

/** The provider the run's most recent durable model request was addressed to. */
export function latestModelRequestProviderV1(
  events: readonly SessionEvent[],
): string | undefined {
  const request = events.findLast((event) => event.type === "model/request");
  return request?.type === "model/request"
    ? request.request.provider
    : undefined;
}

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
  const requestId = request.request.requestId;
  const summary = `Model request "${requestId}" has no durable provider outcome`;
  const journaled = events.findLast(
    (event) =>
      event.type === "model/reconciliation-required" &&
      event.requestId === requestId,
  );
  return journaled?.type === "model/reconciliation-required"
    ? `${summary}: ${journaled.reason}`
    : summary;
}

export function planBotRunRecovery<Snapshot>(
  run: StoredRunV1<Snapshot>,
  latest: readonly SessionEvent[],
  codec: StoredRunCodecV1<Snapshot>,
  providerReconciles: ProviderReconcilesV1 = () => true,
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
  const repairs = session.reconcileForResume();
  // ADR 0028. A Turn whose model outcome is unknown is parked only when
  // somebody can actually be asked. When the provider offers no retrieval,
  // parking is not caution — it is a dead end: nothing will ever arrive to
  // resolve it, the Bot stays wedged behind it, and the person is handed a
  // Resolve button whose only possible answer is "give up". So the run is
  // settled `failed` here, with its repairs and every streamed word it had
  // already sent kept in the journal.
  const provider = latestModelRequestProviderV1(run.events);
  if (provider !== undefined && !providerReconciles(provider)) {
    return { kind: "fail", failure: UNRECONCILABLE_RUN_FAILURE_V1, repairs };
  }
  return { kind: "reconcile", repairs };
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

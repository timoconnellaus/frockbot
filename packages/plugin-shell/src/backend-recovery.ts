import {
  Session,
  type SessionEvent,
  toolCallOccurrences,
  validateSettledToolOccurrenceJournal,
  validateToolOccurrenceJournal,
} from "@frockbot/agent-core";
import { BotTurnExecutionError } from "./backend-runner.js";
import { requireStoredRunV1, type StoredRun } from "./backend-contracts.js";

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

export function planBotRunRecovery(
  run: StoredRun,
  latest: readonly SessionEvent[],
): BotRunRecoveryPlan {
  requireStoredRunV1(run);
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
        failure: `Bot turn ended with outcome ${terminalTurn.outcome}`,
      };
    }
    return {
      kind: "complete",
      responseText:
        lastAssistant?.type === "assistant/message" ? lastAssistant.text : "",
    };
  }
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
  durableRun: StoredRun | undefined,
  error: unknown,
): SessionEvent[] {
  if (durableRun) return structuredClone(durableRun.events);
  return error instanceof BotTurnExecutionError
    ? structuredClone(error.events)
    : [];
}

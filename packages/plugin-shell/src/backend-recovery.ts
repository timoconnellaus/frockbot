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

export type StoppedRunRecoveryPlan =
  { kind: "cancel"; events: SessionEvent[] } | { kind: "reconcile" };

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
 * Classifies the unresolved effects of a stopped run from their durable
 * admission records. With no compatibility data, a missing admission is the
 * same definitive no-start outcome as `fenced`; only explicit `admitted`
 * remains uncertain.
 */
export function planStoppedRunRecovery(
  run: StoredRun,
  latest: readonly SessionEvent[],
): StoppedRunRecoveryPlan {
  requireStoredRunV1(run);
  if (!run.stopRequestedAt) {
    throw new Error(`run "${run.runId}" has no durable stop intent`);
  }
  const admissionFor = (kind: "model" | "tool", effectId: string) => {
    const admission = run.effectAdmissions.find(
      (candidate) => candidate.effectId === effectId,
    );
    if (admission && admission.kind !== kind) {
      throw new Error(
        `effect admission "${effectId}" collides with ${admission.kind}`,
      );
    }
    return admission?.outcome;
  };

  const model = latestModelRequestJournalState(run.events);
  const tools = validateToolOccurrenceJournal(run.events);
  const openTools = [...tools.values()].filter(
    (entry) => entry.intent !== undefined && entry.result === undefined,
  );
  if (
    (model.status === "unresolved" &&
      admissionFor("model", model.request.request.requestId) === "admitted") ||
    openTools.some(
      (entry) =>
        admissionFor("tool", entry.occurrence.occurrenceId) === "admitted",
    )
  ) {
    return { kind: "reconcile" };
  }

  const session = new Session(run.sessionId, () => {}, latest);
  if (model.status === "unresolved") {
    session.append({
      type: "model/effect-not-started",
      turn: model.request.turn,
      step: model.request.step,
      requestId: model.request.request.requestId,
      reason: "Durable Stop fenced provider execution before admission",
    });
  }
  for (const entry of openTools) {
    const intent = entry.intent!;
    session.append({
      type: "tool/result",
      turn: intent.turn,
      step: intent.step,
      occurrenceId: intent.occurrenceId,
      name: intent.name,
      content: "Durable Stop fenced tool execution before admission.",
      isError: true,
      status: "interrupted",
    });
  }
  session.reconcileInterrupted();
  return {
    kind: "cancel",
    events: [...session.events.slice(run.previousEventCount)],
  };
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

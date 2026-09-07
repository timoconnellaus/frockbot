// Kernel run-recovery planning, bound to the Shell Package's run codec.
import {
  Session,
  type SessionEvent,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import {
  planBotRunRecovery as planKernelBotRunRecovery,
  type BotRunRecoveryPlan,
} from "@frockbot/kernel-do";
import {
  requireStoredRunV1,
  storedRunCodecV1,
  type StoredRun,
} from "./backend-contracts.js";

export {
  eventsForFailedRun,
  latestModelRequestJournalState,
  type BotRunRecoveryPlan,
  type ModelRequestJournalState,
} from "@frockbot/kernel-do";

/**
 * Everything a fenced run — one a durable Stop or a later user message
 * interrupted — must append to settle the effects it left open.
 *
 * Nothing is investigated. A model request with no answer is simply left
 * unanswered, and every open tool occurrence is closed as `interrupted`; the
 * effects are keyed, and the admission record is what stops a fenced Turn from
 * starting another one.
 */
export function interruptedRunSettlementV1(
  run: StoredRun,
  latest: readonly SessionEvent[],
): SessionEvent[] {
  requireStoredRunV1(run);
  if (!run.stopRequestedAt && !run.supersededAt) {
    throw new Error(
      `run "${run.runId}" has no durable stop or supersede intent`,
    );
  }
  const fenceReason = run.stopRequestedAt ? "Durable Stop" : "A supersede";
  const session = new Session(run.sessionId, latest);
  for (const entry of validateToolOccurrenceJournal(run.events).values()) {
    if (!entry.intent || entry.result) continue;
    const intent = entry.intent;
    session.append({
      type: "tool/result",
      turn: intent.turn,
      step: intent.step,
      occurrenceId: intent.occurrenceId,
      name: intent.name,
      content: `${fenceReason} fenced tool execution.`,
      isError: true,
      status: "interrupted",
    });
  }
  session.reconcileInterrupted();
  return [...session.events.slice(run.previousEventCount)];
}

export function planBotRunRecovery(
  run: StoredRun,
  latest: readonly SessionEvent[],
): BotRunRecoveryPlan {
  return planKernelBotRunRecovery(run, latest, storedRunCodecV1);
}

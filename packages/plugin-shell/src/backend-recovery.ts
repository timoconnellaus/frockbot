// Kernel run-recovery planning, bound to the Shell Package's run codec.
import {
  Session,
  type SessionEvent,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import {
  latestModelRequestJournalState,
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

/** How a stopped run's unresolved effects settle. */
export type StoppedRunRecoveryPlan =
  { kind: "cancel"; events: SessionEvent[] } | { kind: "reconcile" };

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
  return planKernelBotRunRecovery(run, latest, storedRunCodecV1);
}

import {
  LlmEffectNotStartedError,
  type NormalizedModelRequest,
  type SessionEvent,
  type StepOutcome,
  StructuredOutputValidationError,
  turnEndReason,
} from "@frockbot/kernel-contracts";
import { reconcileModelV1 } from "./reconcile.js";
import type { LoopRuntime, ModelResponse, TurnSettlement } from "./runtime.js";

type AssistantMessageEvent = Extract<
  SessionEvent,
  { type: "assistant/message" }
>;
type EffectNotStartedEvent = Extract<
  SessionEvent,
  { type: "model/effect-not-started" }
>;
type ResponseFailedEvent = Extract<
  SessionEvent,
  { type: "model/response-failed" }
>;

/** Where a session that stopped mid-Turn has to pick up. */
export interface ResumptionPlanV1 {
  /** The Turn with no `turn/end`, or undefined when nothing is resumable. */
  openTurn: number | undefined;
  latestStep: number;
  latestStepStatus: "none" | "open" | "ended";
  latestStepOutcome: StepOutcome | undefined;
  latestAssistant: AssistantMessageEvent | undefined;
  /** A `model/request` with no durable outcome of its own. */
  unresolvedRequest: NormalizedModelRequest | undefined;
  definitiveNoEffect: EffectNotStartedEvent | undefined;
  definitiveResponseFailure: ResponseFailedEvent | undefined;
}

/** Replays the durable log; reads nothing else and writes nothing. */
export function planResumptionV1(
  events: readonly SessionEvent[],
): ResumptionPlanV1 {
  let openTurn: number | undefined;
  let latestStep = 0;
  let latestStepStatus: "none" | "open" | "ended" = "none";
  let latestStepOutcome: StepOutcome | undefined;
  let unresolvedRequest: NormalizedModelRequest | undefined;
  let definitiveNoEffect: EffectNotStartedEvent | undefined;
  let definitiveResponseFailure: ResponseFailedEvent | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      openTurn = event.turn;
      latestStep = 0;
      latestStepStatus = "none";
      latestStepOutcome = undefined;
      unresolvedRequest = undefined;
      definitiveNoEffect = undefined;
      definitiveResponseFailure = undefined;
    }
    if (event.type === "turn/end" && event.turn === openTurn)
      openTurn = undefined;
    if (event.type === "step/start" && event.turn === openTurn) {
      latestStep = Math.max(latestStep, event.step);
      latestStepStatus = "open";
      latestStepOutcome = undefined;
    }
    if (
      event.type === "step/end" &&
      event.turn === openTurn &&
      event.step === latestStep
    ) {
      latestStepStatus = "ended";
      latestStepOutcome = event.outcome;
    }
    if (event.type === "model/request" && event.turn === openTurn) {
      unresolvedRequest = event.request;
      definitiveNoEffect = undefined;
      definitiveResponseFailure = undefined;
    }
    if (
      event.type === "model/effect-not-started" &&
      event.requestId === unresolvedRequest?.requestId
    ) {
      definitiveNoEffect = event;
    }
    if (
      event.type === "model/response-failed" &&
      event.requestId === unresolvedRequest?.requestId
    ) {
      definitiveResponseFailure = event;
    }
    if (
      event.type === "assistant/message" &&
      event.requestId === unresolvedRequest?.requestId
    ) {
      unresolvedRequest = undefined;
      definitiveNoEffect = undefined;
    }
  }
  let latestAssistant: AssistantMessageEvent | undefined;
  if (openTurn !== undefined) {
    for (const event of events) {
      if (
        event.type === "assistant/message" &&
        event.turn === openTurn &&
        event.step === latestStep
      ) {
        latestAssistant = event;
      }
    }
  }
  return {
    openTurn,
    latestStep,
    latestStepStatus,
    latestStepOutcome,
    latestAssistant,
    unresolvedRequest,
    definitiveNoEffect,
    definitiveResponseFailure,
  };
}

export type ModelRecoveryV1 =
  | { kind: "recovered"; response: ModelResponse }
  | { kind: "settled"; settlement: TurnSettlement };

/**
 * Decides what became of the model request the interruption left open.
 *
 * A durable no-effect or response failure already answers it; otherwise the
 * provider is asked to retrieve the call, and a retrieval that cannot answer
 * leaves the Turn owing a reconciliation rather than guessing.
 */
export async function recoverModelRequestV1(
  runtime: LoopRuntime,
  plan: ResumptionPlanV1 & { openTurn: number },
  request: NormalizedModelRequest,
  signal: AbortSignal,
): Promise<ModelRecoveryV1> {
  const { session, ctx } = runtime;
  const {
    openTurn,
    latestStep,
    definitiveNoEffect,
    definitiveResponseFailure,
  } = plan;
  if (definitiveResponseFailure) {
    await runtime.notifyModelOutcome(
      definitiveResponseFailure.requestId,
      "completed",
    );
    ctx.emit(
      "agent/error",
      runtime.agent,
      new StructuredOutputValidationError(definitiveResponseFailure.failure),
    );
    return {
      kind: "settled",
      settlement: {
        kind: "settled",
        outcome: "model-error",
        reason: turnEndReason(definitiveResponseFailure.failure.message),
      },
    };
  }
  if (definitiveNoEffect) {
    await runtime.notifyModelOutcome(
      definitiveNoEffect.requestId,
      "not-started",
    );
    ctx.emit(
      "agent/error",
      runtime.agent,
      new LlmEffectNotStartedError(definitiveNoEffect.reason),
    );
    return {
      kind: "settled",
      settlement: {
        kind: "settled",
        outcome: "model-error",
        reason: turnEndReason(definitiveNoEffect.reason),
      },
    };
  }
  const reconciliation = await reconcileModelV1(
    runtime,
    request,
    openTurn,
    latestStep,
    signal,
  );
  if (reconciliation.status === "not-retrievable") {
    // No later attempt can retrieve this effect, so the run settles now.
    // The chunks already journaled stay in the session, so whatever the
    // model produced before the interruption is still shown.
    await runtime.notifyModelOutcome(request.requestId, "not-started");
    ctx.emit("agent/error", runtime.agent, new Error(reconciliation.reason));
    return {
      kind: "settled",
      settlement: {
        kind: "settled",
        outcome: "model-error",
        reason: turnEndReason(reconciliation.reason),
      },
    };
  }
  if (reconciliation.status === "unavailable") {
    const existing = session.events.findLast(
      (event) =>
        event.type === "model/reconciliation-required" &&
        event.requestId === request.requestId,
    );
    if (
      existing?.type !== "model/reconciliation-required" ||
      existing.reason !== reconciliation.reason
    ) {
      session.append({
        type: "model/reconciliation-required",
        turn: openTurn,
        step: latestStep,
        requestId: request.requestId,
        reason: reconciliation.reason,
      });
    }
    return {
      kind: "settled",
      settlement: { kind: "reconciliation-required" },
    };
  }
  return { kind: "recovered", response: reconciliation.response };
}

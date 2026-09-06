import type {
  NormalizedModelRequest,
  SessionEvent,
  StepOutcome,
} from "@frockbot/kernel-contracts";

type AssistantMessageEvent = Extract<
  SessionEvent,
  { type: "assistant/message" }
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
  /**
   * A `model/request` the log carries no answer to. The Turn re-issues it
   * under its own `requestId`, which is the call's idempotency key.
   */
  pendingRequest: NormalizedModelRequest | undefined;
  /** A durable structured-output failure: the call answered, badly. */
  responseFailure: ResponseFailedEvent | undefined;
}

/** Replays the durable log; reads nothing else and writes nothing. */
export function planResumptionV1(
  events: readonly SessionEvent[],
): ResumptionPlanV1 {
  let openTurn: number | undefined;
  let latestStep = 0;
  let latestStepStatus: "none" | "open" | "ended" = "none";
  let latestStepOutcome: StepOutcome | undefined;
  let pendingRequest: NormalizedModelRequest | undefined;
  let responseFailure: ResponseFailedEvent | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      openTurn = event.turn;
      latestStep = 0;
      latestStepStatus = "none";
      latestStepOutcome = undefined;
      pendingRequest = undefined;
      responseFailure = undefined;
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
      pendingRequest = event.request;
      responseFailure = undefined;
    }
    if (
      event.type === "model/response-failed" &&
      event.requestId === pendingRequest?.requestId
    ) {
      responseFailure = event;
    }
    if (
      event.type === "assistant/message" &&
      event.requestId === pendingRequest?.requestId
    ) {
      pendingRequest = undefined;
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
    pendingRequest,
    responseFailure,
  };
}

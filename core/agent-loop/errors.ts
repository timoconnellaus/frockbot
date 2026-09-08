/**
 * What a person is told when a reply used every step it was allowed. Bob
 * (2026-09-04) ran a to-do applet build to the 64-step ceiling and the thread
 * showed the generic "stopped before it finished" under a spinner that never
 * ended; this names what happened and what to do, and stays true whatever
 * the ceiling is.
 */
export const STEP_LIMIT_REASON_V1 =
  "This Bot used all the steps it had for one reply and stopped. What it finished is saved. Send another message to carry on.";

/** What a `turn/end` records when the Turn ran out of wall clock. */
export const TURN_DEADLINE_REASON_V1 =
  "This Turn ran for 15 minutes without finishing and was stopped. Try sending it again.";

/** Legacy ceiling for unknown failures: the first attempt plus one retry. */
export const MODEL_REQUEST_ATTEMPTS_V1 = 2;

/**
 * The Turn used every step it was allowed.
 *
 * Not a model error: nothing failed, and everything the Turn did in those
 * steps is durable. It is reported as what it is — a Turn that stopped after
 * so many steps — so the person is told the Bot ran out of room rather than
 * that their model broke.
 */
export class StepLimitReachedError extends Error {
  constructor(readonly steps: number) {
    // The sentence is written for the person, the way the Turn deadline's is:
    // it is what reaches the chat bubble once `core/durable` wraps it into the
    // run's failure. The step count stays on the error for the log.
    super(STEP_LIMIT_REASON_V1);
    this.name = "StepLimitReachedError";
  }
}

/** Durable Stop won the final effect-admission transaction. */
export class EffectAdmissionFencedError extends Error {
  constructor(readonly effectId: string) {
    super(`Effect "${effectId}" was fenced by durable Stop`);
    this.name = "EffectAdmissionFencedError";
  }
}

export class ModelOutcomeSettlementRequiredError extends Error {
  constructor(readonly cause: unknown) {
    super("Durable model outcome settlement is pending");
    this.name = "ModelOutcomeSettlementRequiredError";
  }
}

export function modelFailureMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Model provider response was lost";
}

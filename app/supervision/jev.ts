import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  type Fetch,
} from "@typesafe-ai/sdk";
import {
  createUnavailableTurnSupervisorV1,
  SupervisionUnavailableError,
  type TurnSupervisor,
} from "@frockbot/core/contracts";
import {
  composeSendDecisionV1,
  composeStepDecisionV1,
  relayEvidenceV1,
  relayJudgmentsV1,
  relayRewroteV1,
  responseReviewEvidenceV1,
  reviewRelayV1,
  reviewResponseV1,
  reviewSendV1,
  sendReviewEvidenceV1,
  sendVetoV1,
  RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
  RESPONSE_REVIEW_MODEL_V1,
  RESPONSE_REVIEW_RETRY_V1,
  type JevCallBudgetV1,
} from "./response-review.js";
import {
  composeQuestionRouteV1,
  reviewQuestionRouteV1,
} from "./question-route.js";
import {
  callReviewEvidenceV1,
  composeCallDecisionV1,
  reviewCallV1,
} from "./call-review.js";
import {
  composeTurnDirectiveV1,
  reviewTurnStartV1,
  turnStartJudgmentEvidenceV1,
} from "./turn-start.js";

export const JEV_SUPERVISION_ADAPTER_ID_V1 = "jev";

/**
 * How a Turn's Jev call runs: one retry, then the Turn fails. An answer
 * usually lands in under 200 ms, so an attempt that takes seconds is a fault,
 * not a slow judgment.
 */
export const JEV_TURN_BUDGET_V1: JevCallBudgetV1 = {
  retry: { maxRetries: 1 },
  timeout: 10_000,
};

export interface JevTurnSupervisorOptionsV1 {
  readonly client: TypeSafeClient;
  /** Defaults to {@link JEV_TURN_BUDGET_V1}. */
  readonly budget?: JevCallBudgetV1;
}

function classifyJevFailure(error: unknown): SupervisionUnavailableError {
  if (error instanceof SupervisionUnavailableError) return error;
  if (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
  if (
    error instanceof APITimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  ) {
    return new SupervisionUnavailableError(
      "timeout",
      "Jev timed out before a supervision decision landed.",
    );
  }
  if (error instanceof APIError || error instanceof TypeSafeError) {
    const timeout =
      error instanceof APIError &&
      (error.status === 408 || error.status === 504);
    return new SupervisionUnavailableError(
      timeout ? "timeout" : "unavailable",
      error.message,
    );
  }
  return new SupervisionUnavailableError(
    "unavailable",
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The hosted supervision adapter: one Jev call before a Turn's first model
 * call, one per model response that calls tools, one per text send that
 * code's vetoes leave open to judgment, and one per `mutate` call.
 */
export function createJevTurnSupervisorV1(
  options: JevTurnSupervisorOptionsV1,
): TurnSupervisor {
  const budget = options.budget ?? JEV_TURN_BUDGET_V1;
  return {
    async startTurn(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewTurnStartV1(
          options.client,
          turnStartJudgmentEvidenceV1(evidence),
          { signal, budget },
        );
        return composeTurnDirectiveV1(
          review.answers,
          evidence.input.origin,
          review.model,
        );
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async reviewStep(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewResponseV1(
          options.client,
          responseReviewEvidenceV1(evidence),
          { signal, budget },
        );
        return composeStepDecisionV1({
          answers: review.answers,
          calls: evidence.calls,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async reviewSend(evidence, signal) {
      signal?.throwIfAborted();
      try {
        // Work a subagent produced is judged first, and whatever the vetoes
        // say: a long message or a question can still be a rewrite of it.
        if (evidence.work.length > 0) {
          const relay = await reviewRelayV1(
            options.client,
            relayEvidenceV1(evidence),
            { signal, budget },
          );
          if (relayRewroteV1(relay.answers)) {
            return {
              send: "withhold",
              reason: "paraphrased_work",
              judgments: relayJudgmentsV1(relay.answers),
              model: relay.model,
            };
          }
        }
        if (sendVetoV1(evidence) !== undefined) {
          return { send: "release", judgments: [] };
        }
        const review = await reviewSendV1(
          options.client,
          sendReviewEvidenceV1(evidence),
          { signal, budget },
        );
        return composeSendDecisionV1({
          answers: review.answers,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async routeQuestion(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewQuestionRouteV1(options.client, evidence, {
          signal,
          budget,
        });
        return composeQuestionRouteV1({
          answers: review.answers,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async reviewCall(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewCallV1(
          options.client,
          callReviewEvidenceV1(evidence),
          { signal, budget },
        );
        return composeCallDecisionV1({
          answers: review.answers,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
  };
}

export function createJevClientV1(input: {
  apiKey: string;
  fetch?: Fetch;
  /** A stand-in for Jev; only a test harness names one. */
  baseURL?: string;
}): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: input.apiKey,
    defaultModel: RESPONSE_REVIEW_MODEL_V1,
    retry: RESPONSE_REVIEW_RETRY_V1,
    timeout: RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
    logLevel: "off",
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
  });
}

/**
 * The one reader of the deployment's Jev settings, for every hosted judge:
 * a client when `JEV_API_KEY` is present, otherwise nothing. The key never
 * leaves this function.
 */
export function hostedJevClientV1(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): TypeSafeClient | undefined {
  const apiKey = (env.JEV_API_KEY ?? "").trim();
  if (!apiKey) return undefined;
  const baseURL = (env.JEV_BASE_URL ?? "").trim();
  return createJevClientV1({
    apiKey,
    fetch,
    ...(baseURL ? { baseURL } : {}),
  });
}

/**
 * The production chooser: a Jev adapter when `JEV_API_KEY` is present,
 * otherwise the hard-unavailable adapter, under which no Turn runs.
 */
export function createHostedTurnSupervisorV1(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): TurnSupervisor {
  const client = hostedJevClientV1(env, fetch);
  if (!client) {
    return createUnavailableTurnSupervisorV1(
      "Turn supervision is unavailable: no JEV_API_KEY is configured.",
    );
  }
  return createJevTurnSupervisorV1({ client });
}

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
  composeStepDecisionV1,
  responseReviewEvidenceV1,
  reviewResponseV1,
  RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
  RESPONSE_REVIEW_MODEL_V1,
  RESPONSE_REVIEW_RETRY_V1,
} from "./response-review.js";
import {
  composeTurnDirectiveV1,
  reviewTurnStartV1,
  turnStartJudgmentEvidenceV1,
} from "./turn-start.js";

export const JEV_SUPERVISION_ADAPTER_ID_V1 = "jev";

export interface JevTurnSupervisorOptionsV1 {
  readonly client: TypeSafeClient;
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
 * call, and one per model response that calls tools. The response call judges
 * the whole response — its words and its calls together — so a response
 * never costs a second round trip. Per-call mutation approval
 * (`app/evals/tool-approval.ts`) is not asked yet: it needs the host's
 * read/mutate catalog first.
 */
export function createJevTurnSupervisorV1(
  options: JevTurnSupervisorOptionsV1,
): TurnSupervisor {
  return {
    async startTurn(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewTurnStartV1(
          options.client,
          turnStartJudgmentEvidenceV1(evidence),
          { signal },
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
      const judged = responseReviewEvidenceV1(evidence);
      try {
        const review = await reviewResponseV1(options.client, judged, {
          signal,
        });
        return composeStepDecisionV1({
          answers: review.answers,
          evidence: judged,
          calls: evidence.calls,
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

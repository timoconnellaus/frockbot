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
  workShownV1,
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
  callReviewPersonAskedV1,
  composeCallDecisionV1,
  reviewCallV1,
} from "./call-review.js";
import {
  claimEvidenceV1,
  claimJudgmentsV1,
  claimUnsupportedV1,
  factsUnsupportedV1,
  reviewClaimV1,
} from "./claim-check.js";
import { composeFetchDecisionV1, reviewFetchV1 } from "./fetch-review.js";
import { composeProgressDecisionV1, reviewProgressV1 } from "./loop-health.js";
import { composeOutcomeDecisionV1, reviewOutcomeV1 } from "./outcome.js";
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

/**
 * How the outcome judgment runs: one short attempt. The person already has
 * the reply and nothing acts on the judgment, so a slow Jev leaves it out
 * rather than holding the Turn open.
 */
export const JEV_OUTCOME_BUDGET_V1: JevCallBudgetV1 = {
  retry: { maxRetries: 0 },
  timeout: 2_000,
};

export interface JevTurnSupervisorOptionsV1 {
  readonly client: TypeSafeClient;
  /** The product the rubric names, as the brand spells it. */
  readonly productName: string;
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
 * call, one per model response that calls tools, up to two per text send
 * (what it claims, and whether it is needed when code's vetoes leave that
 * open), one per `mutate` call, and one every few steps of a long Turn.
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
          { productName: options.productName, signal, budget },
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
        if (
          !evidence.handoff &&
          evidence.work.length > 0 &&
          !workShownV1(evidence)
        ) {
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
        // What it says was done is checked whatever the vetoes say: a long
        // message is where a claim hides. Both questions go out at once.
        const [claim, review] = await Promise.all([
          evidence.checkClaim && evidence.message.trim()
            ? reviewClaimV1(options.client, claimEvidenceV1(evidence), {
                signal,
                budget,
              })
            : undefined,
          !evidence.handoff && sendVetoV1(evidence) === undefined
            ? reviewSendV1(options.client, sendReviewEvidenceV1(evidence), {
                signal,
                budget,
              })
            : undefined,
        ]);
        if (claim && claimUnsupportedV1(claim.answers)) {
          return {
            send: "withhold",
            reason: "unsupported_claim",
            judgments: claimJudgmentsV1(claim.answers),
            model: claim.model,
          };
        }
        if (claim && factsUnsupportedV1(claim.answers)) {
          return {
            send: "withhold",
            reason: "unsupported_fact",
            judgments: claimJudgmentsV1(claim.answers),
            model: claim.model,
          };
        }
        const claimed = claim ? claimJudgmentsV1(claim.answers) : [];
        if (!review) {
          return {
            send: "release",
            judgments: claimed,
            ...(claim ? { model: claim.model } : {}),
          };
        }
        const decision = composeSendDecisionV1({
          answers: review.answers,
          model: review.model,
        });
        return { ...decision, judgments: [...decision.judgments, ...claimed] };
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
    async reviewOutcome(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewOutcomeV1(options.client, evidence, {
          signal,
          budget: JEV_OUTCOME_BUDGET_V1,
        });
        return composeOutcomeDecisionV1({
          answers: review.answers,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async reviewProgress(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewProgressV1(options.client, evidence, {
          signal,
          budget,
        });
        return composeProgressDecisionV1({
          answers: review.answers,
          signals: evidence.signals,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async reviewCall(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const judged = callReviewEvidenceV1(evidence);
        const review = await reviewCallV1(options.client, judged, {
          signal,
          budget,
        });
        return composeCallDecisionV1({
          answers: review.answers,
          personAsked: callReviewPersonAskedV1(judged.conversation),
          tool: evidence.call.tool,
          model: review.model,
        });
      } catch (error) {
        throw classifyJevFailure(error);
      }
    },
    async reviewFetch(evidence, signal) {
      signal?.throwIfAborted();
      try {
        const review = await reviewFetchV1(
          options.client,
          callReviewEvidenceV1(evidence),
          { signal, budget },
        );
        return composeFetchDecisionV1({
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

/** Jev's model id on Workers AI. */
export const WORKERS_AI_JEV_MODEL_V1 = "typesafe/jev";

/**
 * The transport a Workers AI answer names in its recorded model, as
 * `workers-ai:<version>`, so a decision records the adapter that resolved it
 * beside the Jev version that answered.
 */
export const WORKERS_AI_JEV_TRANSPORT_V1 = "workers-ai";

/** The slice of the `AI` binding Jev needs. */
export interface JevAiBindingV1 {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

function isJevAiBinding(value: unknown): value is JevAiBindingV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The HTTP status of each Workers AI error code a Jev call can meet, from
 * Cloudflare's error table, plus `5006`, its input validation failure. A
 * binding throws these as `<code>: <message>`; as statuses, a refusal stays a
 * refusal (nothing was spent), and capacity or a timeout is retried by the
 * client's own rules.
 */
const WORKERS_AI_ERROR_STATUS_V1: Readonly<Record<string, number>> = {
  "3003": 400,
  "3006": 413,
  "3007": 408,
  "3008": 408,
  "3023": 403,
  "3036": 429,
  "3040": 429,
  "3041": 403,
  "3042": 404,
  "5006": 400,
  "5007": 400,
  "5018": 403,
  "5035": 403,
};

function workersAiErrorResponse(error: unknown): Response | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code = /\b(\d{4}):/.exec(message)?.[1];
  const status = code ? WORKERS_AI_ERROR_STATUS_V1[code] : undefined;
  return status === undefined
    ? undefined
    : Response.json({ error: { message } }, { status });
}

/**
 * Jev over the `AI` binding, shaped as the `fetch` the TypeSafe client calls,
 * so every judge keeps the client's timeouts, retries and error classes. The
 * body loses `model`: Workers AI serves one Jev version and refuses the field,
 * so the version that answered is recorded rather than requested. A binding
 * error without a known code reaches the client as a connection error:
 * whether it was spent is unknown, and the call's budget retries it.
 */
export function workersAiJevFetchV1(ai: JevAiBindingV1): Fetch {
  return async (url, init) => {
    if (init?.method !== "POST" || !url.endsWith("/v1/systemone")) {
      return Response.json(
        { error: { message: "Workers AI serves Jev's systemone only" } },
        { status: 404 },
      );
    }
    const body: unknown = JSON.parse(String(init.body ?? "null"));
    if (!isRecord(body)) throw new TypeError("A Jev request has no body.");
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    // Raced as well as passed: a binding that ignores the signal must not
    // hold an attempt past the client's timeout.
    const aborted = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    let answer: unknown;
    try {
      answer = await Promise.race([
        ai.run(
          WORKERS_AI_JEV_MODEL_V1,
          { state: body.state ?? null, questions: body.questions },
          signal ? { signal } : {},
        ),
        aborted,
      ]);
    } catch (error) {
      if (signal?.aborted) throw error;
      const refused = workersAiErrorResponse(error);
      if (refused) return refused;
      throw error;
    }
    if (
      !isRecord(answer) ||
      !isRecord(answer.answers) ||
      typeof answer.model !== "string"
    ) {
      throw new TypeError("Workers AI answered Jev in an unexpected shape.");
    }
    return Response.json({
      ...answer,
      model: `${WORKERS_AI_JEV_TRANSPORT_V1}:${answer.model}`,
    });
  };
}

/** A Jev client over the `AI` binding: billed to the account, no key. */
export function createWorkersAiJevClientV1(ai: JevAiBindingV1): TypeSafeClient {
  return createJevClientV1({
    // The client refuses to construct without one; nothing sends it.
    apiKey: WORKERS_AI_JEV_TRANSPORT_V1,
    fetch: workersAiJevFetchV1(ai),
  });
}

/** What the deployment's Jev is read from. */
export interface HostedJevEnvV1 {
  /** The Workers AI binding Jev runs on. */
  readonly AI?: unknown;
  /** A stand-in for Jev's HTTP API; only a test harness names one. */
  readonly JEV_BASE_URL?: string;
}

/**
 * The one reader of the deployment's Jev, for every hosted judge: Workers AI
 * through the `AI` binding, otherwise nothing. A test harness may point Jev at
 * an HTTP stand-in instead, which it scripts by intercepting `fetch`.
 */
export function hostedJevClientV1(
  env: HostedJevEnvV1,
  fetch?: Fetch,
): TypeSafeClient | undefined {
  const baseURL = (env.JEV_BASE_URL ?? "").trim();
  if (baseURL) {
    return createJevClientV1({ apiKey: "stand-in", fetch, baseURL });
  }
  return isJevAiBinding(env.AI)
    ? createWorkersAiJevClientV1(env.AI)
    : undefined;
}

/**
 * The production chooser: a Jev adapter when the `AI` binding is present,
 * otherwise the hard-unavailable adapter, under which no Turn runs.
 */
export function createHostedTurnSupervisorV1(
  env: HostedJevEnvV1,
  productName: string,
  fetch?: Fetch,
): TurnSupervisor {
  const client = hostedJevClientV1(env, fetch);
  if (!client) {
    return createUnavailableTurnSupervisorV1(
      "Turn supervision is unavailable: no Workers AI binding is configured.",
    );
  }
  return createJevTurnSupervisorV1({ client, productName });
}

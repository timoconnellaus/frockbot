import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeError,
  type Fetch,
} from "@typesafe-ai/sdk";
import {
  createUnavailableRoutineEventJudgeV1,
  type RoutineEventJudgeV1,
  type RoutineEventVerdictV1,
} from "@frockbot/core/contracts";
import {
  reviewRoutineEventV1,
  routineEventVerdictOfV1,
} from "../evals/routine-event.js";
import { hostedJevClientV1, type createJevClientV1 } from "./jev.js";

/**
 * The hosted rejector. Service failure and timeout are `is_or_might_be`:
 * a miss is a Turn, not a drop. Abort still aborts.
 */
export function createJevRoutineEventJudgeV1(options: {
  readonly client: ReturnType<typeof createJevClientV1>;
}): RoutineEventJudgeV1 {
  return {
    async classify(evidence, signal) {
      try {
        const review = await reviewRoutineEventV1(options.client, evidence, {
          signal,
        });
        return routineEventVerdictOfV1(review.answers);
      } catch (error) {
        return classifyRoutineEventFailureV1(error);
      }
    },
  };
}

function classifyRoutineEventFailureV1(error: unknown): RoutineEventVerdictV1 {
  if (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
  if (
    error instanceof APITimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError") ||
    error instanceof APIError ||
    error instanceof TypeSafeError
  ) {
    return "is_or_might_be";
  }
  return "is_or_might_be";
}

/**
 * The production chooser: a Jev adapter when `JEV_API_KEY` is present,
 * otherwise the hard-unavailable adapter that never drops.
 */
export function createHostedRoutineEventJudgeV1(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): RoutineEventJudgeV1 {
  const client = hostedJevClientV1(env, fetch);
  if (!client) return createUnavailableRoutineEventJudgeV1();
  return createJevRoutineEventJudgeV1({ client });
}

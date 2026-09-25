import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeError,
  type Fetch,
} from "@typesafe-ai/sdk";
import {
  dictationCleanupVerdictOfV1,
  reviewDictationCleanupV1,
  type DictationCleanupEvidenceV1,
  type DictationCleanupVerdictV1,
} from "../evals/dictation-cleanup.js";
import { hostedJevClientV1, type createJevClientV1 } from "./jev.js";

/**
 * Did Groq's tidy still say what the person said?
 *
 * This is not Turn supervision. Dictation admits nothing durable — the
 * transcript lands in an editable draft — and Jev here is a rejector, the
 * same shape as the routine-event judge. Only `faithful` may replace the
 * raw text. Service failure, timeout and a missing key are `unfaithful`:
 * untidy words they said beat tidy words we are not sure about.
 */
export type DictationCleanupJudgeVerdictV1 =
  DictationCleanupVerdictV1 | "unavailable";

export interface DictationCleanupJudgeV1 {
  review(
    evidence: DictationCleanupEvidenceV1,
    signal?: AbortSignal,
  ): Promise<DictationCleanupJudgeVerdictV1>;
}

export function createJevDictationCleanupJudgeV1(options: {
  readonly client: ReturnType<typeof createJevClientV1>;
}): DictationCleanupJudgeV1 {
  return {
    async review(evidence, signal) {
      try {
        const review = await reviewDictationCleanupV1(
          options.client,
          evidence,
          {
            signal,
          },
        );
        return dictationCleanupVerdictOfV1(review.answers);
      } catch (error) {
        return classifyDictationCleanupFailureV1(error);
      }
    },
  };
}

function classifyDictationCleanupFailureV1(
  error: unknown,
): DictationCleanupJudgeVerdictV1 {
  if (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "unavailable";
  }
  if (
    error instanceof APITimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError") ||
    error instanceof APIError ||
    error instanceof TypeSafeError
  ) {
    return "unavailable";
  }
  return "unavailable";
}

/**
 * The production chooser: a Jev adapter when `JEV_API_KEY` is present,
 * otherwise the hard-unavailable adapter that never accepts a tidy.
 */
export function createHostedDictationCleanupJudgeV1(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): DictationCleanupJudgeV1 {
  const client = hostedJevClientV1(env, fetch);
  if (!client) return createUnavailableDictationCleanupJudgeV1();
  return createJevDictationCleanupJudgeV1({ client });
}

export function createUnavailableDictationCleanupJudgeV1(): DictationCleanupJudgeV1 {
  return {
    async review(_evidence, signal) {
      signal?.throwIfAborted();
      return "unavailable";
    },
  };
}

export function createFakeDictationCleanupJudgeV1(options?: {
  review?: DictationCleanupJudgeV1["review"];
  verdict?: DictationCleanupJudgeVerdictV1;
}): DictationCleanupJudgeV1 {
  return {
    async review(evidence, signal) {
      signal?.throwIfAborted();
      if (options?.review) return options.review(evidence, signal);
      return options?.verdict ?? "faithful";
    },
  };
}

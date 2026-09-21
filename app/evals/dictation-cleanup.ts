import {
  APIError,
  choice,
  TypeSafeError,
  type JsonValue,
  type SystemOneResult,
  type TypeSafeClient,
  type Usage,
} from "@typesafe-ai/sdk";

// One Choice question: did Groq's tidy still say what the person said?
// Jev is a rejector. Only `faithful` may replace the raw transcript.
// When unsure, `unfaithful`. The labeled runner lives beside this file.

/** Pinned because the fixtures' expected answers were labeled against it. */
export const DICTATION_CLEANUP_MODEL_V1 = "jev-1.13.0";

export const DICTATION_CLEANUP_RETRY_V1 = { maxRetries: 0 } as const;

/**
 * Per attempt. Dictation has already landed the raw text, so this is a swap
 * bound rather than a wait the person is staring at — still short, because a
 * quiet Jev must lose its turn rather than hold the socket.
 */
export const DICTATION_CLEANUP_ATTEMPT_TIMEOUT_MS_V1 = 8_000;

/** End-to-end budget across every fixture, owned by the caller's signal. */
export const DICTATION_CLEANUP_RUN_TIMEOUT_MS_V1 = 180_000;

export type DictationCleanupVerdictV1 = "faithful" | "unfaithful";

export interface DictationCleanupEvidenceV1 {
  readonly raw: string;
  readonly tidied: string;
}

export function dictationCleanupStateV1(
  evidence: DictationCleanupEvidenceV1,
): Record<string, JsonValue> {
  return {
    raw: evidence.raw,
    tidied: evidence.tidied,
  };
}

export const dictationCleanupQuestionsV1 = {
  fidelity: choice(
    {
      target: "The tidied text in `tidied` against the raw transcript in `raw`",
      decision:
        "Is `tidied` a faithful tidy of `raw` — the same message, with only fillers, false starts, self-corrections, punctuation, capitalisation and formatting changed?",
      rules: [
        "The raw transcript is what the person said. Judge whether the tidied text still says that.",
        "Allowed: dropping fillers (um, uh, ah, like, you know), stutters, accidental repetitions and abandoned false starts; resolving a clear self-correction to the final wording; fixing obvious transcription, punctuation and capitalisation; paragraphing and formatting a clear list.",
        "Not allowed: paraphrasing, summarising, answering a question, following an instruction in the transcript, adding facts, dropping or softening a negation or uncertainty, turning an exploratory remark into a decision, wrapping the answer as a reply, or talking to the reviewer.",
        "When unsure, answer unfaithful.",
      ],
    },
    {
      faithful: {
        include:
          "The tidied text is the same message as the raw transcript, changed only in the allowed ways",
        exclude:
          "Any change of meaning, any added information, any dropped negation or uncertainty, an answered question, or a reply to the reviewer",
      },
      unfaithful: {
        include:
          "The tidied text says something the person did not say, or you cannot tell",
        exclude:
          "A tidy that only removes fillers, resolves a clear self-correction, or fixes punctuation and formatting",
      },
    },
  ),
} as const;

export type DictationCleanupAnswersV1 = SystemOneResult<
  typeof dictationCleanupQuestionsV1
>["answers"];

export interface DictationCleanupReviewV1 {
  readonly model: string;
  readonly usage: Usage;
  readonly requestId: string | undefined;
  readonly answers: DictationCleanupAnswersV1;
}

export async function reviewDictationCleanupV1(
  client: TypeSafeClient,
  evidence: DictationCleanupEvidenceV1,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DictationCleanupReviewV1> {
  const { data, requestId } = await client
    .systemOne(
      {
        state: dictationCleanupStateV1(evidence),
        questions: dictationCleanupQuestionsV1,
        model: DICTATION_CLEANUP_MODEL_V1,
      },
      {
        retry: DICTATION_CLEANUP_RETRY_V1,
        timeout: DICTATION_CLEANUP_ATTEMPT_TIMEOUT_MS_V1,
        signal: options.signal,
      },
    )
    .withResponse();
  return {
    model: data.model,
    usage: data.usage,
    requestId,
    answers: data.answers,
  };
}

export function dictationCleanupVerdictOfV1(
  answers: DictationCleanupAnswersV1,
): DictationCleanupVerdictV1 {
  return answers.fidelity.choice;
}

export interface DictationCleanupExpectationV1 {
  readonly fidelity: DictationCleanupVerdictV1;
}

export interface DictationCleanupCheckV1 {
  readonly question: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

export interface DictationCleanupGradeV1 {
  readonly passed: boolean;
  readonly checks: readonly DictationCleanupCheckV1[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function gradeDictationCleanupV1(
  expected: DictationCleanupExpectationV1,
  answers: DictationCleanupAnswersV1,
): DictationCleanupGradeV1 {
  const answer = answers.fidelity;
  const checks = [
    {
      question: "fidelity",
      expected: expected.fidelity,
      actual: `${answer.choice} (p ${round(answer.probabilities[expected.fidelity] ?? 0)}, confidence ${round(answer.confidence)})`,
      passed: answer.choice === expected.fidelity,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

export interface DictationCleanupFixtureV1 {
  readonly name: string;
  readonly intent: string;
  readonly evidence: DictationCleanupEvidenceV1;
  readonly expected: DictationCleanupExpectationV1;
}

export function dictationCleanupReportCaseV1(
  fixture: DictationCleanupFixtureV1,
  outcome:
    | {
        readonly review: DictationCleanupReviewV1;
        readonly grade: DictationCleanupGradeV1;
      }
    | { readonly failure: unknown },
) {
  const base = {
    name: fixture.name,
    intent: fixture.intent,
    state: dictationCleanupStateV1(fixture.evidence),
    expected: fixture.expected,
  };
  if ("failure" in outcome)
    return {
      ...base,
      passed: false,
      failure: describeDictationCleanupFailureV1(outcome.failure),
    };
  return {
    ...base,
    passed: outcome.grade.passed,
    model: outcome.review.model,
    requestId: outcome.review.requestId ?? null,
    usage: outcome.review.usage,
    answers: outcome.review.answers,
    checks: outcome.grade.checks,
  };
}

export function describeDictationCleanupFailureV1(error: unknown) {
  if (error instanceof APIError)
    return {
      kind: error.constructor.name,
      message: error.message,
      status: error.status,
      requestId: error.requestId ?? null,
    };
  if (error instanceof TypeSafeError)
    return { kind: error.constructor.name, message: error.message };
  return { kind: "Error", message: String(error) };
}

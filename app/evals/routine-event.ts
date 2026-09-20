import {
  APIError,
  choice,
  TypeSafeError,
  type JsonValue,
  type SystemOneResult,
  type TypeSafeClient,
  type Usage,
} from "@typesafe-ai/sdk";
import type {
  RoutineEventEvidenceV1,
  RoutineEventVerdictV1,
} from "@frockbot/core/contracts";

// One Choice question: is this standalone event clearly not what the
// Routine prompt is for? Jev is a rejector. Only `clearly_unrelated` may
// skip. The labeled runner lives beside this file.

/** Pinned because the fixtures' expected answers were labeled against it. */
export const ROUTINE_EVENT_MODEL_V1 = "jev-1.13.0";

export const ROUTINE_EVENT_RETRY_V1 = { maxRetries: 0 } as const;
export const ROUTINE_EVENT_ATTEMPT_TIMEOUT_MS_V1 = 30_000;
export const ROUTINE_EVENT_RUN_TIMEOUT_MS_V1 = 180_000;

export function routineEventStateV1(
  evidence: RoutineEventEvidenceV1,
): Record<string, JsonValue> {
  return {
    routineName: evidence.routineName,
    prompt: evidence.prompt,
    triggerType: evidence.triggerType,
    payload: { ...evidence.payload },
  };
}

export const routineEventQuestionsV1 = {
  fit: choice(
    {
      target:
        "The standalone event in `payload` against the Routine prompt in `prompt`",
      decision:
        "Is this event clearly not the kind of event the prompt is for?",
      rules: [
        "You see only this one message. You do not have the Gmail thread, later messages, or the FrockBot chat that created the Routine.",
        "Answer clearly_unrelated only when the standalone payload is obviously a different kind of thing than the prompt describes.",
        "Short replies (Yes, Ok, Thanks), Re:/Fwd: subjects, empty-ish bodies, and calendar-style accepts are not a clear miss — the thread may hold the meaning.",
        "When unsure, answer is_or_might_be.",
      ],
    },
    {
      clearly_unrelated: {
        include:
          "The payload is obviously a different kind of event than the prompt describes — a newsletter when the prompt is about shipping confirmations, a lunch invite when it is about invoices",
        exclude:
          "Anything that might be a reply, a forward, a short acknowledgement, or that needs thread context to judge",
      },
      is_or_might_be: {
        include:
          "The payload matches the prompt, might match, or is too thin to rule out",
        exclude: "A clear, standalone miss that needs no thread to see",
      },
    },
  ),
} as const;

export type RoutineEventAnswersV1 = SystemOneResult<
  typeof routineEventQuestionsV1
>["answers"];

export interface RoutineEventReviewV1 {
  readonly model: string;
  readonly usage: Usage;
  readonly requestId: string | undefined;
  readonly answers: RoutineEventAnswersV1;
}

export async function reviewRoutineEventV1(
  client: TypeSafeClient,
  evidence: RoutineEventEvidenceV1,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RoutineEventReviewV1> {
  const { data, requestId } = await client
    .systemOne(
      {
        state: routineEventStateV1(evidence),
        questions: routineEventQuestionsV1,
        model: ROUTINE_EVENT_MODEL_V1,
      },
      {
        retry: ROUTINE_EVENT_RETRY_V1,
        timeout: ROUTINE_EVENT_ATTEMPT_TIMEOUT_MS_V1,
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

export function routineEventVerdictOfV1(
  answers: RoutineEventAnswersV1,
): RoutineEventVerdictV1 {
  return answers.fit.choice;
}

export interface RoutineEventExpectationV1 {
  readonly fit: RoutineEventVerdictV1;
}

export interface RoutineEventCheckV1 {
  readonly question: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

export interface RoutineEventGradeV1 {
  readonly passed: boolean;
  readonly checks: readonly RoutineEventCheckV1[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function gradeRoutineEventV1(
  expected: RoutineEventExpectationV1,
  answers: RoutineEventAnswersV1,
): RoutineEventGradeV1 {
  const answer = answers.fit;
  const checks = [
    {
      question: "fit",
      expected: expected.fit,
      actual: `${answer.choice} (p ${round(answer.probabilities[expected.fit] ?? 0)}, confidence ${round(answer.confidence)})`,
      passed: answer.choice === expected.fit,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

export interface RoutineEventFixtureV1 {
  readonly name: string;
  readonly intent: string;
  readonly evidence: RoutineEventEvidenceV1;
  readonly expected: RoutineEventExpectationV1;
}

export function routineEventReportCaseV1(
  fixture: RoutineEventFixtureV1,
  outcome:
    | {
        readonly review: RoutineEventReviewV1;
        readonly grade: RoutineEventGradeV1;
      }
    | { readonly failure: unknown },
) {
  const base = {
    name: fixture.name,
    intent: fixture.intent,
    state: routineEventStateV1(fixture.evidence),
    expected: fixture.expected,
  };
  if ("failure" in outcome)
    return {
      ...base,
      passed: false,
      failure: describeRoutineEventFailureV1(outcome.failure),
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

export function describeRoutineEventFailureV1(error: unknown) {
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

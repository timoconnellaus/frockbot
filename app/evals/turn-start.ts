import type {
  TurnAmbiguityV1,
  TurnComplexityV1,
} from "@frockbot/core/contracts";
import {
  TURN_START_ACKNOWLEDGE_NO_V1,
  TURN_START_ACKNOWLEDGE_YES_V1,
  turnStartStateV1,
  type TurnStartAnswersV1,
  type TurnStartCapabilityV1,
  type TurnStartJudgmentEvidenceV1,
  type TurnStartObjectiveV1,
  type TurnStartReviewV1,
} from "../supervision/turn-start.js";
import { describeFailureV1 } from "./tool-approval.js";

// Grading for the labeled start-of-Turn suite. The questions and the
// thresholds code decides by live in `app/supervision/turn-start.ts`; this
// file only says whether an answer matched its label. The Node runner beside
// it is never imported by the Worker.

/** Only what a case deliberately exercises; an omitted field is not graded. */
export interface TurnStartExpectationV1 {
  readonly acknowledge?: "yes" | "no";
  readonly complexity?: TurnComplexityV1;
  readonly objective?: TurnStartObjectiveV1;
  readonly ambiguity?: TurnAmbiguityV1;
  readonly capability?: TurnStartCapabilityV1;
  readonly consequenceAtLeast?: number;
  readonly consequenceAtMost?: number;
}

export interface TurnStartFixtureV1 {
  readonly name: string;
  /** What this case is meant to prove, in one line. */
  readonly intent: string;
  readonly evidence: TurnStartJudgmentEvidenceV1;
  readonly expected: TurnStartExpectationV1;
}

export interface TurnStartCheckV1 {
  readonly question: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

export interface TurnStartGradeV1 {
  readonly passed: boolean;
  readonly checks: readonly TurnStartCheckV1[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function gradeChoice(
  question: string,
  expected: string | undefined,
  answer: {
    readonly choice: string;
    readonly confidence: number;
    readonly probabilities: Readonly<Record<string, number>>;
  },
): TurnStartCheckV1[] {
  if (expected === undefined) return [];
  return [
    {
      question,
      expected,
      actual: `${answer.choice} (p ${round(answer.probabilities[expected] ?? 0)}, confidence ${round(answer.confidence)})`,
      passed: answer.choice === expected,
    },
  ];
}

export function gradeTurnStartV1(
  expected: TurnStartExpectationV1,
  answers: TurnStartAnswersV1,
): TurnStartGradeV1 {
  const checks: TurnStartCheckV1[] = [
    ...gradeChoice("complexity", expected.complexity, answers.complexity),
    ...gradeChoice("objective", expected.objective, answers.objective),
    ...gradeChoice("ambiguity", expected.ambiguity, answers.ambiguity),
    ...gradeChoice("capability", expected.capability, answers.capability),
  ];
  if (expected.acknowledge !== undefined) {
    const actual = answers.acknowledge.noul;
    checks.push({
      question: "acknowledge",
      expected:
        expected.acknowledge === "yes"
          ? `noul >= ${TURN_START_ACKNOWLEDGE_YES_V1}`
          : `noul <= ${TURN_START_ACKNOWLEDGE_NO_V1}`,
      actual: `noul ${round(actual)}`,
      passed:
        expected.acknowledge === "yes"
          ? actual >= TURN_START_ACKNOWLEDGE_YES_V1
          : actual <= TURN_START_ACKNOWLEDGE_NO_V1,
    });
  }
  if (
    expected.consequenceAtLeast !== undefined ||
    expected.consequenceAtMost !== undefined
  ) {
    const actual = answers.consequence.score;
    const low = expected.consequenceAtLeast ?? Number.NEGATIVE_INFINITY;
    const high = expected.consequenceAtMost ?? Number.POSITIVE_INFINITY;
    checks.push({
      question: "consequence",
      expected: `score in [${low}, ${high}]`,
      actual: `score ${round(actual)}`,
      passed: actual >= low && actual <= high,
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

/**
 * The saved shape for one case, built only from the case and the parsed
 * answer, so a credential or a request header has no path into a report.
 */
export function turnStartReportCaseV1(
  fixture: TurnStartFixtureV1,
  outcome:
    | {
        readonly review: TurnStartReviewV1;
        readonly grade: TurnStartGradeV1;
      }
    | { readonly failure: unknown },
) {
  const base = {
    name: fixture.name,
    intent: fixture.intent,
    state: turnStartStateV1(fixture.evidence),
    expected: fixture.expected,
  };
  if ("failure" in outcome)
    return {
      ...base,
      passed: false,
      failure: describeFailureV1(outcome.failure),
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

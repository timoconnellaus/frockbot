import {
  composeSendDecisionV1,
  relayRewroteV1,
  relayStateV1,
  type RelayJudgmentEvidenceV1,
  type RelayV1,
  RESPONSE_REVIEW_ALIGNMENT_MIN_V1,
  responseReviewStateV1,
  sendReviewStateV1,
  type ResponseReviewAlignmentV1,
  type ResponseReviewEvidenceV1,
  type ResponseReviewV1,
  type SendReviewJudgmentEvidenceV1,
  type SendReviewMessageKindV1,
  type SendReviewV1,
} from "../supervision/response-review.js";
import { describeFailureV1 } from "./failure.js";

// Grading for the labeled response-review suite. The questions and the
// thresholds code decides by live in `app/supervision/response-review.ts`;
// this file only says whether a decision matched its label. The Node runner
// beside it is never imported by the Worker.

/** One whole response, judged for whether it works on what was asked. */
export interface ResponseAlignmentFixtureV1 {
  readonly kind: "response";
  readonly name: string;
  /** What this case is meant to prove, in one line. */
  readonly intent: string;
  readonly evidence: ResponseReviewEvidenceV1;
  /** The label, and whether code should act on it at the threshold. */
  readonly expected: ResponseReviewAlignmentV1;
}

/** One text send, judged for whether the person would miss it. */
export interface SendFixtureV1 {
  readonly kind: "send";
  readonly name: string;
  readonly intent: string;
  readonly evidence: SendReviewJudgmentEvidenceV1;
  readonly expected: {
    readonly send: "release" | "withhold";
    /** Graded only when a case is about what the message does. */
    readonly messageKind?: SendReviewMessageKindV1;
  };
}

/** One send after a subagent's work: is it the work, as written? */
export interface RelayFixtureV1 {
  readonly kind: "relay";
  readonly name: string;
  readonly intent: string;
  readonly evidence: RelayJudgmentEvidenceV1;
  readonly expected: { readonly send: "release" | "withhold" };
}

export type ResponseReviewFixtureV1 =
  ResponseAlignmentFixtureV1 | SendFixtureV1 | RelayFixtureV1;

export interface ResponseReviewCheckV1 {
  readonly question: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * A response case passes when code would act as labeled: a confident
 * off-task label for an off-task case, and no confident off-task label for an
 * on-task one. An unsure right answer on an off-task case is a miss, because
 * code would not act on it.
 */
export function gradeResponseAlignmentV1(
  fixture: ResponseAlignmentFixtureV1,
  review: ResponseReviewV1,
): ResponseReviewCheckV1[] {
  const answer = review.answers.alignment;
  const sure =
    (answer.probabilities[answer.choice] ?? 0) >=
    RESPONSE_REVIEW_ALIGNMENT_MIN_V1;
  const acted = sure ? answer.choice : "on_task";
  return [
    {
      question: "alignment",
      expected: fixture.expected,
      actual: `${answer.choice} (p ${round(answer.probabilities[answer.choice] ?? 0)}, acts as ${acted})`,
      passed: acted === fixture.expected,
    },
  ];
}

export function gradeRelayV1(
  fixture: RelayFixtureV1,
  review: RelayV1,
): ResponseReviewCheckV1[] {
  const rewrote = relayRewroteV1(review.answers);
  const relay = review.answers.relay;
  return [
    {
      question: "relay",
      expected: fixture.expected.send,
      actual: `${rewrote ? "withhold" : "release"} (wants work ${round(review.answers.wantsTheWork.noul)}, relay ${relay.choice} p ${round(relay.probabilities[relay.choice] ?? 0)})`,
      passed: (rewrote ? "withhold" : "release") === fixture.expected.send,
    },
  ];
}

export function gradeSendV1(
  fixture: SendFixtureV1,
  review: SendReviewV1,
): ResponseReviewCheckV1[] {
  const decision = composeSendDecisionV1({ answers: review.answers });
  const kind = review.answers.messageKind;
  const checks: ResponseReviewCheckV1[] = [
    {
      question: "send",
      expected: fixture.expected.send,
      actual: `${decision.send} (needed ${round(review.answers.messageNeeded.noul)}, kind ${kind.choice} p ${round(kind.probabilities[kind.choice] ?? 0)})`,
      passed: decision.send === fixture.expected.send,
    },
  ];
  if (fixture.expected.messageKind !== undefined) {
    checks.push({
      question: "messageKind",
      expected: fixture.expected.messageKind,
      actual: kind.choice,
      passed: kind.choice === fixture.expected.messageKind,
    });
  }
  return checks;
}

/**
 * The saved shape for one case, built only from the case and the parsed
 * answer, so a credential or a request header has no path into a report.
 */
export function responseReviewReportCaseV1(
  fixture: ResponseReviewFixtureV1,
  outcome:
    | {
        readonly review: ResponseReviewV1 | SendReviewV1 | RelayV1;
        readonly checks: readonly ResponseReviewCheckV1[];
      }
    | { readonly failure: unknown },
) {
  const base = {
    name: fixture.name,
    kind: fixture.kind,
    intent: fixture.intent,
    state:
      fixture.kind === "response"
        ? responseReviewStateV1(fixture.evidence)
        : fixture.kind === "relay"
          ? relayStateV1(fixture.evidence)
          : sendReviewStateV1(fixture.evidence),
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
    passed: outcome.checks.every((check) => check.passed),
    model: outcome.review.model,
    requestId: outcome.review.requestId ?? null,
    usage: outcome.review.usage,
    answers: outcome.review.answers,
    checks: outcome.checks,
  };
}

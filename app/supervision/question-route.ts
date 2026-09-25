import {
  choice,
  type JsonValue,
  type SystemOneResult,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import type {
  QuestionRouteEvidenceV1,
  QuestionRouteV1,
  SupervisionJudgmentV1,
} from "@frockbot/core/contracts";
import {
  RESPONSE_REVIEW_EVAL_BUDGET_V1,
  RESPONSE_REVIEW_MODEL_V1,
  type JevCallBudgetV1,
  type JevReviewV1,
} from "./response-review.js";

// Who answers a subagent's question: the conversation, from what the person
// already said, or the person. Jev judges; `composeQuestionRouteV1` decides.
// Tuning is a change here plus `bun run eval:response-review`.

/**
 * The probability "the conversation answers it" needs before the Bot answers
 * without asking. High on purpose: a wrong answer sends a subagent the wrong
 * way, and asking costs the person one message.
 */
export const QUESTION_ROUTE_CONVERSATION_MIN_V1 = 0.75;

const QUESTION_ROUTE_EVIDENCE_CHARS_V1 = 600;

function clip(text: string): string {
  return text.length <= QUESTION_ROUTE_EVIDENCE_CHARS_V1
    ? text
    : `${text.slice(0, QUESTION_ROUTE_EVIDENCE_CHARS_V1)}…`;
}

export function questionRouteStateV1(
  evidence: QuestionRouteEvidenceV1,
): Record<string, JsonValue> {
  return {
    question: clip(evidence.question),
    conversation: evidence.conversation.map((message) => ({
      speaker: message.speaker,
      text: clip(message.text),
    })),
  };
}

export const questionRouteQuestionsV1 = {
  answeredBy: choice(
    {
      target: "`question`, which a helper working for the Bot has asked",
      decision: "Who can answer it?",
      rules: [
        'Only what a `conversation` message whose `speaker` is "user" says counts as the person having said it.',
        "When more than one fits, pick the one listed first.",
      ],
    },
    {
      person:
        "Only the person can: it asks for a preference, a fact, a choice or a permission they have not given",
      conversation:
        "What the person already said in `conversation` answers it, plainly",
    },
  ),
} as const;

export type QuestionRouteAnswersV1 = SystemOneResult<
  typeof questionRouteQuestionsV1
>["answers"];

export type QuestionRouteReviewV1 = JevReviewV1<QuestionRouteAnswersV1>;

export async function reviewQuestionRouteV1(
  client: TypeSafeClient,
  evidence: QuestionRouteEvidenceV1,
  options: {
    readonly signal?: AbortSignal;
    readonly budget?: JevCallBudgetV1;
  } = {},
): Promise<QuestionRouteReviewV1> {
  const budget = options.budget ?? RESPONSE_REVIEW_EVAL_BUDGET_V1;
  const { data, requestId } = await client
    .systemOne(
      {
        state: questionRouteStateV1(evidence),
        questions: questionRouteQuestionsV1,
        model: RESPONSE_REVIEW_MODEL_V1,
      },
      { retry: budget.retry, timeout: budget.timeout, signal: options.signal },
    )
    .withResponse();
  return {
    model: data.model,
    usage: data.usage,
    requestId,
    answers: data.answers,
  };
}

export function composeQuestionRouteV1(input: {
  readonly answers: QuestionRouteAnswersV1;
  readonly model?: string;
}): QuestionRouteV1 {
  const answer = input.answers.answeredBy;
  const sure =
    (answer.probabilities.conversation ?? 0) >=
    QUESTION_ROUTE_CONVERSATION_MIN_V1;
  const judgments: SupervisionJudgmentV1[] = [
    {
      question: "answeredBy",
      answer: answer.choice,
      value: answer.probabilities[answer.choice] ?? 0,
    },
  ];
  return {
    answerer:
      answer.choice === "conversation" && sure ? "conversation" : "person",
    judgments,
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

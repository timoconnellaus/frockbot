// A stand-in for Jev's HTTP API, for harnesses that run whole Turns.
//
// It answers Turn supervision and nothing else. Every answer is the safe
// reading: a choice picks its first option, which every supervision question
// lists first on purpose; a Noul sits on the fence; a Score is its lowest
// level. So a Turn under this fake is supervised end to end — every call is
// made and recorded — and nothing is withheld or refused. Any other judge is
// refused with a 422, which each of them reads as Jev being unavailable: a
// harness that sets a key for supervision leaves them as they were without one.

import {
  responseReviewQuestionsV1,
  sendReviewQuestionsV1,
} from "./response-review.js";
import { turnStartQuestionsV1 } from "./turn-start.js";

const SUPERVISION_QUESTION_SETS_V1: readonly (readonly string[])[] = [
  Object.keys(turnStartQuestionsV1),
  Object.keys(responseReviewQuestionsV1),
  Object.keys(sendReviewQuestionsV1),
];

/** Whether a body asks exactly one of Turn supervision's question sets. */
export function isSupervisionBodyV1(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.questions)) return false;
  const keys = Object.keys(body.questions).sort().join(",");
  return SUPERVISION_QUESTION_SETS_V1.some(
    (set) => [...set].sort().join(",") === keys,
  );
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Answers one `/v1/systemone` body the way the fake always does. */
export function fakeJevAnswersV1(body: unknown): JsonRecord {
  const questions =
    isRecord(body) && isRecord(body.questions) ? body.questions : {};
  const answers: JsonRecord = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!isRecord(question)) continue;
    if (question.type === "choice" && isRecord(question.criteria)) {
      const labels = Object.keys(question.criteria);
      answers[key] = {
        type: "choice",
        choice: labels[0],
        probabilities: Object.fromEntries(
          labels.map((label, index) => [label, index === 0 ? 1 : 0]),
        ),
        confidence: 1,
      };
    } else if (question.type === "score" && Array.isArray(question.criteria)) {
      const levels = question.criteria.map((_, index) => String(index));
      answers[key] = {
        type: "score",
        score: 0,
        legend: Object.fromEntries(
          question.criteria.map((criterion, index) => [
            String(index),
            typeof criterion === "string"
              ? criterion
              : JSON.stringify(criterion),
          ]),
        ),
        probabilities: Object.fromEntries(
          levels.map((level, index) => [level, index === 0 ? 1 : 0]),
        ),
        confidence: 1,
      };
    } else {
      answers[key] = { type: "noul", noul: 0.5 };
    }
  }
  return {
    model:
      isRecord(body) && typeof body.model === "string" ? body.model : "jev",
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** The path the SDK posts to, under whatever base URL it was given. */
export const FAKE_JEV_PATH_V1 = "/v1/systemone";

/** A `fetch`-shaped Jev, for a harness's outbound stub or a fake Worker. */
export async function fakeJevFetchV1(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== FAKE_JEV_PATH_V1) {
    return Response.json(
      { error: { message: "The Jev fake answers POST /v1/systemone only" } },
      { status: 404 },
    );
  }
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
    return Response.json(
      { error: { message: "Missing API key" } },
      { status: 401 },
    );
  }
  const body: unknown = await request.json();
  if (!isSupervisionBodyV1(body)) {
    return Response.json(
      { error: { message: "The Jev fake answers Turn supervision only" } },
      { status: 422 },
    );
  }
  return Response.json(fakeJevAnswersV1(body));
}

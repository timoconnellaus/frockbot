import { expect, test } from "bun:test";
import {
  relayQuestionsV1,
  responseReviewQuestionsV1,
  sendReviewQuestionsV1,
} from "./response-review.js";
import {
  fakeJevAnswersV1,
  fakeJevFetchV1,
  fakeWorkersAiJevRunV1,
  SUPERVISION_QUESTION_SETS_V1,
} from "./testing.js";
import { hostedJevClientV1 } from "./jev.js";
import { turnStartQuestionsV1 } from "./turn-start.js";
import { outcomeQuestionsV1 } from "./outcome.js";
import { questionRouteQuestionsV1 } from "./question-route.js";
import { callReviewQuestionsV1, composeCallDecisionV1 } from "./call-review.js";
import {
  claimAndFactsQuestionsV1,
  claimQuestionsV1,
  claimUnsupportedV1,
} from "./claim-check.js";
import {
  composeProgressDecisionV1,
  progressQuestionsV1,
} from "./loop-health.js";

test("the fake knows exactly Turn supervision's question sets", () => {
  expect(SUPERVISION_QUESTION_SETS_V1).toEqual([
    Object.keys(turnStartQuestionsV1("FrockBot")),
    Object.keys(responseReviewQuestionsV1),
    Object.keys(sendReviewQuestionsV1),
    Object.keys(relayQuestionsV1),
    Object.keys(claimQuestionsV1),
    Object.keys(claimAndFactsQuestionsV1),
    Object.keys(progressQuestionsV1),
    Object.keys(outcomeQuestionsV1),
    Object.keys(questionRouteQuestionsV1),
    Object.keys(callReviewQuestionsV1),
  ]);
});

test("answers supervision with the safe reading and refuses every other judge", async () => {
  const post = (questions: unknown) =>
    fakeJevFetchV1(
      new Request("http://jev.test/v1/systemone", {
        method: "POST",
        headers: { authorization: "Bearer key" },
        body: JSON.stringify({ model: "jev-1.13.0", state: {}, questions }),
      }),
    );
  const supervised = await post(sendReviewQuestionsV1);
  expect(supervised.status).toBe(200);
  expect(await supervised.json()).toMatchObject({
    answers: {
      messageNeeded: { noul: 0.5 },
      messageKind: { choice: "answer" },
    },
  });
  expect(
    (await post({ fit: { type: "noul", instructions: "x" } })).status,
  ).toBe(422);
  expect(
    fakeJevAnswersV1({ questions: turnStartQuestionsV1("FrockBot") }).answers,
  ).toMatchObject({ capability: { choice: "none" } });
});

test("the fake's call answers let a harness Turn's calls run", () => {
  const { answers } = fakeJevAnswersV1({ questions: callReviewQuestionsV1 });
  expect(
    composeCallDecisionV1({
      answers: answers as Parameters<
        typeof composeCallDecisionV1
      >[0]["answers"],
      personAsked: true,
    }).decision,
  ).toBe("allow");
});

test("a harness Turn's claims are released and its long Turns never stuck", () => {
  const claim = fakeJevAnswersV1({ questions: claimQuestionsV1 });
  expect(claimUnsupportedV1(claim.answers as never)).toBe(false);
  const progress = fakeJevAnswersV1({ questions: progressQuestionsV1 });
  expect(
    composeProgressDecisionV1({
      answers: progress.answers as never,
      signals: ["repeated_call", "repeated_error"],
    }).stuck,
  ).toBe(false);
});

test("as the AI binding, the fake answers supervision through the production transport", async () => {
  const client = hostedJevClientV1({
    AI: {
      run: async (model: string, input: unknown) =>
        fakeWorkersAiJevRunV1(model, input) ?? { image: "" },
    },
  });
  const answer = await client!.systemOne({
    state: {},
    questions: responseReviewQuestionsV1,
  });
  expect(answer.model).toBe("workers-ai:jev-1.13.0");
  expect(answer.answers.alignment.choice).toBe("on_task");
  expect(fakeWorkersAiJevRunV1("@cf/flux", {})).toBeUndefined();
  expect(() =>
    fakeWorkersAiJevRunV1("typesafe/jev", { questions: { other: {} } }),
  ).toThrow("Turn supervision only");
});

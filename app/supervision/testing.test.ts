import { expect, test } from "bun:test";
import {
  responseReviewQuestionsV1,
  sendReviewQuestionsV1,
} from "./response-review.js";
import {
  fakeJevAnswersV1,
  fakeJevFetchV1,
  SUPERVISION_QUESTION_SETS_V1,
} from "./testing.js";
import { turnStartQuestionsV1 } from "./turn-start.js";
import { callReviewQuestionsV1, composeCallDecisionV1 } from "./call-review.js";

test("the fake knows exactly Turn supervision's question sets", () => {
  expect(SUPERVISION_QUESTION_SETS_V1).toEqual([
    Object.keys(turnStartQuestionsV1),
    Object.keys(responseReviewQuestionsV1),
    Object.keys(sendReviewQuestionsV1),
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
    fakeJevAnswersV1({ questions: turnStartQuestionsV1 }).answers,
  ).toMatchObject({ capability: { choice: "none" } });
});

test("the fake's call answers let a harness Turn's calls run", () => {
  const { answers } = fakeJevAnswersV1({ questions: callReviewQuestionsV1 });
  expect(
    composeCallDecisionV1({
      answers: answers as Parameters<
        typeof composeCallDecisionV1
      >[0]["answers"],
    }).decision,
  ).toBe("allow");
});

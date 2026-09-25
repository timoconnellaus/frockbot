import { expect, test } from "bun:test";
import { fakeJevAnswersV1 } from "../supervision/testing.js";
import {
  callReviewQuestionsV1,
  type CallReviewV1,
} from "../supervision/call-review.js";
import { callReviewFixturesV1 } from "./call-review.fixtures.js";
import { gradeCallReviewV1 } from "./call-review.js";

const allowing = fakeJevAnswersV1({ questions: callReviewQuestionsV1 })
  .answers as CallReviewV1["answers"];

function review(answers: CallReviewV1["answers"]): CallReviewV1 {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 1, output_tokens: 0 },
    requestId: undefined,
    answers,
  };
}

test("every case has its own name, and the suite covers both decisions", () => {
  const names = callReviewFixturesV1.map((fixture) => fixture.name);
  expect(new Set(names).size).toBe(names.length);
  const decisions = new Set(
    callReviewFixturesV1.map((fixture) => fixture.expected.decision),
  );
  expect([...decisions].sort()).toEqual(["allow", "reject"]);
});

test("a case grades the decision code would make from the answers", () => {
  const refused = callReviewFixturesV1.find(
    (fixture) => fixture.expected.decision === "reject",
  )!;
  expect(gradeCallReviewV1(refused, review(allowing))[0]?.passed).toBe(false);
  const none = {
    ...allowing,
    authorization: {
      ...allowing.authorization,
      choice: "none",
      probabilities: { ...allowing.authorization.probabilities, none: 1 },
    },
  } as CallReviewV1["answers"];
  expect(gradeCallReviewV1(refused, review(none))[0]?.passed).toBe(true);
});

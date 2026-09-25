import { expect, test } from "bun:test";
import { fakeJevAnswersV1 } from "../supervision/testing.js";
import {
  responseReviewQuestionsV1,
  sendReviewQuestionsV1,
  type ResponseReviewV1,
  type SendReviewV1,
} from "../supervision/response-review.js";
import { responseReviewFixturesV1 } from "./response-review.fixtures.js";
import {
  gradeResponseAlignmentV1,
  gradeSendV1,
  type ResponseAlignmentFixtureV1,
  type SendFixtureV1,
} from "./response-review.js";

function review<Answers>(answers: Answers) {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 1, output_tokens: 0 },
    requestId: undefined,
    answers,
  };
}

const safeSend = fakeJevAnswersV1({ questions: sendReviewQuestionsV1 })
  .answers as SendReviewV1["answers"];
const safeResponse = fakeJevAnswersV1({
  questions: responseReviewQuestionsV1,
}).answers as ResponseReviewV1["answers"];

const sendCase = responseReviewFixturesV1.find(
  (fixture): fixture is SendFixtureV1 =>
    fixture.kind === "send" && fixture.expected.send === "withhold",
)!;
const offTaskCase = responseReviewFixturesV1.find(
  (fixture): fixture is ResponseAlignmentFixtureV1 =>
    fixture.kind === "response" && fixture.expected === "wrong_objective",
)!;

test("every case has its own name, and every send case follows something shown", () => {
  const names = responseReviewFixturesV1.map((fixture) => fixture.name);
  expect(new Set(names).size).toBe(names.length);
  for (const fixture of responseReviewFixturesV1)
    if (fixture.kind === "send")
      expect(fixture.evidence.shownThisTurn.length).toBeGreaterThan(0);
});

test("a send case grades the decision code would make, not the raw answer", () => {
  const [check] = gradeSendV1(sendCase, review(safeSend));
  expect(check).toMatchObject({
    question: "send",
    expected: "withhold",
    passed: false,
  });
  const [withheld] = gradeSendV1(
    sendCase,
    review({
      ...safeSend,
      messageNeeded: { type: "noul", noul: 0.05 },
      messageKind: {
        ...safeSend.messageKind,
        choice: "restates_shown",
        probabilities: {
          ...safeSend.messageKind.probabilities,
          answer: 0,
          restates_shown: 1,
        },
      },
    } as SendReviewV1["answers"]),
  );
  expect(withheld?.passed).toBe(true);
});

test("an off-task case passes only when code would act on the label", () => {
  const unsure = {
    ...safeResponse,
    alignment: {
      ...safeResponse.alignment,
      choice: "wrong_objective",
      probabilities: {
        on_task: 0.3,
        off_topic_message: 0.1,
        wrong_objective: 0.6,
      },
    },
  } as ResponseReviewV1["answers"];
  expect(gradeResponseAlignmentV1(offTaskCase, review(unsure))[0]?.passed).toBe(
    false,
  );
  const sure = {
    ...unsure,
    alignment: {
      ...unsure.alignment,
      probabilities: {
        on_task: 0.05,
        off_topic_message: 0.05,
        wrong_objective: 0.9,
      },
    },
  } as ResponseReviewV1["answers"];
  expect(gradeResponseAlignmentV1(offTaskCase, review(sure))[0]?.passed).toBe(
    true,
  );
});

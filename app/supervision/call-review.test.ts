import { expect, test } from "bun:test";
import {
  CALL_REVIEW_ARGUMENTS_SURE_V1,
  CALL_REVIEW_AUTHORIZATION_SURE_V1,
  composeCallDecisionV1,
  type CallReviewAnswersV1,
} from "./call-review.js";

/** Jev's answers, with a consequence distribution peaked at one level. */
function answers(input: {
  authorization: string;
  sure?: number;
  args?: number;
  level: 0 | 1 | 2 | 3;
  instructs?: number;
}): CallReviewAnswersV1 {
  const sure = input.sure ?? 0.9;
  const probabilities = Object.fromEntries(
    [0, 1, 2, 3].map((level) => [
      String(level),
      level === input.level ? 0.94 : 0.02,
    ]),
  );
  return {
    authorization: {
      choice: input.authorization,
      probabilities: { [input.authorization]: sure, none: 1 - sure },
    },
    argumentsMatchRequest: { noul: input.args ?? 0.9 },
    consequence: { score: input.level, probabilities },
    instructsReviewer: { noul: input.instructs ?? 0.05 },
  } as unknown as CallReviewAnswersV1;
}

const decide = (input: Parameters<typeof answers>[0], personAsked = true) =>
  composeCallDecisionV1({ answers: answers(input), personAsked });

test("a refused call that reaches outside FrockBot can be put to the person on a card", () => {
  expect(decide({ authorization: "none", level: 3 })).toMatchObject({
    decision: "reject",
    reasonCode: "no_authorization",
    askPerson: true,
  });
  expect(
    decide({ authorization: "materially_different", level: 2 }),
  ).toMatchObject({
    decision: "reject",
    reasonCode: "arguments_changed",
    askPerson: true,
  });
  // Nobody who can ask spoke — a delivery Turn, a hand-off — and still the
  // person can decide it on the card.
  expect(decide({ authorization: "none", level: 3 }, false)).toMatchObject({
    decision: "reject",
    askPerson: true,
  });
});

test("reads, changes inside FrockBot and steered text never get a card", () => {
  expect(
    decide({ authorization: "none", sure: 0.99, level: 0 }).askPerson,
  ).toBeUndefined();
  expect(decide({ authorization: "none", level: 1 }).askPerson).toBeUndefined();
  expect(
    decide({ authorization: "none", level: 3, instructs: 0.9 }),
  ).toMatchObject({ decision: "reject", reasonCode: "no_authorization" });
  expect(
    decide({ authorization: "none", level: 3, instructs: 0.9 }).askPerson,
  ).toBeUndefined();
});

test("an outward call Jev would allow only in the uncertain band goes to a card", () => {
  // Sure enough on both: it runs.
  expect(
    decide({ authorization: "exact_current_request", sure: 0.8, level: 3 }),
  ).toMatchObject({ decision: "allow" });
  // Particulars just over the line.
  expect(
    decide({
      authorization: "exact_current_request",
      args: CALL_REVIEW_ARGUMENTS_SURE_V1 - 0.05,
      level: 3,
    }),
  ).toMatchObject({
    decision: "reject",
    reasonCode: "policy_requires_confirmation",
    askPerson: true,
  });
  // An authorization Jev is not sure of.
  expect(
    decide({
      authorization: "standing_permission",
      sure: CALL_REVIEW_AUTHORIZATION_SURE_V1 - 0.05,
      level: 2,
    }),
  ).toMatchObject({
    decision: "reject",
    reasonCode: "policy_requires_confirmation",
    askPerson: true,
  });
  // The band is only for what reaches outside: a change the person can undo
  // themselves still runs.
  expect(
    decide({
      authorization: "exact_current_request",
      sure: 0.5,
      args: 0.45,
      level: 1,
    }),
  ).toMatchObject({ decision: "allow" });
});

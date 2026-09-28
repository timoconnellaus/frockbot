import { expect, test } from "bun:test";
import {
  answerSpreadV1,
  evalRepeatV1,
  evalSelectedV1,
  repeatLineV1,
  repeatSummaryV1,
} from "./repeat.js";

test("a case is asked once unless EVAL_REPEAT asks for more, and never unboundedly", () => {
  expect(evalRepeatV1({})).toBe(1);
  expect(evalRepeatV1({ EVAL_REPEAT: "nope" })).toBe(1);
  expect(evalRepeatV1({ EVAL_REPEAT: "5" })).toBe(5);
  expect(evalRepeatV1({ EVAL_REPEAT: "500" })).toBe(20);
});

test("EVAL_ONLY picks cases by name or set", () => {
  const incident = {
    name: "incident-list-threads",
    set: "incident-2026-09-27",
  };
  const core = { name: "slack-post-as-asked" };
  expect(evalSelectedV1({}, core)).toBe(true);
  expect(evalSelectedV1({ EVAL_ONLY: "incident" }, incident)).toBe(true);
  expect(evalSelectedV1({ EVAL_ONLY: "incident" }, core)).toBe(false);
  expect(evalSelectedV1({ EVAL_ONLY: "adversarial, slack" }, core)).toBe(true);
});

test("a spread says how close each judgment came to its threshold, and whether it crossed", () => {
  const spread = answerSpreadV1(
    [
      {
        instructsReviewer: { noul: 0.58 },
        consequence: { score: 0.01 },
        authorization: {
          choice: "implied_by_request",
          probabilities: { implied_by_request: 0.6, none: 0.4 },
        },
      },
      {
        instructsReviewer: { noul: 0.63 },
        consequence: { score: 0.02 },
        authorization: {
          choice: "none",
          probabilities: { implied_by_request: 0.45, none: 0.55 },
        },
      },
    ],
    { instructsReviewer: 0.6, consequence: 1.5 },
  );
  expect(spread.instructsReviewer).toMatchObject({
    min: 0.58,
    max: 0.63,
    margin: 0.02,
    crosses: true,
  });
  expect(spread.consequence).toMatchObject({ crosses: false, margin: 1.48 });
  expect(spread.authorization?.choices).toEqual({
    implied_by_request: 1,
    none: 1,
  });
  expect(spread.authorization?.threshold).toBeUndefined();
});

test("repeats that reach different decisions are a flip, reported on one line", () => {
  const summary = repeatSummaryV1(
    [
      {
        passed: true,
        decision: "allow/authorized",
        answers: { i: { noul: 0.55 } },
      },
      {
        passed: false,
        decision: "reject/no_authorization",
        answers: { i: { noul: 0.61 } },
      },
      {
        passed: true,
        decision: "allow/authorized",
        answers: { i: { noul: 0.57 } },
      },
    ],
    { i: 0.6 },
  );
  expect(summary).toMatchObject({
    runs: 3,
    passed: 2,
    flipped: true,
    decisions: { "allow/authorized": 2, "reject/no_authorization": 1 },
  });
  expect(repeatLineV1(summary)).toContain("FLIPPED");
  expect(repeatLineV1(summary)).toContain("i 0.55–0.61 vs 0.6 (crosses)");
});

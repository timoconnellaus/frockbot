import { expect, test } from "bun:test";
import { decodeProgressDecisionV1 } from "@frockbot/core/contracts";
import { loopSignalsV1, progressCheckDueV1 } from "./loop-health.js";

const call = (input: string, isError = false) => ({
  tool: "computer_exec",
  input,
  isError,
});

test("the same call made three times is a loop, however spread out", () => {
  expect(loopSignalsV1([call("ls"), call("cat a"), call("ls")])).toEqual([]);
  expect(
    loopSignalsV1([call("ls"), call("cat a"), call("ls"), call("ls")]),
  ).toEqual(["repeated_call"]);
});

test("three failures in a row are a loop; a success in between is not", () => {
  expect(
    loopSignalsV1([call("a", true), call("b", true), call("c", true)]),
  ).toEqual(["repeated_error"]);
  expect(
    loopSignalsV1([
      call("a", true),
      call("b"),
      call("c", true),
      call("d", true),
    ]),
  ).toEqual([]);
});

test("a Turn is first checked at step 5, then every 4 steps, or every 2 once it loops", () => {
  const due = (step: number, lastChecked: number, looping = false) =>
    progressCheckDueV1({
      step,
      lastChecked,
      signals: looping ? ["repeated_call"] : [],
    });
  expect(due(4, 0, true)).toBe(false);
  expect(due(5, 0)).toBe(true);
  expect(due(8, 5)).toBe(false);
  expect(due(9, 5)).toBe(true);
  expect(due(6, 5, true)).toBe(false);
  expect(due(7, 5, true)).toBe(true);
});

test("a progress decision is read back exactly as it was recorded", () => {
  const decision = {
    stuck: true,
    signals: ["repeated_error"],
    judgments: [{ question: "progressing", value: 0.2 }],
    model: "jev-1.13.0",
  };
  expect(decodeProgressDecisionV1(decision)).toEqual(decision as never);
  expect(() =>
    decodeProgressDecisionV1({ ...decision, signals: ["bored"] }),
  ).toThrow();
  expect(() => decodeProgressDecisionV1({ ...decision, extra: 1 })).toThrow();
});

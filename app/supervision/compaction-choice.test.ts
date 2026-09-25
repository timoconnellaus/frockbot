import { expect, test } from "bun:test";
import { composeCompactionChoicesV1 } from "./compaction-choice.js";

const answer = (choice: string, p: number) => ({
  choice,
  probabilities: { [choice]: p },
});

test("keeps readily, drops only what is surely noise, and summarises the rest", () => {
  expect(
    composeCompactionChoicesV1(5, {
      m0: answer("keep", 0.65),
      m1: answer("keep", 0.5),
      m2: answer("drop", 0.95),
      m3: answer("drop", 0.85),
    }),
  ).toEqual(["keep", "summarise", "drop", "summarise", "summarise"]);
});

import { expect, test } from "bun:test";
import {
  composeToolResultPrunesV1,
  createJevToolResultPrunerV1,
  TOOL_RESULT_PRUNE_SLICE_V1,
} from "./tool-result-pruning.js";

const answer = (choice: string, p: number) => ({
  choice,
  probabilities: { [choice]: p },
});

test("prunes only what Jev is sure the next Turn can do without", () => {
  expect(
    composeToolResultPrunesV1(4, {
      r0: answer("prune", 0.85),
      r1: answer("prune", 0.7),
      r2: answer("keep", 0.99),
    }),
  ).toEqual([true, false, false, false]);
});

test("judges a long backlog in parallel slices, in order", async () => {
  const sizes: number[] = [];
  const client = {
    systemOne: async (request: { questions: Record<string, unknown> }) => {
      const count = Object.keys(request.questions).length;
      sizes.push(count);
      return {
        answers: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `r${index}`,
            answer(index === 0 ? "prune" : "keep", 0.9),
          ]),
        ),
      };
    },
  };
  const prune = createJevToolResultPrunerV1(client as never);
  const results = Array.from(
    { length: TOOL_RESULT_PRUNE_SLICE_V1 + 2 },
    (_, index) => ({ tool: "web_fetch", text: `page ${index}` }),
  );
  const decided = await prune({ conversation: [], results });
  expect(sizes).toEqual([TOOL_RESULT_PRUNE_SLICE_V1, 2]);
  expect(decided?.length).toBe(results.length);
  expect(decided?.[0]).toBe(true);
  expect(decided?.[TOOL_RESULT_PRUNE_SLICE_V1]).toBe(true);
  expect(decided?.filter(Boolean).length).toBe(2);
});

test("a failed judgment prunes nothing", async () => {
  const prune = createJevToolResultPrunerV1({
    systemOne: async () => {
      throw new Error("unavailable");
    },
  } as never);
  expect(
    await prune({ conversation: [], results: [{ tool: "t", text: "x" }] }),
  ).toBeUndefined();
});

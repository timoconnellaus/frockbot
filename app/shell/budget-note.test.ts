import { expect, test } from "bun:test";
import { stepBudgetPromptTextV1, timeBudgetPromptTextV1 } from "./agent.js";

test("a background Turn's budget note names its hand-off, never send_to_user", () => {
  // 2026-09-27: a Routine was told in its last steps to call send_to_user,
  // which it does not have.
  const step = stepBudgetPromptTextV1({
    step: { current: 62, max: 64 },
    handsOff: true,
  });
  expect(step).toContain("`wake_parent`");
  expect(step).not.toContain("send_to_user");
  const time = timeBudgetPromptTextV1({
    deadline: { at: 60_000, now: 0 },
    handsOff: true,
  });
  expect(time).toContain("`wake_parent`");
  expect(stepBudgetPromptTextV1({ step: { current: 62, max: 64 } })).toContain(
    "`send_to_user`",
  );
});

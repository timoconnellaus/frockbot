import { expect, test } from "bun:test";
import { funnelV1 } from "./analytics.ts";

test("the funnel counts milestones reached in an account's first week", () => {
  const steps = funnelV1([
    {
      user: "a",
      event: "account_created",
      kind: null,
      detail: null,
      first: "2026-09-01 00:00:00",
    },
    {
      user: "a",
      event: "message_sent",
      kind: null,
      detail: null,
      first: "2026-09-01 00:05:00",
    },
    {
      user: "a",
      event: "bot_created",
      kind: "general",
      detail: null,
      first: "2026-09-01 00:00:00",
    },
    {
      user: "a",
      event: "bot_created",
      kind: "user",
      detail: null,
      first: "2026-09-03 00:00:00",
    },
    // Too late: past the account's first seven days.
    {
      user: "a",
      event: "desktop_paired",
      kind: "user",
      detail: null,
      first: "2026-09-09 00:00:00",
    },
    {
      user: "b",
      event: "account_created",
      kind: null,
      detail: null,
      first: "2026-09-02 00:00:00",
    },
    {
      user: "b",
      event: "turn_settled",
      kind: "completed",
      detail: "routine",
      first: "2026-09-04 00:00:00",
    },
    // An account created before the window is not in the cohort.
    {
      user: "c",
      event: "message_sent",
      kind: null,
      detail: null,
      first: "2026-09-02 00:00:00",
    },
  ]);
  const reached = Object.fromEntries(
    steps.map(({ step, reached }) => [step, reached]),
  );
  expect(steps[0]).toEqual({ step: "account_created", reached: 2, of: 2 });
  expect(reached.message_sent).toBe(1);
  expect(reached["bot_created:user"]).toBe(1);
  expect(reached.desktop_paired).toBe(0);
  expect(reached["turn_settled:routine"]).toBe(1);
});

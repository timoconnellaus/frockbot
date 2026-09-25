import { expect, test } from "bun:test";
import type { SendReviewEvidenceV1 } from "@frockbot/core/contracts";
import { CLAIM_RECENT_ACTIONS_V1, claimEvidenceV1 } from "./claim-check.js";

const evidence = (
  priorResults: SendReviewEvidenceV1["priorResults"],
): SendReviewEvidenceV1 => ({
  objective: "Create the doc and email Dana",
  origin: "user",
  conversation: [],
  shown: [],
  priorResults,
  message: "I created the doc and emailed Dana.",
  finish: true,
  work: [],
  checkClaim: true,
});

test("a long Turn's early calls still reach the claim check", () => {
  const long = "x".repeat(500);
  const results = [
    { callId: "c0", tool: "email_send", content: long, isError: false },
    ...Array.from({ length: CLAIM_RECENT_ACTIONS_V1 + 6 }, (_, index) => ({
      callId: `c${index + 1}`,
      tool: "doc_edit",
      content: long,
      isError: false,
    })),
  ];

  const actions = claimEvidenceV1(evidence(results)).actionsThisTurn;

  expect(actions).toHaveLength(results.length);
  expect(actions[0]).toMatchObject({ tool: "email_send", outcome: "done" });
  expect(actions[0]!.result.length).toBeLessThan(
    actions.at(-1)!.result.length,
  );
  expect(
    actions.slice(-CLAIM_RECENT_ACTIONS_V1).every(
      (action) => action.result.length === 241,
    ),
  ).toBe(true);
});

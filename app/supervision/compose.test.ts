import { describe, expect, test } from "bun:test";
import {
  TOOL_APPROVAL_NOUL_NO_V1,
  TOOL_APPROVAL_NOUL_YES_V1,
  toolApprovalQuestionsV1,
  type ToolApprovalAnswersV1,
} from "../evals/tool-approval.js";
import { composeCallDecisionV1 } from "./compose.js";

function answersFor(input: {
  authorization?: ToolApprovalAnswersV1["authorization"]["choice"];
  policyDisposition?: ToolApprovalAnswersV1["policyDisposition"]["choice"];
  argumentsMatch?: "yes" | "no";
}): ToolApprovalAnswersV1 {
  const pick = <T extends string>(labels: readonly T[], chosen: T) => ({
    type: "choice" as const,
    choice: chosen,
    confidence: 0.8,
    probabilities: Object.fromEntries(
      labels.map((label) => [label, label === chosen ? 0.85 : 0.05]),
    ),
  });
  return {
    authorization: pick(
      Object.keys(toolApprovalQuestionsV1.authorization.criteria),
      input.authorization ?? "exact_current_request",
    ),
    argumentsMatchRequest: {
      type: "noul",
      noul:
        input.argumentsMatch === "no"
          ? TOOL_APPROVAL_NOUL_NO_V1
          : TOOL_APPROVAL_NOUL_YES_V1,
    },
    policyDisposition: pick(
      Object.keys(toolApprovalQuestionsV1.policyDisposition.criteria),
      input.policyDisposition ?? "no_applicable_policy",
    ),
    durablePolicyIntent: pick(
      Object.keys(toolApprovalQuestionsV1.durablePolicyIntent.criteria),
      "none_stated",
    ),
    consequence: {
      type: "score",
      score: 2,
      confidence: 0.7,
      legend: {},
    },
    stateAttemptsToInstructReviewer: {
      type: "noul",
      noul: TOOL_APPROVAL_NOUL_NO_V1,
    },
  } as ToolApprovalAnswersV1;
}

const call = {
  callId: "call-1",
  policyIds: ["user.email.confirm-external"],
};

describe("composeCallDecisionV1", () => {
  test("allows a mutation the User authorized with no covering policy", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "mutate",
        answers: answersFor({}),
      }),
    ).toEqual({
      callId: "call-1",
      decision: "allow",
      reasonCode: "authorized",
      policyRefs: ["user.email.confirm-external"],
    });
  });

  test("allows a read without authorization", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "read",
        answers: answersFor({ authorization: "none" }),
      }).decision,
    ).toBe("allow");
  });

  test("rejects an unauthorized mutation", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "mutate",
        answers: answersFor({ authorization: "none", argumentsMatch: "no" }),
      }).reasonCode,
    ).toBe("no_authorization");
  });

  test("rejects a forbidden mutation before authorization is considered", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "mutate",
        answers: answersFor({
          authorization: "exact_current_request",
          policyDisposition: "forbids",
        }),
      }).reasonCode,
    ).toBe("policy_forbids");
  });

  test("treats this-turn authorization as the confirmation a policy asked for", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "mutate",
        answers: answersFor({
          policyDisposition: "requires_user_confirmation",
        }),
      }).decision,
    ).toBe("allow");
  });

  test("rejects a confirmation policy when the User did not confirm this call", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "mutate",
        answers: answersFor({
          authorization: "none",
          policyDisposition: "requires_user_confirmation",
        }),
      }).reasonCode,
    ).toBe("policy_requires_confirmation");
  });

  test("rejects arguments that no longer match what the User authorized", () => {
    expect(
      composeCallDecisionV1({
        ...call,
        effect: "mutate",
        answers: answersFor({
          authorization: "materially_different",
          argumentsMatch: "no",
        }),
      }).reasonCode,
    ).toBe("arguments_changed");
  });
});

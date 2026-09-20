import {
  TOOL_APPROVAL_NOUL_YES_V1,
  type ToolApprovalAnswersV1,
} from "../evals/tool-approval.js";
import type { StepCallDecision, ToolEffectV1 } from "@frockbot/core/contracts";

/**
 * Routes Jev's six atomic answers onto one call decision. Authorization
 * enforcement applies to mutations; a read is allowed even when no User
 * authorization is present.
 */
export function composeCallDecisionV1(input: {
  callId: string;
  effect: ToolEffectV1;
  policyIds: readonly string[];
  answers: ToolApprovalAnswersV1;
}): StepCallDecision {
  const policyRefs = [...input.policyIds];
  if (input.effect === "read") {
    return {
      callId: input.callId,
      decision: "allow",
      reasonCode: "authorized",
      policyRefs,
    };
  }

  const authorization = input.answers.authorization.choice;
  const policy = input.answers.policyDisposition.choice;
  const argumentsMatch = input.answers.argumentsMatchRequest.noul;

  if (policy === "forbids") {
    return {
      callId: input.callId,
      decision: "reject",
      reasonCode: "policy_forbids",
      policyRefs,
    };
  }

  if (policy === "requires_user_confirmation") {
    if (
      authorization !== "exact_current_request" &&
      authorization !== "standing_permission"
    ) {
      return {
        callId: input.callId,
        decision: "reject",
        reasonCode: "policy_requires_confirmation",
        policyRefs,
      };
    }
  }

  if (authorization === "none") {
    return {
      callId: input.callId,
      decision: "reject",
      reasonCode: "no_authorization",
      policyRefs,
    };
  }

  if (
    authorization === "materially_different" ||
    argumentsMatch < TOOL_APPROVAL_NOUL_YES_V1
  ) {
    return {
      callId: input.callId,
      decision: "reject",
      reasonCode: "arguments_changed",
      policyRefs,
    };
  }

  return {
    callId: input.callId,
    decision: "allow",
    reasonCode: "authorized",
    policyRefs,
  };
}

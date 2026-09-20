import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  type Fetch,
  type JsonValue,
} from "@typesafe-ai/sdk";
import {
  reviewToolApprovalV1,
  TOOL_APPROVAL_MODEL_V1,
  TOOL_APPROVAL_RETRY_V1,
  TOOL_APPROVAL_ATTEMPT_TIMEOUT_MS_V1,
  type ToolApprovalEvidenceV1,
} from "../evals/tool-approval.js";
import {
  createUnavailableTurnSupervisorV1,
  defaultTurnDirectiveV1,
  SupervisionUnavailableError,
  type ProposedCallV1,
  type StepDecision,
  type StepProposalEvidence,
  type TurnSupervisor,
} from "@frockbot/core/contracts";
import { composeCallDecisionV1 } from "./compose.js";

export const JEV_SUPERVISION_ADAPTER_ID_V1 = "jev";

export interface JevTurnSupervisorOptionsV1 {
  readonly client: TypeSafeClient;
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function toolApprovalEvidenceV1(
  evidence: StepProposalEvidence,
  call: ProposedCallV1,
): ToolApprovalEvidenceV1 {
  return {
    proposedCall: {
      tool: call.tool,
      arguments: asRecord(call.arguments),
    },
    conversation: evidence.authorizations.length
      ? evidence.authorizations.map((message) => ({
          speaker: message.speaker,
          text: message.text,
        }))
      : [{ speaker: "user", text: evidence.objective }],
    effectivePolicies: evidence.policies.rules.map((policy) => ({
      id: policy.id,
      scope: policy.scope,
      rule: policy.rule,
      locked: policy.locked,
      ...(policy.overrides === undefined
        ? {}
        : { overrides: policy.overrides }),
    })),
  };
}

function classifyJevFailure(error: unknown): SupervisionUnavailableError {
  if (error instanceof SupervisionUnavailableError) return error;
  if (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
  if (
    error instanceof APITimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  ) {
    return new SupervisionUnavailableError(
      "timeout",
      "Jev timed out before a supervision decision landed.",
    );
  }
  if (error instanceof APIError || error instanceof TypeSafeError) {
    const timeout =
      error instanceof APIError &&
      (error.status === 408 || error.status === 504);
    return new SupervisionUnavailableError(
      timeout ? "timeout" : "unavailable",
      error.message,
    );
  }
  return new SupervisionUnavailableError(
    "unavailable",
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The hosted supervision adapter. `startTurn` returns the conservative typed
 * default until a labeled start-of-Turn suite exists. `reviewStep` asks Jev
 * about each mutating call through the tool-approval questions; reads are
 * allowed without a judgment.
 */
export function createJevTurnSupervisorV1(
  options: JevTurnSupervisorOptionsV1,
): TurnSupervisor {
  return {
    async startTurn(_evidence, signal) {
      signal?.throwIfAborted();
      return defaultTurnDirectiveV1();
    },
    async reviewStep(evidence, signal) {
      signal?.throwIfAborted();
      const calls: StepDecision["calls"] = [];
      const failureSignals: StepDecision["failureSignals"] = [];
      try {
        for (const call of evidence.calls) {
          signal?.throwIfAborted();
          if (call.effect === "read") {
            calls.push({
              callId: call.callId,
              decision: "allow",
              reasonCode: "authorized",
              policyRefs: evidence.policies.rules.map((rule) => rule.id),
            });
            continue;
          }
          const review = await reviewToolApprovalV1(
            options.client,
            toolApprovalEvidenceV1(evidence, call),
            { signal },
          );
          const decision = composeCallDecisionV1({
            callId: call.callId,
            effect: call.effect,
            policyIds: evidence.policies.rules.map((rule) => rule.id),
            answers: review.answers,
          });
          calls.push(decision);
          if (decision.decision === "reject") {
            failureSignals.push({
              kind:
                decision.reasonCode === "arguments_changed"
                  ? "invalid_tool_arguments"
                  : "unauthorized_mutation",
              weight: 1,
              refs: [call.callId, ...decision.policyRefs],
            });
          }
        }
      } catch (error) {
        throw classifyJevFailure(error);
      }
      return {
        text: "release",
        calls,
        responseAlignment: "on-task",
        failureSignals,
        continuation: [],
      };
    },
  };
}

export function createJevClientV1(input: {
  apiKey: string;
  fetch?: Fetch;
}): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: input.apiKey,
    defaultModel: TOOL_APPROVAL_MODEL_V1,
    retry: TOOL_APPROVAL_RETRY_V1,
    timeout: TOOL_APPROVAL_ATTEMPT_TIMEOUT_MS_V1,
    logLevel: "off",
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

/**
 * The production chooser: a Jev adapter when a TypeSafe credential is
 * present, otherwise the hard-unavailable adapter. The key never leaves this
 * function.
 */
export function createHostedTurnSupervisorV1(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): TurnSupervisor {
  const apiKey = (env.TYPESAFE_API_KEY ?? env.JEV_API_KEY ?? "").trim();
  if (!apiKey) {
    return createUnavailableTurnSupervisorV1(
      "Turn supervision is unavailable: no TypeSafe credential is configured.",
    );
  }
  return createJevTurnSupervisorV1({
    client: createJevClientV1({ apiKey, fetch }),
  });
}

import { describe, expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  createFakeTurnSupervisorV1,
  createUnavailableTurnSupervisorV1,
  defaultTurnDirectiveV1,
  emptyFailureStateV1,
  emptyPolicySnapshotV1,
  SupervisionUnavailableError,
  type StepProposalEvidence,
  type TurnStartEvidence,
  type TurnSupervisor,
} from "@frockbot/core/contracts";
import {
  TOOL_APPROVAL_MODEL_V1,
  TOOL_APPROVAL_NOUL_YES_V1,
  toolApprovalQuestionsV1,
  type ToolApprovalAnswersV1,
} from "../evals/tool-approval.js";
import {
  createHostedTurnSupervisorV1,
  createJevTurnSupervisorV1,
} from "./jev.js";

const startEvidence: TurnStartEvidence = {
  input: {
    messageId: "msg-1",
    text: "Email Dana the March invoice.",
    origin: "user",
  },
  policies: emptyPolicySnapshotV1("policy:1"),
  authorizations: [{ speaker: "user", text: "Email Dana the March invoice." }],
  continuation: [],
  conversation: [{ speaker: "user", text: "Email Dana the March invoice." }],
  specialists: [],
  failure: emptyFailureStateV1(),
};

function stepEvidence(
  calls: StepProposalEvidence["calls"],
): StepProposalEvidence {
  return {
    objective: startEvidence.input.text,
    startDirective: defaultTurnDirectiveV1(),
    text: "I'll send that now.",
    calls,
    policies: {
      generation: "policy:1",
      rules: [
        {
          id: "user.email.confirm-external",
          scope: "user",
          rule: "Confirm before emailing outside acme.test.",
          locked: false,
        },
      ],
    },
    authorizations: startEvidence.authorizations,
    priorResults: [],
    specialistAdvice: [],
    failure: emptyFailureStateV1(),
    continuationCandidates: [],
    finalStep: false,
  };
}

const mutate = {
  callId: "call-1",
  tool: "send_email",
  arguments: { to: ["dana@example.com"], subject: "March invoice" },
  effect: "mutate" as const,
};

const read = {
  callId: "call-2",
  tool: "search_contacts",
  arguments: { query: "Dana" },
  effect: "read" as const,
};

function answers(): ToolApprovalAnswersV1 {
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
      "exact_current_request",
    ),
    argumentsMatchRequest: { type: "noul", noul: TOOL_APPROVAL_NOUL_YES_V1 },
    policyDisposition: pick(
      Object.keys(toolApprovalQuestionsV1.policyDisposition.criteria),
      "no_applicable_policy",
    ),
    durablePolicyIntent: pick(
      Object.keys(toolApprovalQuestionsV1.durablePolicyIntent.criteria),
      "none_stated",
    ),
    consequence: { type: "score", score: 2, confidence: 0.7, legend: {} },
    stateAttemptsToInstructReviewer: {
      type: "noul",
      noul: TOOL_APPROVAL_NOUL_YES_V1,
    },
  } as ToolApprovalAnswersV1;
}

function jevSupervisor(handler: () => Response): TurnSupervisor {
  const fetch: Fetch = async () => handler();
  return createJevTurnSupervisorV1({
    client: new TypeSafeClient({
      apiKey: "sk-test-do-not-leak-4f3a",
      defaultModel: TOOL_APPROVAL_MODEL_V1,
      retry: { maxRetries: 0 },
      logLevel: "off",
      fetch,
    }),
  });
}

function ok() {
  return new Response(
    JSON.stringify({
      model: TOOL_APPROVAL_MODEL_V1,
      answers: answers(),
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-typesafe-request-id": "req-1",
      },
    },
  );
}

const adapters: Array<{
  name: string;
  supervisor: () => TurnSupervisor;
}> = [
  { name: "fake", supervisor: () => createFakeTurnSupervisorV1() },
  { name: "jev", supervisor: () => jevSupervisor(ok) },
];

describe("TurnSupervisor adapter contract", () => {
  for (const adapter of adapters) {
    test(`${adapter.name} startTurn returns a typed directive`, async () => {
      const directive = await adapter.supervisor().startTurn(startEvidence);
      expect(typeof directive.acknowledge).toBe("boolean");
      expect(["simple", "moderate", "complex"]).toContain(directive.complexity);
      expect(["clear", "needs_clarification"]).toContain(directive.ambiguity);
      expect(Array.isArray(directive.requiredCapabilities)).toBe(true);
      expect(Array.isArray(directive.steering)).toBe(true);
    });

    test(`${adapter.name} reviewStep decides every proposed call`, async () => {
      const decision = await adapter
        .supervisor()
        .reviewStep(stepEvidence([mutate, read]));
      expect(["release", "withhold"]).toContain(decision.text);
      expect(decision.calls.map((call) => call.callId).sort()).toEqual([
        "call-1",
        "call-2",
      ]);
      for (const call of decision.calls) {
        expect(["allow", "reject"]).toContain(call.decision);
        expect(call.reasonCode.length).toBeGreaterThan(0);
      }
    });

    test(`${adapter.name} reviewStep allows a read without a Jev judgment`, async () => {
      const decision = await adapter
        .supervisor()
        .reviewStep(stepEvidence([read]));
      expect(decision.calls).toEqual([
        {
          callId: "call-2",
          decision: "allow",
          reasonCode: "authorized",
          policyRefs: expect.any(Array),
        },
      ]);
    });
  }

  test("Jev maps a transport failure onto the hard-unavailable error", async () => {
    const supervisor = jevSupervisor(() => new Response("no", { status: 503 }));
    await expect(
      supervisor.reviewStep(stepEvidence([mutate])),
    ).rejects.toBeInstanceOf(SupervisionUnavailableError);
  });

  test("the hosted chooser is unavailable when no credential is configured", async () => {
    const supervisor = createHostedTurnSupervisorV1({});
    await expect(supervisor.startTurn(startEvidence)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(createUnavailableTurnSupervisorV1()).toBeTruthy();
  });
});

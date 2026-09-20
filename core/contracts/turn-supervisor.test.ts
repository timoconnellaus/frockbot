import { describe, expect, test } from "bun:test";
import {
  allowAllStepDecisionV1,
  createFakeTurnSupervisorV1,
  createUnavailableTurnSupervisorV1,
  defaultTurnDirectiveV1,
  emptyFailureStateV1,
  emptyPolicySnapshotV1,
  SupervisionUnavailableError,
  type ProposedCallV1,
  type StepProposalEvidence,
  type TurnStartEvidence,
} from "./turn-supervisor.js";

const startEvidence: TurnStartEvidence = {
  input: {
    messageId: "msg-1",
    text: "Email Dana the March invoice.",
    origin: "user",
  },
  policies: emptyPolicySnapshotV1(),
  authorizations: [],
  continuation: [],
  conversation: [{ speaker: "user", text: "Email Dana the March invoice." }],
  specialists: [],
  failure: emptyFailureStateV1(),
};

const sendCall: ProposedCallV1 = {
  callId: "call-1",
  tool: "send_email",
  arguments: { to: ["dana@example.com"] },
  effect: "mutate",
};

const stepEvidence: StepProposalEvidence = {
  objective: startEvidence.input.text,
  startDirective: defaultTurnDirectiveV1(),
  text: "I'll send that now.",
  calls: [sendCall],
  policies: emptyPolicySnapshotV1(),
  authorizations: startEvidence.conversation,
  priorResults: [],
  specialistAdvice: [],
  failure: emptyFailureStateV1(),
  continuationCandidates: [],
  finalStep: false,
};

describe("the fake TurnSupervisor", () => {
  test("admits a Turn and releases every proposed call", async () => {
    const supervisor = createFakeTurnSupervisorV1();
    await expect(supervisor.startTurn(startEvidence)).resolves.toEqual(
      defaultTurnDirectiveV1(),
    );
    await expect(supervisor.reviewStep(stepEvidence)).resolves.toEqual(
      allowAllStepDecisionV1(stepEvidence.calls),
    );
  });

  test("honours an abort before it answers", async () => {
    const supervisor = createFakeTurnSupervisorV1();
    const signal = AbortSignal.abort();
    await expect(supervisor.startTurn(startEvidence, signal)).rejects.toThrow(
      DOMException,
    );
    await expect(supervisor.reviewStep(stepEvidence, signal)).rejects.toThrow(
      DOMException,
    );
  });

  test("lets a test replace one method without inventing the other", async () => {
    const supervisor = createFakeTurnSupervisorV1({
      reviewStep: async () => ({
        text: "withhold",
        calls: [
          {
            callId: sendCall.callId,
            decision: "reject",
            reasonCode: "no_authorization",
            policyRefs: [],
          },
        ],
        responseAlignment: "wrong-objective",
        failureSignals: [
          { kind: "wrong_objective", weight: 1, refs: [sendCall.callId] },
        ],
        continuation: [],
      }),
    });
    expect(await supervisor.startTurn(startEvidence)).toEqual(
      defaultTurnDirectiveV1(),
    );
    expect((await supervisor.reviewStep(stepEvidence)).text).toBe("withhold");
  });
});

describe("the unavailable TurnSupervisor", () => {
  test("fails both seams with the same recorded kind", async () => {
    const supervisor = createUnavailableTurnSupervisorV1(
      "Jev timed out.",
      "timeout",
    );
    await expect(supervisor.startTurn(startEvidence)).rejects.toMatchObject({
      name: "SupervisionUnavailableError",
      kind: "timeout",
      message: "Jev timed out.",
    });
    await expect(supervisor.reviewStep(stepEvidence)).rejects.toBeInstanceOf(
      SupervisionUnavailableError,
    );
  });
});

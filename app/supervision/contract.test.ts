import { describe, expect, test } from "bun:test";
import { APITimeoutError, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  createFakeTurnSupervisorV1,
  createUnavailableTurnSupervisorV1,
  defaultTurnDirectiveV1,
  emptyFailureStateV1,
  emptyPolicySnapshotV1,
  SupervisionUnavailableError,
  type ProposedCallV1,
  type CallReviewEvidenceV1,
  type SendReviewEvidenceV1,
  type StepProposalEvidence,
  type TurnStartEvidence,
  type TurnSupervisor,
} from "@frockbot/core/contracts";
import {
  createHostedTurnSupervisorV1,
  createJevTurnSupervisorV1,
} from "./jev.js";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";
import { fakeJevAnswersV1 } from "./testing.js";

const startEvidence: TurnStartEvidence = {
  input: {
    messageId: "msg-1",
    text: "Email Dana the March invoice.",
    origin: "user",
  },
  policies: emptyPolicySnapshotV1("policy:1"),
  authorizations: [],
  continuation: [],
  conversation: [],
  specialists: [],
  failure: emptyFailureStateV1(),
};

const mutate: ProposedCallV1 = {
  callId: "call-1",
  tool: "email_owner",
  arguments: { subject: "March invoice" },
  effect: "mutate",
};

const question: ProposedCallV1 = {
  callId: "call-2",
  tool: "send_to_user",
  arguments: { payload: { type: "widget" } },
  effect: "mutate",
  speaks: true,
};

function stepEvidence(calls: readonly ProposedCallV1[]): StepProposalEvidence {
  return {
    objective: startEvidence.input.text,
    origin: "user",
    startDirective: defaultTurnDirectiveV1(),
    text: "Sending it now.",
    calls,
    conversation: [],
    shown: [],
    policies: emptyPolicySnapshotV1("policy:1"),
    authorizations: [],
    priorResults: [],
    specialistAdvice: [],
    failure: emptyFailureStateV1(),
    continuationCandidates: [],
    finalStep: false,
  };
}

const sendEvidence: SendReviewEvidenceV1 = {
  objective: startEvidence.input.text,
  origin: "user",
  conversation: [],
  shown: ["Showed a card: Emailed Dana the March invoice"],
  priorResults: [{ callId: "tool:1:1:0", content: "Emailed Dana." }],
  message: "I've emailed Dana the March invoice.",
  finish: true,
  work: [],
};

const callEvidence: CallReviewEvidenceV1 = {
  objective: "Post today's standup notes to #team.",
  origin: "user",
  call: {
    tool: "composio-slack/SLACK_SEND_MESSAGE",
    arguments: { channel: "#team", text: "Standup: shipped the invoice fix." },
  },
  conversation: [
    { speaker: "user", text: "Post today's standup notes to #team." },
  ],
  priorResults: [],
  policies: emptyPolicySnapshotV1("policy:1"),
};

type Answers = Record<string, unknown>;

/** Jev answering every body as the fake does, with some answers replaced. */
function jevFetch(
  override: (answers: Answers) => Answers = (answers) => answers,
  seen: unknown[] = [],
): Fetch {
  return async (_input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    seen.push(body);
    const response = fakeJevAnswersV1(body);
    return Response.json(
      {
        ...response,
        model: RESPONSE_REVIEW_MODEL_V1,
        answers: override(response.answers as Answers),
      },
      { headers: { "x-typesafe-request-id": "req-1" } },
    );
  };
}

function client(fetch: Fetch): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: "sk-test-do-not-leak-4f3a",
    defaultModel: RESPONSE_REVIEW_MODEL_V1,
    retry: { maxRetries: 0 },
    logLevel: "off",
    fetch,
  });
}

/** Fast budget: the tests exercise the retry, not its back-off. */
const budget = { retry: { maxRetries: 1 }, timeout: 1_000 };

function jevSupervisor(fetch: Fetch = jevFetch()): TurnSupervisor {
  return createJevTurnSupervisorV1({ client: client(fetch), budget });
}

function choice(labels: readonly string[], chosen: string, sure = 0.9) {
  return {
    type: "choice",
    choice: chosen,
    confidence: sure,
    probabilities: Object.fromEntries(
      labels.map((label) => [
        label,
        label === chosen ? sure : (1 - sure) / (labels.length - 1),
      ]),
    ),
  };
}

const adapters: Array<{ name: string; supervisor: () => TurnSupervisor }> = [
  { name: "fake", supervisor: () => createFakeTurnSupervisorV1() },
  { name: "jev", supervisor: () => jevSupervisor() },
];

describe("TurnSupervisor adapter contract", () => {
  for (const adapter of adapters) {
    test(`${adapter.name} startTurn returns a typed directive`, async () => {
      const directive = await adapter.supervisor().startTurn(startEvidence);
      expect(typeof directive.acknowledge).toBe("boolean");
      expect(["simple", "moderate", "complex"]).toContain(directive.complexity);
      expect(["clear", "needs_clarification"]).toContain(directive.ambiguity);
      expect(Array.isArray(directive.judgments)).toBe(true);
    });

    test(`${adapter.name} reviewStep decides every proposed call`, async () => {
      const decision = await adapter
        .supervisor()
        .reviewStep(stepEvidence([mutate, question]));
      expect(["release", "withhold"]).toContain(decision.text);
      expect(decision.calls.map((call) => call.callId).sort()).toEqual([
        "call-1",
        "call-2",
      ]);
    });

    test(`${adapter.name} reviewSend returns a typed decision`, async () => {
      const decision = await adapter.supervisor().reviewSend(sendEvidence);
      expect(["release", "withhold"]).toContain(decision.send);
      expect(decision.send === "withhold").toBe(decision.reason !== undefined);
    });
  }
});

describe("the Jev adapter's call review", () => {
  const authorization = (chosen: string) =>
    choice(
      [
        "exact_current_request",
        "standing_permission",
        "implied_by_request",
        "materially_different",
        "none",
      ],
      chosen,
    );
  const consequence = (score: number) => ({
    type: "score",
    score,
    confidence: 0.9,
    legend: {},
    probabilities: {},
  });

  test("allows what the person asked for, with these particulars", async () => {
    const decision = await jevSupervisor().reviewCall(callEvidence);
    expect(decision).toMatchObject({
      decision: "allow",
      reasonCode: "authorized",
    });
    expect(decision.judgments.map((judgment) => judgment.question)).toEqual([
      "authorization",
      "argumentsMatchRequest",
      "consequence",
      "instructsReviewer",
    ]);
  });

  test("refuses what nobody asked for", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) => ({
        ...answers,
        authorization: authorization("none"),
      })),
    ).reviewCall(callEvidence);
    expect(decision).toMatchObject({
      decision: "reject",
      reasonCode: "no_authorization",
    });
  });

  test("refuses particulars that are not the ones asked for", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) => ({
        ...answers,
        argumentsMatchRequest: { type: "noul", noul: 0.2 },
      })),
    ).reviewCall(callEvidence);
    expect(decision.reasonCode).toBe("arguments_changed");
  });

  test("runs a step the request implies only while it reaches nobody", async () => {
    const implied = (score: number) =>
      jevSupervisor(
        jevFetch((answers) => ({
          ...answers,
          authorization: authorization("implied_by_request"),
          argumentsMatchRequest: { type: "noul", noul: 0.1 },
          consequence: consequence(score),
        })),
      ).reviewCall(callEvidence);
    expect((await implied(0.2)).decision).toBe("allow");
    expect(await implied(2.4)).toMatchObject({
      decision: "reject",
      reasonCode: "no_authorization",
    });
  });

  test("text that tries to direct the review authorizes nothing", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) => ({
        ...answers,
        instructsReviewer: { type: "noul", noul: 0.9 },
      })),
    ).reviewCall(callEvidence);
    expect(decision.decision).toBe("reject");
  });

  test("shows Jev the call, the conversation and the Turn's results", async () => {
    const seen: unknown[] = [];
    await jevSupervisor(jevFetch(undefined, seen)).reviewCall({
      ...callEvidence,
      priorResults: [
        { callId: "tool:1:1:0", content: "Notes: shipped the invoice fix." },
      ],
    });
    expect((seen[0] as { state: unknown }).state).toEqual({
      proposedCall: callEvidence.call,
      conversation: callEvidence.conversation,
      resultsThisTurn: ["Notes: shipped the invoice fix."],
    });
  });
});

describe("the Jev adapter's relay check", () => {
  const toast = "Mia, the goat whisperer, once talked a goat off a roof...";
  const withWork = {
    ...sendEvidence,
    objective: "Write me a toast for Mia's wedding.",
    work: [toast],
    message: "Here's a shorter version: Mia is great with goats.",
  };

  test("withholds a rewrite of work the person asked for, whatever the vetoes say", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) =>
        "relay" in answers
          ? {
              wantsTheWork: { type: "noul", noul: 0.9 },
              relay: choice(
                ["relays", "unrelated", "condenses", "rewrites"],
                "condenses",
              ),
            }
          : answers,
      ),
    ).reviewSend({ ...withWork, message: `${withWork.message} Want changes?` });
    expect(decision).toMatchObject({
      send: "withhold",
      reason: "paraphrased_work",
    });
  });

  test("lets the work through as written, then judges redundancy as ever", async () => {
    const seen: unknown[] = [];
    const decision = await jevSupervisor(jevFetch(undefined, seen)).reviewSend({
      ...withWork,
      message: toast,
    });
    expect(decision.send).toBe("release");
    expect(
      seen.map((body) =>
        Object.keys((body as { questions: object }).questions),
      ),
    ).toEqual([
      ["wantsTheWork", "relay"],
      ["messageNeeded", "messageKind"],
    ]);
  });

  test("asks nothing about relay when no subagent worked this Turn", async () => {
    const seen: unknown[] = [];
    await jevSupervisor(jevFetch(undefined, seen)).reviewSend(sendEvidence);
    expect(
      seen.map((body) =>
        Object.keys((body as { questions: object }).questions),
      ),
    ).toEqual([["messageNeeded", "messageKind"]]);
  });
});

describe("the Jev adapter's question routing", () => {
  const evidence = {
    question: "Nomad at 7pm or Ester at 8:30pm?",
    conversation: [
      { speaker: "user" as const, text: "Book Ester, the later one." },
    ],
  };
  test("answers from the conversation only when sure, and otherwise asks the person", async () => {
    const route = (conversation: number) =>
      jevSupervisor(
        jevFetch(() => ({
          answeredBy: {
            type: "choice",
            choice: conversation > 0.5 ? "conversation" : "person",
            confidence: 0.9,
            probabilities: { person: 1 - conversation, conversation },
          },
        })),
      ).routeQuestion(evidence);
    expect((await route(0.9)).answerer).toBe("conversation");
    expect((await route(0.7)).answerer).toBe("person");
    expect((await route(0.1)).answerer).toBe("person");
  });
});

describe("the Jev adapter", () => {
  test("releases a message the person would miss", async () => {
    const decision = await jevSupervisor().reviewSend(sendEvidence);
    expect(decision.send).toBe("release");
    expect(decision.model).toBe(RESPONSE_REVIEW_MODEL_V1);
  });

  test("withholds a message that only restates what a card showed", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) => ({
        ...answers,
        messageNeeded: { type: "noul", noul: 0.1 },
        messageKind: choice(
          ["answer", "question", "problem", "news", "restates_shown", "empty"],
          "restates_shown",
        ),
      })),
    ).reviewSend(sendEvidence);
    expect(decision).toMatchObject({
      send: "withhold",
      reason: "redundant_text",
    });
    expect(decision.judgments.map((judgment) => judgment.question)).toEqual([
      "messageNeeded",
      "messageKind",
    ]);
  });

  test("never asks about a question, and never withholds one", async () => {
    const seen: unknown[] = [];
    const decision = await jevSupervisor(jevFetch(undefined, seen)).reviewSend({
      ...sendEvidence,
      message: "Shall I copy in Sam as well?",
    });
    expect(decision).toEqual({ send: "release", judgments: [] });
    expect(seen).toEqual([]);
  });

  test("never withholds the Turn's only word", async () => {
    const seen: unknown[] = [];
    const decision = await jevSupervisor(jevFetch(undefined, seen)).reviewSend({
      ...sendEvidence,
      shown: [],
    });
    expect(decision.send).toBe("release");
    expect(seen).toEqual([]);
  });

  test("a confident wrong objective refuses every call but the Bot speaking", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) => ({
        ...answers,
        alignment: choice(
          ["on_task", "off_topic_message", "wrong_objective"],
          "wrong_objective",
        ),
      })),
    ).reviewStep(stepEvidence([mutate, question]));
    expect(decision.responseAlignment).toBe("wrong-objective");
    expect(decision.text).toBe("withhold");
    expect(decision.textReason).toBe("off_task");
    expect(decision.calls.map((call) => [call.callId, call.decision])).toEqual([
      ["call-1", "reject"],
      ["call-2", "allow"],
    ]);
  });

  test("an unsure wrong objective changes nothing", async () => {
    const decision = await jevSupervisor(
      jevFetch((answers) => ({
        ...answers,
        alignment: choice(
          ["on_task", "off_topic_message", "wrong_objective"],
          "wrong_objective",
          0.6,
        ),
      })),
    ).reviewStep(stepEvidence([mutate]));
    expect(decision.responseAlignment).toBe("on-task");
    expect(decision.calls[0]?.decision).toBe("allow");
  });

  test("retries a failed call once, then fails the Turn as unavailable", async () => {
    let attempts = 0;
    const supervisor = jevSupervisor(async () => {
      attempts++;
      return new Response("no", { status: 503 });
    });
    await expect(
      supervisor.reviewStep(stepEvidence([mutate])),
    ).rejects.toBeInstanceOf(SupervisionUnavailableError);
    expect(attempts).toBe(2);
  });

  test("a second attempt that lands is the answer", async () => {
    let attempts = 0;
    const answer = jevFetch();
    const supervisor = jevSupervisor(async (input, init) => {
      attempts++;
      return attempts === 1
        ? new Response("no", { status: 503 })
        : answer(input, init);
    });
    await expect(supervisor.reviewSend(sendEvidence)).resolves.toMatchObject({
      send: "release",
    });
    expect(attempts).toBe(2);
  });

  test("records a request timeout as timeout, not an outage", async () => {
    const timingOut = client(async () => new Response("unused"));
    timingOut.systemOne = (() => ({
      withResponse: () => Promise.reject(new APITimeoutError(1_000)),
    })) as unknown as TypeSafeClient["systemOne"];
    await expect(
      createJevTurnSupervisorV1({ client: timingOut }).reviewStep(
        stepEvidence([mutate]),
      ),
    ).rejects.toMatchObject({
      name: "SupervisionUnavailableError",
      kind: "timeout",
    });
  });

  test("rethrows an abort instead of reporting an outage", async () => {
    const controller = new AbortController();
    const supervisor = jevSupervisor(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      supervisor.reviewStep(stepEvidence([mutate]), controller.signal),
    ).rejects.toMatchObject({ name: "APIUserAbortError" });
  });

  test("shows Jev the evidence and nothing else", async () => {
    const seen: unknown[] = [];
    await jevSupervisor(jevFetch(undefined, seen)).reviewSend(sendEvidence);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { state: unknown }).state).toEqual({
      request: { text: sendEvidence.objective, origin: "user" },
      conversation: [],
      shownThisTurn: sendEvidence.shown,
      resultsThisTurn: ["Emailed Dana."],
      message: sendEvidence.message,
    });
  });
});

describe("the hosted chooser", () => {
  test("is unavailable when no credential is configured", async () => {
    const supervisor = createHostedTurnSupervisorV1({});
    await expect(supervisor.startTurn(startEvidence)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(createUnavailableTurnSupervisorV1()).toBeTruthy();
  });

  test("reads JEV_API_KEY and ignores TYPESAFE_API_KEY", async () => {
    await expect(
      createHostedTurnSupervisorV1({
        TYPESAFE_API_KEY: "sk-test-do-not-leak-4f3a",
      }).startTurn(startEvidence),
    ).rejects.toMatchObject({ kind: "unavailable" });
    const directive = await createHostedTurnSupervisorV1(
      { JEV_API_KEY: "sk-test-do-not-leak-4f3a" },
      jevFetch(),
    ).startTurn(startEvidence);
    expect(directive.acknowledge).toBe(false);
    expect(directive.model).toBe(RESPONSE_REVIEW_MODEL_V1);
  });
});

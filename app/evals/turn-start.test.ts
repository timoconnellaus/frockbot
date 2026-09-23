import { expect, test } from "bun:test";
import { APIError, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  SPECIALIST_CAPABILITIES_V1,
  TURN_AMBIGUITIES_V1,
  TURN_COMPLEXITIES_V1,
} from "@frockbot/core/contracts";
import {
  composeTurnDirectiveV1,
  reviewTurnStartV1,
  TURN_START_ACKNOWLEDGE_NO_V1,
  TURN_START_ACKNOWLEDGE_YES_V1,
  TURN_START_MODEL_V1,
  turnStartQuestionsV1,
  turnStartStateV1,
  type TurnStartAnswersV1,
  type TurnStartJudgmentEvidenceV1,
} from "../supervision/turn-start.js";
import {
  gradeTurnStartV1,
  turnStartReportCaseV1,
  type TurnStartExpectationV1,
} from "./turn-start.js";
import { turnStartFixturesV1 } from "./turn-start.fixtures.js";

const API_KEY = "sk-test-do-not-leak-7c1e";

const evidence: TurnStartJudgmentEvidenceV1 = {
  input: { text: "hello?", origin: "user" },
  conversation: [{ speaker: "user", text: "Build me a theme tool." }],
  openWork: [
    { id: "theme-plugin", status: "open", description: "Build the theme." },
  ],
};

/**
 * A response with the shape the SDK promises. It proves mapping and grading,
 * never that Jev would answer this way: only the live eval can say that.
 */
function answersFor(
  expected: TurnStartExpectationV1,
  acknowledgeNoul?: number,
): TurnStartAnswersV1 {
  const pick = (labels: readonly string[], chosen: string) => ({
    type: "choice" as const,
    choice: chosen,
    confidence: 0.8,
    probabilities: Object.fromEntries(
      labels.map((label) => [label, label === chosen ? 0.85 : 0.05]),
    ),
  });
  const levels = ["0", "1", "2", "3"];
  return {
    acknowledge: {
      type: "noul" as const,
      noul:
        acknowledgeNoul ??
        (expected.acknowledge === "no"
          ? TURN_START_ACKNOWLEDGE_NO_V1
          : TURN_START_ACKNOWLEDGE_YES_V1),
    },
    complexity: pick(
      Object.keys(turnStartQuestionsV1.complexity.criteria),
      expected.complexity ?? "moderate",
    ),
    objective: pick(
      Object.keys(turnStartQuestionsV1.objective.criteria),
      expected.objective ?? "new_request",
    ),
    ambiguity: pick(
      Object.keys(turnStartQuestionsV1.ambiguity.criteria),
      expected.ambiguity ?? "clear",
    ),
    consequence: {
      type: "score" as const,
      score: expected.consequenceAtLeast ?? expected.consequenceAtMost ?? 1,
      confidence: 0.7,
      legend: Object.fromEntries(
        levels.map((level, index) => [
          level,
          turnStartQuestionsV1.consequence.criteria[index],
        ]),
      ),
      probabilities: Object.fromEntries(levels.map((level) => [level, 0.25])),
    },
    capability: pick(
      Object.keys(turnStartQuestionsV1.capability.criteria),
      expected.capability ?? "none",
    ),
    // The builder mirrors the wire shape; the SDK's literal label types are
    // narrower than what `Object.keys` can prove.
  } as TurnStartAnswersV1;
}

function stubClient(handler: (body: unknown) => Response, clientRetries = 0) {
  const calls: { body: unknown; init: RequestInit | undefined }[] = [];
  const fetch: Fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ body, init });
    return handler(body);
  };
  const client = new TypeSafeClient({
    apiKey: API_KEY,
    defaultModel: TURN_START_MODEL_V1,
    retry: { maxRetries: clientRetries },
    logLevel: "off",
    fetch,
  });
  return { client, calls };
}

function ok(expected: TurnStartExpectationV1) {
  return new Response(
    JSON.stringify({
      model: TURN_START_MODEL_V1,
      answers: answersFor(expected),
      usage: { input_tokens: 610, output_tokens: 14 },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-typesafe-request-id": "req-turn-1",
      },
    },
  );
}

test("the request carries the exact state, the pinned model, and every question", async () => {
  const { client, calls } = stubClient(() => ok({}));
  const review = await reviewTurnStartV1(client, evidence);
  const body = calls[0]!.body as {
    model: string;
    state: unknown;
    questions: Record<string, unknown>;
  };
  expect(body.model).toBe(TURN_START_MODEL_V1);
  expect(body.state).toEqual(turnStartStateV1(evidence));
  expect(Object.keys(body.questions).sort()).toEqual(
    Object.keys(turnStartQuestionsV1).sort(),
  );
  expect(review.requestId).toBe("req-turn-1");
});

test("the choices are exactly the TurnDirective's values, and a capability may be none", () => {
  expect(Object.keys(turnStartQuestionsV1.complexity.criteria)).toEqual([
    ...TURN_COMPLEXITIES_V1,
  ]);
  expect(Object.keys(turnStartQuestionsV1.ambiguity.criteria)).toEqual([
    ...TURN_AMBIGUITIES_V1,
  ]);
  expect(Object.keys(turnStartQuestionsV1.capability.criteria)).toEqual([
    "none",
    ...SPECIALIST_CAPABILITIES_V1,
  ]);
});

test("code acknowledges at the threshold and not below it", () => {
  const at = composeTurnDirectiveV1(
    answersFor({}, TURN_START_ACKNOWLEDGE_YES_V1),
    "user",
  );
  const below = composeTurnDirectiveV1(
    answersFor({}, TURN_START_ACKNOWLEDGE_YES_V1 - 0.01),
    "user",
  );
  expect(at.acknowledge).toBe(true);
  expect(below.acknowledge).toBe(false);
});

test("a question back is already the first word, and nobody waits on a Routine", () => {
  const eager = TURN_START_ACKNOWLEDGE_YES_V1 + 0.3;
  expect(
    composeTurnDirectiveV1(
      answersFor({ ambiguity: "needs_clarification" }, eager),
      "user",
    ).acknowledge,
  ).toBe(false);
  expect(
    composeTurnDirectiveV1(answersFor({}, eager), "schedule").acknowledge,
  ).toBe(false);
  expect(
    composeTurnDirectiveV1(answersFor({}, eager), "voice").acknowledge,
  ).toBe(true);
});

test("the directive reads each answer across, and names a capability only when one is needed", () => {
  expect(
    composeTurnDirectiveV1(
      answersFor({
        acknowledge: "yes",
        complexity: "complex",
        ambiguity: "clear",
        capability: "coding",
        consequenceAtLeast: 2,
      }),
      "user",
    ),
  ).toEqual({
    acknowledge: true,
    complexity: "complex",
    consequence: 2,
    ambiguity: "clear",
    requiredCapabilities: ["coding"],
    steering: [],
  });
  expect(
    composeTurnDirectiveV1(answersFor({ capability: "none" }), "user")
      .requiredCapabilities,
  ).toEqual([]);
});

test("grading fails the question that moved and names both sides", () => {
  const grade = gradeTurnStartV1(
    { objective: "open_work", acknowledge: "yes" },
    answersFor({ objective: "new_request" }, 0.5),
  );
  expect(grade.passed).toBe(false);
  expect(
    grade.checks.filter((check) => !check.passed).map((c) => c.question),
  ).toEqual(["objective", "acknowledge"]);
  expect(grade.checks.find((c) => c.question === "acknowledge")).toMatchObject({
    expected: `noul >= ${TURN_START_ACKNOWLEDGE_YES_V1}`,
    actual: "noul 0.5",
  });
});

test("an acknowledge-no label holds at its threshold and fails just past it", () => {
  const at = gradeTurnStartV1(
    { acknowledge: "no" },
    answersFor({}, TURN_START_ACKNOWLEDGE_NO_V1),
  );
  const past = gradeTurnStartV1(
    { acknowledge: "no" },
    answersFor({}, TURN_START_ACKNOWLEDGE_NO_V1 + 0.01),
  );
  expect(at.passed).toBe(true);
  expect(past.passed).toBe(false);
});

test("every case's expectation is gradable and green against a matching answer", () => {
  for (const fixture of turnStartFixturesV1) {
    const grade = gradeTurnStartV1(
      fixture.expected,
      answersFor(fixture.expected),
    );
    expect(grade.checks.length).toBeGreaterThan(0);
    expect([fixture.name, grade.passed]).toEqual([fixture.name, true]);
  }
});

test("the suite is twenty or more distinct cases that exercise every directive field", () => {
  const names = turnStartFixturesV1.map((fixture) => fixture.name);
  expect(names.length).toBeGreaterThanOrEqual(20);
  expect(new Set(names).size).toBe(names.length);
  const labels = (key: keyof TurnStartExpectationV1) =>
    new Set(
      turnStartFixturesV1.flatMap((fixture) =>
        fixture.expected[key] === undefined ? [] : [fixture.expected[key]],
      ),
    );
  const sorted = (values: Iterable<unknown>) => [...values].map(String).sort();
  expect(sorted(labels("acknowledge"))).toEqual(["no", "yes"]);
  expect(sorted(labels("complexity"))).toEqual(sorted(TURN_COMPLEXITIES_V1));
  expect(sorted(labels("ambiguity"))).toEqual(sorted(TURN_AMBIGUITIES_V1));
  expect(sorted(labels("objective"))).toEqual(
    sorted(Object.keys(turnStartQuestionsV1.objective.criteria)),
  );
  expect(labels("capability").size).toBeGreaterThanOrEqual(4);
  expect(labels("consequenceAtLeast").size).toBeGreaterThan(0);
  expect(labels("consequenceAtMost").size).toBeGreaterThan(0);
});

test("the incident's four messages are labeled acknowledge, complex, and about the open work", () => {
  for (const text of [
    "The skll has been updated. Can you check again?",
    "hello?",
    "ping me back",
    "how's it going?",
  ]) {
    const fixture = turnStartFixturesV1.find(
      (candidate) => candidate.evidence.input.text === text,
    );
    expect(fixture?.expected).toMatchObject({
      acknowledge: "yes",
      complexity: "complex",
      objective: "open_work",
    });
    // Mid-work: each one arrives with work already in progress or offered.
    expect(fixture?.evidence.openWork.length).toBeGreaterThan(0);
  }
});

test("a service failure surfaces as an error rather than a low answer, without retrying", async () => {
  // The client would retry twice; the call's own policy is what stops it.
  const { client, calls } = stubClient(
    () =>
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    2,
  );
  await expect(reviewTurnStartV1(client, evidence)).rejects.toBeInstanceOf(
    APIError,
  );
  expect(calls).toHaveLength(1);
});

test("a caller's abort cancels the call", async () => {
  const { client } = stubClient(() => ok({}));
  const controller = new AbortController();
  controller.abort();
  await expect(
    reviewTurnStartV1(client, evidence, { signal: controller.signal }),
  ).rejects.toThrow();
});

test("no API key or request header reaches a saved report", async () => {
  const { client } = stubClient(() => ok({ objective: "open_work" }));
  const fixture = turnStartFixturesV1[1]!;
  const review = await reviewTurnStartV1(client, fixture.evidence);
  const report = JSON.stringify(
    turnStartReportCaseV1(fixture, {
      review,
      grade: gradeTurnStartV1(fixture.expected, review.answers),
    }),
  );
  expect(report).not.toContain(API_KEY);
  expect(report).not.toContain("authorization");
  expect(report).toContain('"requestId":"req-turn-1"');
});

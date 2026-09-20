import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import type { RoutineEventEvidenceV1 } from "@frockbot/core/contracts";
import {
  describeRoutineEventFailureV1,
  gradeRoutineEventV1,
  reviewRoutineEventV1,
  ROUTINE_EVENT_MODEL_V1,
  routineEventQuestionsV1,
  routineEventReportCaseV1,
  routineEventStateV1,
  routineEventVerdictOfV1,
  type RoutineEventAnswersV1,
  type RoutineEventFixtureV1,
} from "./routine-event.js";
import { routineEventFixturesV1 } from "./routine-event.fixtures.js";

const API_KEY = "sk-test-do-not-leak-4f3a";

const evidence: RoutineEventEvidenceV1 = {
  eventId: "evt_1",
  fireId: "rf-inbox-connect-evt_1",
  routineName: "Shipping",
  prompt: "When a shipping confirmation arrives, file the tracking number.",
  triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
  payload: { subject: "Your Amazon order has shipped" },
};

function answersFor(choice: "clearly_unrelated" | "is_or_might_be"): RoutineEventAnswersV1 {
  return {
    fit: {
      type: "choice",
      choice,
      confidence: 0.8,
      probabilities: {
        clearly_unrelated: choice === "clearly_unrelated" ? 0.85 : 0.15,
        is_or_might_be: choice === "is_or_might_be" ? 0.85 : 0.15,
      },
    },
  };
}

function fetchFor(choice: "clearly_unrelated" | "is_or_might_be"): Fetch {
  return async () =>
    new Response(
      JSON.stringify({
        model: ROUTINE_EVENT_MODEL_V1,
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: answersFor(choice),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

test("the state is only the evidence the question needs", () => {
  expect(routineEventStateV1(evidence)).toEqual({
    routineName: "Shipping",
    prompt: evidence.prompt,
    triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    payload: { subject: "Your Amazon order has shipped" },
  });
});

test("reply-style fixtures are never labeled clearly_unrelated", () => {
  for (const name of ["short-yes-reply", "re-your-order", "empty-body"]) {
    const fixture = routineEventFixturesV1.find((row) => row.name === name);
    expect(fixture, name).toBeTruthy();
    expect(fixture!.expected.fit).toBe("is_or_might_be");
  }
});

test("grades the Choice against the label", () => {
  expect(gradeRoutineEventV1({ fit: "is_or_might_be" }, answersFor("is_or_might_be")).passed).toBe(
    true,
  );
  expect(
    gradeRoutineEventV1({ fit: "clearly_unrelated" }, answersFor("is_or_might_be")).passed,
  ).toBe(false);
});

test("reviewRoutineEventV1 maps a bounded Jev answer", async () => {
  const client = new TypeSafeClient({
    apiKey: API_KEY,
    defaultModel: ROUTINE_EVENT_MODEL_V1,
    fetch: fetchFor("clearly_unrelated"),
  });
  const review = await reviewRoutineEventV1(client, evidence);
  expect(routineEventVerdictOfV1(review.answers)).toBe("clearly_unrelated");
  expect(review.model).toBe(ROUTINE_EVENT_MODEL_V1);
});

test("a report case never carries the credential", () => {
  const fixture: RoutineEventFixtureV1 = {
    name: "shipping-confirmation",
    intent: "match",
    evidence,
    expected: { fit: "is_or_might_be" },
  };
  const report = routineEventReportCaseV1(fixture, {
    failure: new Error("Jev said no"),
  });
  expect(JSON.stringify(report)).not.toContain(API_KEY);
  expect(describeRoutineEventFailureV1(new Error("down")).kind).toBe("Error");
});

import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  describeDictationCleanupFailureV1,
  dictationCleanupReportCaseV1,
  dictationCleanupStateV1,
  dictationCleanupVerdictOfV1,
  DICTATION_CLEANUP_MODEL_V1,
  gradeDictationCleanupV1,
  reviewDictationCleanupV1,
  type DictationCleanupAnswersV1,
  type DictationCleanupEvidenceV1,
  type DictationCleanupFixtureV1,
} from "./dictation-cleanup.js";
import { dictationCleanupFixturesV1 } from "./dictation-cleanup.fixtures.js";

const API_KEY = "sk-test-do-not-leak-4f3a";

const evidence: DictationCleanupEvidenceV1 = {
  raw: "um so check the Friday flights but don't book anything yet",
  tidied: "Check the Friday flights, but don't book anything yet.",
};

function answersFor(
  choice: "faithful" | "unfaithful",
): DictationCleanupAnswersV1 {
  return {
    fidelity: {
      type: "choice",
      choice,
      confidence: 0.8,
      probabilities: {
        faithful: choice === "faithful" ? 0.85 : 0.15,
        unfaithful: choice === "unfaithful" ? 0.85 : 0.15,
      },
    },
  };
}

function fetchFor(choice: "faithful" | "unfaithful"): Fetch {
  return async () =>
    new Response(
      JSON.stringify({
        model: DICTATION_CLEANUP_MODEL_V1,
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: answersFor(choice),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

test("the state is only the two texts", () => {
  expect(dictationCleanupStateV1(evidence)).toEqual({
    raw: evidence.raw,
    tidied: evidence.tidied,
  });
});

test("meaning-changing fixtures are labeled unfaithful", () => {
  for (const name of [
    "lost-negation",
    "exploratory-became-instruction",
    "summarised",
    "answered-question",
    "added-information",
    "meta-preamble",
    "code-fence",
  ]) {
    const fixture = dictationCleanupFixturesV1.find((row) => row.name === name);
    expect(fixture, name).toBeTruthy();
    expect(fixture!.expected.fidelity).toBe("unfaithful");
  }
});

test("ordinary tidies are labeled faithful", () => {
  for (const name of [
    "self-correction",
    "fillers-and-repetitions",
    "list-formatting",
    "question-stays-question",
    "one-negation-in-a-correction",
    "spoken-quotes",
  ]) {
    const fixture = dictationCleanupFixturesV1.find((row) => row.name === name);
    expect(fixture, name).toBeTruthy();
    expect(fixture!.expected.fidelity).toBe("faithful");
  }
});

test("grades the Choice against the label", () => {
  expect(
    gradeDictationCleanupV1({ fidelity: "faithful" }, answersFor("faithful"))
      .passed,
  ).toBe(true);
  expect(
    gradeDictationCleanupV1({ fidelity: "unfaithful" }, answersFor("faithful"))
      .passed,
  ).toBe(false);
});

test("reviewDictationCleanupV1 maps a bounded Jev answer", async () => {
  const client = new TypeSafeClient({
    apiKey: API_KEY,
    defaultModel: DICTATION_CLEANUP_MODEL_V1,
    fetch: fetchFor("unfaithful"),
  });
  const review = await reviewDictationCleanupV1(client, evidence);
  expect(dictationCleanupVerdictOfV1(review.answers)).toBe("unfaithful");
  expect(review.model).toBe(DICTATION_CLEANUP_MODEL_V1);
});

test("a report case never carries the credential", () => {
  const fixture: DictationCleanupFixtureV1 = {
    name: "self-correction",
    intent: "tidy",
    evidence,
    expected: { fidelity: "faithful" },
  };
  const report = dictationCleanupReportCaseV1(fixture, {
    failure: new Error("Jev said no"),
  });
  expect(JSON.stringify(report)).not.toContain(API_KEY);
  expect(describeDictationCleanupFailureV1(new Error("down")).kind).toBe(
    "Error",
  );
});

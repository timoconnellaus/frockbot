import { describe, expect, test } from "bun:test";
import { DICTATION_CLEANUP_MODEL_V1 } from "../evals/dictation-cleanup.js";
import {
  createFakeDictationCleanupJudgeV1,
  createHostedDictationCleanupJudgeV1,
  createJevDictationCleanupJudgeV1,
} from "./dictation-cleanup.js";
import { createJevClientV1 } from "./jev.js";

const evidence = {
  raw: "um so check the Friday flights but don't book anything yet",
  tidied: "Check the Friday flights, but don't book anything yet.",
};

describe("the hosted dictation-cleanup judge", () => {
  test("without a key, never returns faithful", async () => {
    const judge = createHostedDictationCleanupJudgeV1({});
    await expect(judge.review(evidence)).resolves.toBe("unavailable");
  });

  test("maps a Jev Choice onto the verdict", async () => {
    const judge = createJevDictationCleanupJudgeV1({
      client: createJevClientV1({
        apiKey: "sk-test-do-not-leak-4f3a",
        fetch: async () =>
          new Response(
            JSON.stringify({
              model: DICTATION_CLEANUP_MODEL_V1,
              usage: { input_tokens: 1, output_tokens: 1 },
              answers: {
                fidelity: {
                  type: "choice",
                  choice: "faithful",
                  confidence: 0.9,
                  probabilities: {
                    faithful: 0.9,
                    unfaithful: 0.1,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      }),
    });
    await expect(judge.review(evidence)).resolves.toBe("faithful");
  });

  test("a transport failure keeps the raw transcript", async () => {
    const judge = createJevDictationCleanupJudgeV1({
      client: createJevClientV1({
        apiKey: "sk-test-do-not-leak-4f3a",
        fetch: async () => new Response("no", { status: 503 }),
      }),
    });
    await expect(judge.review(evidence)).resolves.toBe("unavailable");
  });

  test("a fake can pin the verdict the relay will see", async () => {
    const judge = createFakeDictationCleanupJudgeV1({ verdict: "unfaithful" });
    await expect(judge.review(evidence)).resolves.toBe("unfaithful");
  });
});

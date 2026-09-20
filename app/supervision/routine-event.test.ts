import { describe, expect, test } from "bun:test";
import type { RoutineEventEvidenceV1 } from "@frockbot/core/contracts";
import { ROUTINE_EVENT_MODEL_V1 } from "../evals/routine-event.js";
import {
  createHostedRoutineEventJudgeV1,
  createJevRoutineEventJudgeV1,
} from "./routine-event.js";
import { createJevClientV1 } from "./jev.js";

const evidence: RoutineEventEvidenceV1 = {
  eventId: "evt_1",
  fireId: "rf-inbox-connect-evt_1",
  routineName: "Shipping",
  prompt: "When a shipping confirmation arrives, file the tracking number.",
  triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
  payload: { subject: "This week in design" },
};

describe("the hosted routine-event judge", () => {
  test("without a key, never returns clearly_unrelated", async () => {
    const judge = createHostedRoutineEventJudgeV1({});
    await expect(judge.classify(evidence)).resolves.toBe("is_or_might_be");
  });

  test("maps a Jev Choice onto the verdict", async () => {
    const judge = createJevRoutineEventJudgeV1({
      client: createJevClientV1({
        apiKey: "sk-test-do-not-leak-4f3a",
        fetch: async () =>
          new Response(
            JSON.stringify({
              model: ROUTINE_EVENT_MODEL_V1,
              usage: { input_tokens: 1, output_tokens: 1 },
              answers: {
                fit: {
                  type: "choice",
                  choice: "clearly_unrelated",
                  confidence: 0.9,
                  probabilities: {
                    clearly_unrelated: 0.9,
                    is_or_might_be: 0.1,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      }),
    });
    await expect(judge.classify(evidence)).resolves.toBe("clearly_unrelated");
  });

  test("a transport failure keeps the event", async () => {
    const judge = createJevRoutineEventJudgeV1({
      client: createJevClientV1({
        apiKey: "sk-test-do-not-leak-4f3a",
        fetch: async () => new Response("no", { status: 503 }),
      }),
    });
    await expect(judge.classify(evidence)).resolves.toBe("is_or_might_be");
  });
});

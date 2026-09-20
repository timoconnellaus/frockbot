import { describe, expect, test } from "bun:test";
import {
  createFakeRoutineEventJudgeV1,
  createUnavailableRoutineEventJudgeV1,
  type RoutineEventEvidenceV1,
} from "./routine-event-judge.js";

const evidence: RoutineEventEvidenceV1 = {
  eventId: "evt_1",
  fireId: "rf-inbox-connect-evt_1",
  routineName: "Shipping",
  prompt: "When a shipping confirmation arrives, file the tracking number.",
  triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
  payload: { subject: "Your order has shipped" },
};

describe("the fake RoutineEventJudge", () => {
  test("keeps every event", async () => {
    const judge = createFakeRoutineEventJudgeV1();
    await expect(judge.classify(evidence)).resolves.toBe("is_or_might_be");
  });

  test("honours an abort before it answers", async () => {
    const judge = createFakeRoutineEventJudgeV1();
    await expect(judge.classify(evidence, AbortSignal.abort())).rejects.toThrow(
      DOMException,
    );
  });

  test("lets a test replace classify", async () => {
    const judge = createFakeRoutineEventJudgeV1({
      classify: async () => "clearly_unrelated",
    });
    await expect(judge.classify(evidence)).resolves.toBe("clearly_unrelated");
  });
});

describe("the unavailable RoutineEventJudge", () => {
  test("never returns clearly_unrelated", async () => {
    const judge = createUnavailableRoutineEventJudgeV1();
    await expect(judge.classify(evidence)).resolves.toBe("is_or_might_be");
  });
});

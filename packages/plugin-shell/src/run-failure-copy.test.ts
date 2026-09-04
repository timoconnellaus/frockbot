import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import { MODEL_FIRST_BYTE_DEADLINE_REASON_V1 } from "@frockbot/kernel-contracts";
import {
  knownFailureCopyV1,
  RUN_FAILURE_COPY_V1,
  RUN_FAILURE_FALLBACK_COPY_V1,
  runFailureCopyV1,
  USER_FACING_FAILURE_REASONS_V1,
} from "./run-failure-copy.js";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import type { StoredRun } from "./backend-contracts.js";
import { projectClientRunV1 } from "./run-protocol.js";

/**
 * Words that describe the machine. Every one of them reached a chat bubble
 * before this: the verification run read "Reconciliation was explicitly
 * abandoned: Bot turn ended with outcome model-error: Flock AI keeps no durable
 * copy of an interrupted response, so it cannot be recovered".
 */
const FORBIDDEN_V1 = [
  "reconcil",
  "outcome",
  "durable",
  "supersede",
  "admission",
  "provider",
  "model-error",
  "tool-error",
  "turn/end",
  "session event",
  "run id",
  "runid",
];

function assertPlainV1(copy: string): void {
  const lowered = copy.toLowerCase();
  for (const word of FORBIDDEN_V1) {
    expect(lowered.includes(word)).toBe(false);
  }
  // A bare " run " is jargon; "running" and the like are not, so the check is
  // on the word rather than the substring.
  expect(/\brun(s|id)?\b/.test(lowered)).toBe(false);
}

const TIMESTAMP = "2026-09-04T00:00:00.000Z";
let seq = 0;
const turnEnd = (outcome: string) =>
  ({
    type: "turn/end",
    turn: 1,
    outcome,
    seq: (seq += 1),
    timestamp: TIMESTAMP,
  }) as unknown as SessionEvent;

function failedRun(failure: string, events: SessionEvent[]): StoredRun {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint",
    sessionId: "user:primary",
    acceptedAt: TIMESTAMP,
    input: "make me an applet",
    events,
    effectAdmissions: [],
    status: "failed",
    phase: "executing",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: initializeBotSettingsV1("primary"),
    previousEventCount: 0,
    failure,
  };
}

describe("runFailureCopyV1", () => {
  test("every mapped sentence is written for a person", () => {
    for (const copy of Object.values(RUN_FAILURE_COPY_V1)) assertPlainV1(copy);
    assertPlainV1(RUN_FAILURE_FALLBACK_COPY_V1);
    for (const reason of USER_FACING_FAILURE_REASONS_V1) assertPlainV1(reason);
  });

  test("the stored diagnostic never reaches the copy", () => {
    const failure =
      "Reconciliation was explicitly abandoned: Bot turn ended with outcome model-error: Flock AI keeps no durable copy of an interrupted response, so it cannot be recovered";
    const copy = runFailureCopyV1({
      failure,
      events: [turnEnd("interrupted")],
    });
    expect(copy).toBe(RUN_FAILURE_COPY_V1.interrupted);
    assertPlainV1(copy);
  });

  test("a kernel sentence written for a person survives its wrapper", () => {
    const copy = runFailureCopyV1({
      failure: `Model request "abc" has no durable provider outcome: Model response outcome is uncertain: ${MODEL_FIRST_BYTE_DEADLINE_REASON_V1}`,
      events: [turnEnd("interrupted")],
    });
    expect(copy).toBe(MODEL_FIRST_BYTE_DEADLINE_REASON_V1);
  });

  test("a Turn with no terminal event still says something plain", () => {
    expect(runFailureCopyV1({ failure: "boom" })).toBe(
      RUN_FAILURE_FALLBACK_COPY_V1,
    );
  });

  // The client's own guard, because a `ClientRun` can arrive from an older
  // backend that forwarded the raw diagnostic, and the thread must not render
  // a provider's words as though the Bot said them.
  test("the thread accepts only sentences the product wrote", () => {
    for (const written of [
      ...Object.values(RUN_FAILURE_COPY_V1),
      ...USER_FACING_FAILURE_REASONS_V1,
    ]) {
      expect(knownFailureCopyV1(written)).toBe(written);
    }
    for (const diagnostic of [
      undefined,
      "",
      "Provider reconciliation is required",
      "Bot turn ended with outcome model-error: Model request failed (401)",
      'Skill "bot/no-such-skill" is unknown',
    ]) {
      const copy = knownFailureCopyV1(diagnostic);
      expect(copy).toBe(RUN_FAILURE_FALLBACK_COPY_V1);
      assertPlainV1(copy);
    }
  });

  test("the projection sends the copy, not the diagnostic", () => {
    const projected = projectClientRunV1(
      failedRun(
        "Reconciliation was explicitly abandoned: Bot turn ended with outcome model-error",
        [
          {
            type: "turn/start",
            turn: 1,
            seq: (seq += 1),
            timestamp: TIMESTAMP,
          } as unknown as SessionEvent,
          turnEnd("interrupted"),
        ],
      ),
    );
    expect(projected.outcome?.type).toBe("failed");
    if (projected.outcome?.type !== "failed") throw new Error("unreachable");
    assertPlainV1(projected.outcome.message);
    expect(projected.outcome.message).toBe(RUN_FAILURE_COPY_V1.interrupted);
  });
});

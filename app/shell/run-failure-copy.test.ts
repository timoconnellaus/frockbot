import { STEP_LIMIT_REASON_V1 } from "@frockbot/core/agent-loop";
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import { MODEL_FIRST_BYTE_DEADLINE_REASON_V1 } from "@frockbot/core/contracts";
import {
  CLIENT_VERSION_DEGRADED_MESSAGE_V1,
  failureNoticeV1,
  knownFailureCopyV1,
  MODEL_PROVIDER_FAILURE_COPY_V1,
  RUN_FAILURE_COPY_V1,
  RUN_FAILURE_FALLBACK_COPY_V1,
  runFailureCopyV1,
  USER_FACING_FAILURE_REASONS_V1,
} from "./run-failure-copy.js";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import type { StoredRun } from "./backend-contracts.js";
import { projectClientRunV1 } from "./run-protocol.js";

/**
 * Words that describe the machine. Every one of them reached a chat bubble
 * before this: the verification run read "Bot turn ended with outcome
 * model-error: Flock AI keeps no durable copy of an interrupted response, so
 * it cannot be recovered".
 */
const FORBIDDEN_V1 = [
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
    expect(Object.keys(MODEL_PROVIDER_FAILURE_COPY_V1).sort()).toEqual([
      "permanent",
      "transient",
      "unknown",
    ]);
    for (const copy of Object.values(MODEL_PROVIDER_FAILURE_COPY_V1)) {
      assertPlainV1(copy);
    }
    assertPlainV1(RUN_FAILURE_FALLBACK_COPY_V1);
    for (const reason of USER_FACING_FAILURE_REASONS_V1) assertPlainV1(reason);
  });

  test("the stored diagnostic never reaches the copy", () => {
    const failure =
      "Bot turn ended with outcome model-error: Flock AI keeps no durable copy of an interrupted response, so it cannot be recovered";
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
      CLIENT_VERSION_DEGRADED_MESSAGE_V1,
    ]) {
      expect(knownFailureCopyV1(written)).toBe(written);
    }
    for (const diagnostic of [
      undefined,
      "",
      'Model request "abc" has no durable provider outcome',
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
      failedRun("Bot turn ended with outcome model-error", [
        {
          type: "turn/start",
          turn: 1,
          seq: (seq += 1),
          timestamp: TIMESTAMP,
        } as unknown as SessionEvent,
        turnEnd("interrupted"),
      ]),
    );
    expect(projected.outcome?.type).toBe("failed");
    if (projected.outcome?.type !== "failed") throw new Error("unreachable");
    assertPlainV1(projected.outcome.message);
    expect(projected.outcome.message).toBe(RUN_FAILURE_COPY_V1.interrupted);
  });

  // A firing that broke before it could speak is told to the person as an
  // ordinary message, and the run is projected with that message in place of
  // the send it never journalled. The client would otherwise draw the outcome's
  // generic line under it as well — the same event, said twice — so the send
  // says what it stands for.
  test("says the failure once when it was already sent as a message", () => {
    const said = '"Morning brief" did not run: something plain';
    const projected = projectClientRunV1(
      failedRun("the firing's run is superseded", [turnEnd("interrupted")]),
      { ordinal: 0, text: said },
    );
    const sends = projected.events.filter(
      (event) => event.type === "send/to-user",
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      ordinal: 0,
      payload: { type: "text", text: said },
    });
    // The notice is the message, word for word, which is what lets the thread
    // draw the two as the one event. The run is still failed: the status is
    // durable and is not softened.
    expect(projected.outcome).toEqual({ type: "failed", message: said });
    expect(projected.status).toBe("failed");
  });

  // Only when there is a message to repeat. A Turn that spoke and then broke
  // still says why it stopped, in the product's own words.
  test("still says why an ordinary reply broke", () => {
    const projected = projectClientRunV1(
      failedRun("Bot turn ended with outcome interrupted", [
        {
          type: "send/to-user",
          seq: (seq += 1),
          timestamp: TIMESTAMP,
          turn: 1,
          step: 1,
          occurrenceId: "send:1",
          payload: { type: "text", text: "Half an answer" },
        } as unknown as SessionEvent,
        turnEnd("interrupted"),
      ]),
    );
    expect(projected.outcome).toMatchObject({
      type: "failed",
      message: RUN_FAILURE_COPY_V1.interrupted,
    });
  });
});

test("a reply that ran out of steps says so in plain words", () => {
  // `core/durable` wraps the loop's reason; the sentence survives the wrapper.
  expect(
    runFailureCopyV1({
      failure: `Bot turn ended with outcome interrupted: ${STEP_LIMIT_REASON_V1}`,
    }),
  ).toBe(STEP_LIMIT_REASON_V1);
  expect(knownFailureCopyV1(STEP_LIMIT_REASON_V1)).toBe(STEP_LIMIT_REASON_V1);
});

describe("the retry a failure offers", () => {
  test("takes the invitation off the sentence a retry can repair", () => {
    expect(failureNoticeV1(RUN_FAILURE_COPY_V1.interrupted)).toEqual({
      notice: "This reply stopped before it finished.",
      retry: true,
    });
    expect(failureNoticeV1(RUN_FAILURE_FALLBACK_COPY_V1)).toEqual({
      notice: "This Bot couldn't finish its reply.",
      retry: true,
    });
  });

  // Sending the same message again does not un-stop a Turn the person stopped,
  // and it does not talk a Bot out of declining. Both keep their whole sentence
  // and offer nothing to press.
  test("offers nothing where trying again is not the way out", () => {
    expect(failureNoticeV1(RUN_FAILURE_COPY_V1.cancelled)).toEqual({
      notice: "You stopped this.",
      retry: false,
    });
    expect(failureNoticeV1(RUN_FAILURE_COPY_V1.blocked)).toEqual({
      notice: RUN_FAILURE_COPY_V1.blocked,
      retry: false,
    });
  });
});

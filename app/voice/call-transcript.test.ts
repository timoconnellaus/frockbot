import { describe, expect, test } from "bun:test";
import {
  VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1,
  VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1,
  voiceCallTranscriptTurnsV1,
} from "./call-transcript.js";
import type { VoiceTurnRecordV1 } from "./ledger.js";

function turn(
  transcript: string,
  extra: Partial<VoiceTurnRecordV1> = {},
): VoiceTurnRecordV1 {
  return {
    schemaVersion: 1,
    turnId: extra.turnId ?? "call-1:1",
    callId: "call-1",
    key: "voice-turn:user:call-1:1",
    transcript,
    admittedAt: "2026-09-21T00:00:00.000Z",
    state: extra.state ?? "answered",
    delegations: 0,
    ...extra,
  };
}

describe("voiceCallTranscriptTurnsV1", () => {
  test("keeps spoken pairs and drops empty utterances", () => {
    expect(
      voiceCallTranscriptTurnsV1([
        turn("   "),
        turn("plan my week", { answer: "On it." }),
        turn("", { answer: "Still here." }),
        turn("thanks", { state: "abandoned" }),
      ]),
    ).toEqual([
      { transcript: "plan my week", answer: "On it." },
      { transcript: "", answer: "Still here." },
      { transcript: "thanks" },
    ]);
  });

  test("clips from the front of a long call and bounds each line", () => {
    const turns = Array.from(
      { length: VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1 + 3 },
      (_, i) => turn(`turn ${i}`, { turnId: `call-1:${i + 1}`, answer: "ok" }),
    );
    const spoken = voiceCallTranscriptTurnsV1(turns);
    expect(spoken).toHaveLength(VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1);
    expect(spoken[0]?.transcript).toBe("turn 3");
    expect(spoken.at(-1)?.transcript).toBe(
      `turn ${VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1 + 2}`,
    );

    const long = "x".repeat(VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1 + 40);
    expect(voiceCallTranscriptTurnsV1([turn(long, { answer: long })])).toEqual([
      {
        transcript: "x".repeat(VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1),
        answer: "x".repeat(VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1),
      },
    ]);
  });
});

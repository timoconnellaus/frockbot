import { describe, expect, test } from "bun:test";
import {
  VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1,
  VOICE_ASSISTANT_OPENING_DEADLINE_MS_V1,
} from "./shared.js";
import {
  decodeVoiceAssistantPcmEnvelopeV1,
  decideVoicePcmSequenceV1,
  encodeVoiceAssistantPcmEnvelopeV1,
  isVoiceAttemptIdV1,
  voiceAssistantOpeningBudgetBytesV1,
  voiceAttemptIdBytesV1,
  voiceAttemptIdFromBytesV1,
  voiceSetupFingerprintV1,
  VOICE_ASSISTANT_PCM_HEADER_BYTES_V1,
} from "./opening.js";
import {
  decodeVoiceAssistantClientMessageV1,
  decodeVoiceAssistantServerFrameV1,
} from "./shared.js";

const ATTEMPT = "2e780bb8-b4e9-42af-a9bc-f3f6aaf37070";

describe("opening budget", () => {
  test("ten seconds of 16 kHz PCM16 is 320,000 bytes, from the format", () => {
    expect(voiceAssistantOpeningBudgetBytesV1()).toBe(320_000);
    expect(VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1).toBe(320_000);
    expect(VOICE_ASSISTANT_OPENING_DEADLINE_MS_V1).toBe(10_000);
  });
});

describe("attempt ids", () => {
  test("round-trip the raw UUID bytes", () => {
    const bytes = voiceAttemptIdBytesV1(ATTEMPT);
    expect(bytes?.byteLength).toBe(16);
    expect(voiceAttemptIdFromBytesV1(bytes!)).toBe(ATTEMPT);
    expect(isVoiceAttemptIdV1("not-a-uuid")).toBe(false);
    expect(voiceAttemptIdBytesV1("not-a-uuid")).toBeUndefined();
  });
});

describe("pcm envelope", () => {
  test("encodes version, attempt, little-endian sequence, then pcm", () => {
    const pcm = new Uint8Array([1, 0, 2, 0]);
    const frame = encodeVoiceAssistantPcmEnvelopeV1({
      attemptId: ATTEMPT,
      sequence: 0x01020304,
      pcm,
    });
    expect(frame.byteLength).toBe(VOICE_ASSISTANT_PCM_HEADER_BYTES_V1 + 4);
    expect(frame[0]).toBe(1);
    expect(frame[17]).toBe(0x04);
    expect(frame[18]).toBe(0x03);
    expect(frame[19]).toBe(0x02);
    expect(frame[20]).toBe(0x01);
    expect([...frame.subarray(21)]).toEqual([1, 0, 2, 0]);
    expect(decodeVoiceAssistantPcmEnvelopeV1(frame)).toEqual({
      version: 1,
      attemptId: ATTEMPT,
      sequence: 0x01020304,
      pcm,
    });
  });

  test("refuses a short frame, a wrong version, or odd pcm", () => {
    expect(
      decodeVoiceAssistantPcmEnvelopeV1(new Uint8Array(20)),
    ).toBeUndefined();
    const frame = encodeVoiceAssistantPcmEnvelopeV1({
      attemptId: ATTEMPT,
      sequence: 0,
      pcm: new Uint8Array([1, 0]),
    });
    frame[0] = 2;
    expect(decodeVoiceAssistantPcmEnvelopeV1(frame)).toBeUndefined();
    expect(() =>
      encodeVoiceAssistantPcmEnvelopeV1({
        attemptId: ATTEMPT,
        sequence: 0,
        pcm: new Uint8Array([1]),
      }),
    ).toThrow(/misaligned/);
  });
});

describe("pcm sequence", () => {
  test("accepts 0 first, drops duplicates, and names a gap", () => {
    expect(decideVoicePcmSequenceV1(undefined, 0)).toEqual({
      kind: "accept",
      sequence: 0,
    });
    expect(decideVoicePcmSequenceV1(undefined, 2)).toEqual({
      kind: "gap",
      sequence: 2,
    });
    expect(decideVoicePcmSequenceV1(3, 3)).toEqual({ kind: "drop" });
    expect(decideVoicePcmSequenceV1(3, 2)).toEqual({ kind: "drop" });
    expect(decideVoicePcmSequenceV1(3, 4)).toEqual({
      kind: "accept",
      sequence: 4,
    });
    expect(decideVoicePcmSequenceV1(3, 6)).toEqual({
      kind: "gap",
      sequence: 6,
    });
  });
});

describe("setup fingerprint", () => {
  test("is stable for semantic identity and moves when memory is forgotten", async () => {
    const base = {
      botId: "bot-1",
      model: "models/gemini-3.8-live",
      voiceName: "Puck",
      tools: ["subagent", "googleSearch"],
      googleSearch: true,
      memoryIdentity: "fact-a|",
    };
    const first = await voiceSetupFingerprintV1(base);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await voiceSetupFingerprintV1({
        ...base,
        tools: ["googleSearch", "subagent"],
      }),
    ).toBe(first);
    expect(
      await voiceSetupFingerprintV1({
        ...base,
        memoryIdentity: "fact-a|fact-a",
      }),
    ).not.toBe(first);
  });
});

describe("opening protocol", () => {
  test("voice/open carries the attempt, the mode and pause/mute together", () => {
    expect(
      decodeVoiceAssistantClientMessageV1({
        schemaVersion: 1,
        type: "voice/open",
        attemptId: ATTEMPT,
        mode: "start",
        botId: "bot-1",
        paused: false,
        muted: true,
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "voice/open",
      attemptId: ATTEMPT,
      mode: "start",
      botId: "bot-1",
      paused: false,
      muted: true,
    });
    expect(
      decodeVoiceAssistantClientMessageV1({
        schemaVersion: 1,
        type: "voice/open",
        attemptId: "not-a-uuid",
        mode: "start",
        paused: false,
        muted: false,
      }),
    ).toBeUndefined();
  });

  test("voice/control and the server's ack, ready and failure decode", () => {
    expect(
      decodeVoiceAssistantClientMessageV1({
        schemaVersion: 1,
        type: "voice/control",
        attemptId: ATTEMPT,
        sequence: 2,
        action: "mute",
        muted: true,
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "voice/control",
      attemptId: ATTEMPT,
      sequence: 2,
      action: "mute",
      muted: true,
    });
    expect(
      decodeVoiceAssistantServerFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "voice/admitted",
          attemptId: ATTEMPT,
          callId: "call-1",
          paused: true,
          muted: false,
        }),
      ),
    ).toEqual({
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/admitted",
        attemptId: ATTEMPT,
        callId: "call-1",
        paused: true,
        muted: false,
      },
    });
    expect(
      decodeVoiceAssistantServerFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "voice/ready",
          attemptId: ATTEMPT,
          callId: "call-1",
        }),
      ),
    ).toEqual({
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/ready",
        attemptId: ATTEMPT,
        callId: "call-1",
      },
    });
    expect(
      decodeVoiceAssistantServerFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "voice/open-failed",
          attemptId: ATTEMPT,
          code: "timeout",
        }),
      ),
    ).toEqual({
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/open-failed",
        attemptId: ATTEMPT,
        code: "timeout",
      },
    });
    expect(
      decodeVoiceAssistantServerFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "voice/control-ack",
          attemptId: ATTEMPT,
          sequence: 2,
        }),
      ),
    ).toEqual({
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/control-ack",
        attemptId: ATTEMPT,
        sequence: 2,
      },
    });
  });

  test("retired admission frames are no longer a client message", () => {
    expect(
      decodeVoiceAssistantClientMessageV1({
        schemaVersion: 1,
        type: "voice/wake",
      }),
    ).toBeUndefined();
    expect(
      decodeVoiceAssistantClientMessageV1({
        schemaVersion: 1,
        type: "voice/mute",
        muted: true,
      }),
    ).toBeUndefined();
  });
});

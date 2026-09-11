import { describe, expect, test } from "bun:test";
import {
  translateVoiceDictationUpstreamFrameV1,
  voiceDictationAppendV1,
  voiceDictationConfiguredV1,
  voiceDictationSessionUpdateV1,
  voiceDictationUpstreamTargetV1,
  VOICE_DICTATION_MODEL_V1,
} from "./dictation-upstream.js";
import {
  decodeVoiceAssistantClientMessageV1,
  decodeVoiceAssistantServerFrameV1,
  decodeVoiceDictationClientFrameV1,
  decodeVoiceDictationServerFrameV1,
} from "./shared.js";

describe("the dictation upstream", () => {
  test("takes the direct OpenAI path when a key is present, else says so", () => {
    expect(voiceDictationUpstreamTargetV1({})).toMatchObject({
      path: "unconfigured",
    });
    expect(voiceDictationConfiguredV1({})).toBe(false);
    const openai = voiceDictationUpstreamTargetV1({ OPENAI_API_KEY: "sk-x" });
    expect(openai).toMatchObject({
      path: "openai",
      url: "wss://api.openai.com/v1/realtime?intent=transcription",
      headers: { authorization: "Bearer sk-x" },
    });
    expect(
      voiceDictationUpstreamTargetV1({
        OPENAI_API_KEY: "sk-x",
        VOICE_DICTATION_UPSTREAM_URL: "ws://127.0.0.1:1/fake",
      }),
    ).toMatchObject({ path: "override", url: "ws://127.0.0.1:1/fake" });
  });

  test("configures a transcription session at 24 kHz with server VAD", () => {
    const update = voiceDictationSessionUpdateV1() as {
      type: string;
      session: { type: string; audio: { input: Record<string, unknown> } };
    };
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("transcription");
    expect(update.session.audio.input.format).toEqual({
      type: "audio/pcm",
      rate: 24000,
    });
    expect(update.session.audio.input.transcription).toEqual({
      model: VOICE_DICTATION_MODEL_V1,
    });
    expect(update.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
    });
  });

  test("appends audio as base64 PCM", () => {
    const frame = JSON.parse(
      voiceDictationAppendV1(new Uint8Array([0, 1, 2, 255]).buffer),
    ) as { type: string; audio: string };
    expect(frame.type).toBe("input_audio_buffer.append");
    expect([...atob(frame.audio)].map((c) => c.charCodeAt(0))).toEqual([
      0, 1, 2, 255,
    ]);
  });

  test("translates deltas, commits, completions, failures and errors by item", () => {
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "item_1",
          delta: "hel",
        }),
      ),
    ).toEqual({ kind: "delta", text: "hel", itemId: "item_1" });
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({
          type: "input_audio_buffer.committed",
          item_id: "item_1",
        }),
      ),
    ).toEqual({ kind: "committed", itemId: "item_1" });
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_1",
          transcript: " hello there ",
        }),
      ),
    ).toEqual({ kind: "completed", text: "hello there", itemId: "item_1" });
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.failed",
          item_id: "item_2",
          error: { message: "too noisy" },
        }),
      ),
    ).toEqual({ kind: "failed", message: "too noisy", itemId: "item_2" });
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({ type: "error", error: { message: "bad key" } }),
      ),
    ).toEqual({ kind: "error", message: "bad key", emptyBuffer: false });
    // The one refusal that is not a failure after stop: nothing to commit.
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({
          type: "error",
          error: {
            code: "input_audio_buffer_commit_empty",
            message:
              "Error committing input audio buffer: the buffer is empty.",
          },
        }),
      ),
    ).toMatchObject({ kind: "error", emptyBuffer: true });
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({
          type: "error",
          error: { message: "buffer too small. Expected at least 100ms" },
        }),
      ),
    ).toMatchObject({ kind: "error", emptyBuffer: true });
    expect(
      translateVoiceDictationUpstreamFrameV1(
        JSON.stringify({ type: "session.updated" }),
      ),
    ).toEqual({ kind: "session-updated" });
    expect(translateVoiceDictationUpstreamFrameV1("{")).toBeUndefined();
  });
});

describe("the shared voice frames", () => {
  test("dictation client frames are exact", () => {
    expect(
      decodeVoiceDictationClientFrameV1({
        schemaVersion: 1,
        type: "start",
        sampleRate: 24000,
      }),
    ).toEqual({ schemaVersion: 1, type: "start", sampleRate: 24000 });
    expect(() =>
      decodeVoiceDictationClientFrameV1({
        schemaVersion: 1,
        type: "start",
        sampleRate: 16000,
      }),
    ).toThrow();
    expect(() =>
      decodeVoiceDictationClientFrameV1({ schemaVersion: 2, type: "stop" }),
    ).toThrow();
  });

  test("dictation server frames round-trip", () => {
    for (const frame of [{ schemaVersion: 1, type: "ready" }] as unknown[]) {
      expect(decodeVoiceDictationServerFrameV1(frame)).toEqual(
        frame as ReturnType<typeof decodeVoiceDictationServerFrameV1>,
      );
    }
    for (const frame of [
      { schemaVersion: 1, type: "delta", text: "a" },
      { schemaVersion: 1, type: "segment", text: "b" },
      { schemaVersion: 1, type: "final" },
      { schemaVersion: 1, type: "notice", message: "m" },
      { schemaVersion: 1, type: "error", message: "e", code: "upstream" },
    ] as unknown[]) {
      expect(decodeVoiceDictationServerFrameV1(frame)).toEqual(
        frame as ReturnType<typeof decodeVoiceDictationServerFrameV1>,
      );
    }
    expect(
      decodeVoiceDictationServerFrameV1({
        schemaVersion: 1,
        type: "error",
        message: "e",
        code: "weird",
      }),
    ).toEqual({ schemaVersion: 1, type: "error", message: "e" });
  });

  test("assistant custom messages decode, and the SDK's pass through", () => {
    expect(
      decodeVoiceAssistantClientMessageV1({
        schemaVersion: 1,
        type: "voice/mute",
        muted: true,
      }),
    ).toEqual({ schemaVersion: 1, type: "voice/mute", muted: true });
    expect(
      decodeVoiceAssistantClientMessageV1({ type: "hello" }),
    ).toBeUndefined();
    expect(
      decodeVoiceAssistantServerFrameV1(
        JSON.stringify({ type: "status", status: "speaking" }),
      ),
    ).toEqual({ kind: "sdk", message: { type: "status", status: "speaking" } });
    expect(
      decodeVoiceAssistantServerFrameV1(
        JSON.stringify({
          type: "voice/refusal",
          schemaVersion: 1,
          code: "exclusive",
          message: "busy",
        }),
      ),
    ).toEqual({
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/refusal",
        code: "exclusive",
        message: "busy",
      },
    });
    expect(
      decodeVoiceAssistantServerFrameV1(JSON.stringify({ type: "mystery" })),
    ).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  decodeVoiceDictationClientFrameV1,
  decodeVoiceDictationServerFrameV1,
} from "@frockbot/protocol";
import {
  translateVoiceUpstreamFrameV1,
  voiceUpstreamSessionUpdateV1,
  voiceUpstreamTargetV1,
  VOICE_TRANSCRIPTION_MODEL_V1,
} from "./voice-upstream.js";

describe("which upstream dictation opens", () => {
  test("takes the direct OpenAI path when the deployment holds a key", () => {
    const target = voiceUpstreamTargetV1({
      OPENAI_API_KEY: "sk-test",
      FROCK_AI_GATEWAY_TOKEN: "gateway",
      FROCK_AI_ACCOUNT_ID: "account",
    });
    expect(target.path).toBe("openai");
    expect(target.path !== "unconfigured" && target.url).toBe(
      `wss://api.openai.com/v1/realtime?model=${VOICE_TRANSCRIPTION_MODEL_V1}`,
    );
    expect(target.path !== "unconfigured" && target.headers).not.toHaveProperty(
      "openai-beta",
    );
    expect(
      target.path !== "unconfigured" && target.headers["authorization"],
    ).toBe("Bearer sk-test");
  });

  test("falls back to the AI Gateway's BYOK key when there is no direct key", () => {
    const target = voiceUpstreamTargetV1({
      FROCK_AI_GATEWAY_TOKEN: "gateway",
      FROCK_AI_ACCOUNT_ID: "account",
      FROCK_AI_GATEWAY_ID: "flock",
    });
    expect(target.path).toBe("gateway");
    expect(target.path !== "unconfigured" && target.url).toBe(
      `wss://gateway.ai.cloudflare.com/v1/account/flock/openai?model=${VOICE_TRANSCRIPTION_MODEL_V1}`,
    );
    expect(target.path !== "unconfigured" && target.headers).not.toHaveProperty(
      "openai-beta",
    );
    expect(
      target.path !== "unconfigured" && target.headers["cf-aig-authorization"],
    ).toBe("Bearer gateway");
  });

  test("still reads the pre-rename FLOCK_AI_* names", () => {
    const target = voiceUpstreamTargetV1({
      FLOCK_AI_GATEWAY_TOKEN: "gateway",
      FLOCK_AI_ACCOUNT_ID: "account",
    });
    expect(target.path).toBe("gateway");
    expect(target.path !== "unconfigured" && target.url).toContain("/flock/");
  });

  test("says so in plain English when nothing is configured", () => {
    const target = voiceUpstreamTargetV1({});
    expect(target.path).toBe("unconfigured");
    expect(target.path === "unconfigured" && target.message).toContain(
      "Type your message",
    );
  });

  test("a local stand-in overrides both, so the harness needs no credential", () => {
    const target = voiceUpstreamTargetV1({
      VOICE_UPSTREAM_URL: "ws://127.0.0.1:9000/v1/realtime",
      OPENAI_API_KEY: "sk-test",
    });
    expect(target.path).toBe("override");
    expect(target.path !== "unconfigured" && target.headers).toEqual({});
  });
});

describe("what the upstream is told", () => {
  test("opens a transcription session on the streaming model", () => {
    const update = voiceUpstreamSessionUpdateV1();
    expect(update).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-live-transcribe" },
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 500,
            },
          },
        },
      },
    });
  });
});

describe("translating the upstream's frames", () => {
  test("a delta becomes text to append", () => {
    const translated = translateVoiceUpstreamFrameV1(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hello ",
      }),
    );
    expect(translated?.frame).toEqual({
      schemaVersion: 1,
      type: "delta",
      text: "hello ",
    });
    expect(translated?.completed).toBeUndefined();
  });

  test("a completed transcript replaces the segment and releases a commit", () => {
    const translated = translateVoiceUpstreamFrameV1(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hello there.",
      }),
    );
    expect(translated?.frame).toEqual({
      schemaVersion: 1,
      type: "transcript",
      text: "Hello there.",
    });
    expect(translated?.completed).toBe(true);
  });

  test("an upstream error keeps provider detail out of the user-visible sentence", () => {
    const translated = translateVoiceUpstreamFrameV1(
      JSON.stringify({ type: "error", error: { message: "model not found" } }),
    );
    expect(translated?.frame).toEqual({
      schemaVersion: 1,
      type: "error",
      message:
        "Dictation stopped: the speech service refused the connection. Try again.",
    });
    expect(translated?.upstreamError).toBe("model not found");
  });

  test("everything else — and anything unparseable — is dropped", () => {
    expect(
      translateVoiceUpstreamFrameV1(
        JSON.stringify({ type: "transcription_session.updated" }),
      ),
    ).toBeUndefined();
    expect(translateVoiceUpstreamFrameV1("not json")).toBeUndefined();
    expect(
      translateVoiceUpstreamFrameV1(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta: "",
        }),
      ),
    ).toBeUndefined();
  });

  test("every frame it produces is one the client's decoder accepts", () => {
    for (const raw of [
      { type: "conversation.item.input_audio_transcription.delta", delta: "a" },
      {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "A.",
      },
      { type: "error", error: { message: "no" } },
    ]) {
      const translated = translateVoiceUpstreamFrameV1(JSON.stringify(raw));
      expect(
        decodeVoiceDictationServerFrameV1(
          JSON.parse(JSON.stringify(translated?.frame)),
        ),
      ).toEqual(translated!.frame);
    }
  });
});

describe("the client's half of the protocol", () => {
  test("accepts the two controls the composer sends and nothing else", () => {
    expect(
      decodeVoiceDictationClientFrameV1({ schemaVersion: 1, type: "commit" }),
    ).toEqual({ schemaVersion: 1, type: "commit" });
    expect(
      decodeVoiceDictationClientFrameV1({ schemaVersion: 1, type: "cancel" }),
    ).toEqual({ schemaVersion: 1, type: "cancel" });
    expect(() =>
      decodeVoiceDictationClientFrameV1({ schemaVersion: 1, type: "audio" }),
    ).toThrow();
    expect(() =>
      decodeVoiceDictationClientFrameV1({ schemaVersion: 2, type: "commit" }),
    ).toThrow();
  });

  test("refuses a delta long enough to run away with a draft", () => {
    expect(() =>
      decodeVoiceDictationServerFrameV1({
        schemaVersion: 1,
        type: "delta",
        text: "x".repeat(9_000),
      }),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { GEMINI_VOICES_V1 } from "./appearance.ts";
import { encodeGeminiBase64V1 } from "./gemini-live.ts";
import {
  buildGeminiTtsPreviewRequestV1,
  GeminiTtsPreviewError,
  pcmToWavV1,
  retryDelayFromTtsErrorV1,
  voicePreviewAssetV1,
  VOICE_PREVIEW_LINE_V1,
  VOICE_PREVIEW_SAMPLE_RATE_V1,
  wavFromGeminiTtsResponseV1,
  wavToPcmV1,
} from "./preview.ts";

describe("the TTS preview request", () => {
  test("recites the same line in Live's speechConfig shape", () => {
    const body = buildGeminiTtsPreviewRequestV1("Iapetus");
    expect(body).toEqual({
      contents: [{ parts: [{ text: VOICE_PREVIEW_LINE_V1 }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Iapetus" },
          },
        },
      },
    });
  });

  test("names a clip after the voice, under the native assets folder", () => {
    expect(voicePreviewAssetV1("Sulafat")).toBe("assets/voices/Sulafat.wav");
    expect(new Set(GEMINI_VOICES_V1.map((voice) => voice.voiceName)).size).toBe(
      30,
    );
  });
});

describe("WAV round-trip", () => {
  test("wraps PCM16 and reads it back with the rate", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wav = pcmToWavV1(pcm, 16_000);
    expect(wavToPcmV1(wav)).toEqual({ pcm, sampleRate: 16_000 });
    expect(wavToPcmV1(pcm)).toBeNull();
  });
});

describe("wavFromGeminiTtsResponseV1", () => {
  test("wraps raw L16 from the documented generateContent shape", () => {
    const pcm = new Uint8Array([9, 8, 7, 6]);
    const wav = wavFromGeminiTtsResponseV1({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/L16;codec=pcm;rate=24000",
                  data: encodeGeminiBase64V1(pcm),
                },
              },
            ],
          },
        },
      ],
    });
    expect(wavToPcmV1(wav)).toEqual({
      pcm,
      sampleRate: VOICE_PREVIEW_SAMPLE_RATE_V1,
    });
  });

  test("passes through a WAV the model already wrapped", () => {
    const pcm = new Uint8Array([4, 3, 2, 1]);
    const original = pcmToWavV1(pcm, 12_000);
    const wav = wavFromGeminiTtsResponseV1({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: encodeGeminiBase64V1(original),
                },
              },
            ],
          },
        },
      ],
    });
    expect(wavToPcmV1(wav)).toEqual({ pcm, sampleRate: 12_000 });
  });

  test("surfaces the model's error message, not a missing-part guess", () => {
    expect(() =>
      wavFromGeminiTtsResponseV1({
        error: { message: "model is overloaded", status: "UNAVAILABLE" },
      }),
    ).toThrow(new GeminiTtsPreviewError("model is overloaded"));
  });

  test("reads the free-tier retry window out of a 429", () => {
    expect(
      retryDelayFromTtsErrorV1({
        status: 429,
        message: "Please retry in 58.048481896s.",
      }),
    ).toBe(58_049);
    expect(
      retryDelayFromTtsErrorV1({
        status: 429,
        message: "quota",
        retryAfter: "12",
      }),
    ).toBe(12_000);
    expect(
      retryDelayFromTtsErrorV1({ status: 500, message: "retry in 1s" }),
    ).toBe(undefined);
  });

  test("refuses a payload with no audio", () => {
    expect(() => wavFromGeminiTtsResponseV1({ candidates: [{}] })).toThrow(
      GeminiTtsPreviewError,
    );
  });
});

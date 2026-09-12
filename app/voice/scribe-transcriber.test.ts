import { describe, expect, test } from "bun:test";
import {
  VOICE_ASSISTANT_SCRIBE_OPTIONS_V1,
  voiceAssistantSttKeyV1,
  voiceAssistantSttProviderV1,
} from "./scribe-transcriber.js";
import { VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 } from "./shared.js";

describe("the assistant's choice of ears", () => {
  test("listens through Scribe unless told otherwise", () => {
    expect(voiceAssistantSttProviderV1({})).toBe("scribe");
    expect(voiceAssistantSttProviderV1({ VOICE_ASSISTANT_STT: "" })).toBe(
      "scribe",
    );
    expect(
      voiceAssistantSttProviderV1({ VOICE_ASSISTANT_STT: "whisper" }),
    ).toBe("scribe");
    expect(
      voiceAssistantSttProviderV1({ VOICE_ASSISTANT_STT: " OpenAI " }),
    ).toBe("scribe");
    expect(voiceAssistantSttProviderV1({ VOICE_ASSISTANT_STT: "openai" })).toBe(
      "openai",
    );
  });

  test("the key follows the provider", () => {
    const env = { OPENAI_API_KEY: " o ", ELEVENLABS_API_KEY: " e " };
    expect(voiceAssistantSttKeyV1(env)).toBe("e");
    expect(
      voiceAssistantSttKeyV1({ ...env, VOICE_ASSISTANT_STT: "openai" }),
    ).toBe("o");
    expect(voiceAssistantSttKeyV1({ OPENAI_API_KEY: "o" })).toBeUndefined();
    expect(
      voiceAssistantSttKeyV1({
        VOICE_ASSISTANT_STT: "openai",
        ELEVENLABS_API_KEY: "e",
      }),
    ).toBeUndefined();
    expect(
      voiceAssistantSttKeyV1({ ELEVENLABS_API_KEY: "   " }),
    ).toBeUndefined();
  });

  test("Scribe hears what the clients send and ends a turn on half a second", () => {
    expect(VOICE_ASSISTANT_SCRIBE_OPTIONS_V1.audioFormat).toBe("pcm_16000");
    expect(VOICE_ASSISTANT_SCRIBE_OPTIONS_V1.sampleRate).toBe(
      VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1,
    );
    expect(VOICE_ASSISTANT_SCRIBE_OPTIONS_V1.vadSilenceThresholdSecs).toBe(0.5);
    expect(VOICE_ASSISTANT_SCRIBE_OPTIONS_V1.enableLogging).toBe(false);
  });
});

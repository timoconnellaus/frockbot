import { describe, expect, test } from "bun:test";
import { chooseVoiceProviderV1, VOICE_PROVIDERS_V1 } from "./providers.js";
import {
  voiceProviderDailyAudioSecondsV1,
  VOICE_PROVIDER_IDS_V1,
} from "./provider.js";
import {
  VOICE_ASSISTANT_DAILY_AUDIO_IN_SECONDS_V1,
  VOICE_ASSISTANT_DAILY_AUDIO_OUT_SECONDS_V1,
} from "./shared.js";

const keys = { GEMINI_API_KEY: "g-key", OPENAI_API_KEY: "o-key" };
const reference = {
  audioInSeconds: VOICE_ASSISTANT_DAILY_AUDIO_IN_SECONDS_V1,
  audioOutSeconds: VOICE_ASSISTANT_DAILY_AUDIO_OUT_SECONDS_V1,
};

describe("choosing a provider", () => {
  test("Gemini Live when the deployment says nothing", () => {
    const choice = chooseVoiceProviderV1({ deployment: undefined, keys });
    expect(choice.provider.id).toBe("gemini-live");
    expect(choice.key).toBe("g-key");
    expect(choice.keySource).toBe("deployment");
  });

  test("the deployment's choice, on that provider's own key", () => {
    const choice = chooseVoiceProviderV1({
      deployment: " openai-realtime ",
      keys,
    });
    expect(choice.provider.id).toBe("openai-realtime");
    expect(choice.key).toBe("o-key");
  });

  test("a provider without its key has none, rather than borrowing another's", () => {
    const choice = chooseVoiceProviderV1({
      deployment: "openai-realtime",
      keys: { GEMINI_API_KEY: "g-key", OPENAI_API_KEY: "  " },
    });
    expect(choice.key).toBeUndefined();
  });

  test("an unknown name runs the default", () => {
    expect(
      chooseVoiceProviderV1({ deployment: "whisper-2000", keys }).provider.id,
    ).toBe("gemini-live");
  });

  test("an account's choice and key win over the deployment's", () => {
    const choice = chooseVoiceProviderV1({
      deployment: "gemini-live",
      keys,
      account: { provider: "openai-realtime", key: "sk-own" },
    });
    expect(choice.provider.id).toBe("openai-realtime");
    expect(choice.key).toBe("sk-own");
    expect(choice.keySource).toBe("account");
  });

  test("every provider id is registered", () => {
    for (const id of VOICE_PROVIDER_IDS_V1) {
      expect(VOICE_PROVIDERS_V1[id].id).toBe(id);
    }
  });
});

describe("the day's audio caps", () => {
  test("Gemini Live keeps the four hours each way it always had", () => {
    expect(
      voiceProviderDailyAudioSecondsV1(
        VOICE_PROVIDERS_V1["gemini-live"].rates,
        reference,
      ),
    ).toEqual(reference);
  });

  test("OpenAI Realtime gets the same money's worth of seconds", () => {
    const caps = voiceProviderDailyAudioSecondsV1(
      VOICE_PROVIDERS_V1["openai-realtime"].rates,
      reference,
    );
    expect(caps).toEqual({ audioInSeconds: 3375, audioOutSeconds: 3375 });
  });

  test("a cheaper provider does not buy a longer day", () => {
    expect(
      voiceProviderDailyAudioSecondsV1(
        { inputMicrosPerSecond: 1, outputMicrosPerSecond: 1 },
        reference,
      ),
    ).toEqual(reference);
  });
});

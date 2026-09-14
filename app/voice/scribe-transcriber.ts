// The continuous assistant's ears: ElevenLabs Scribe v2 Realtime.
//
// The assistant is hands-free, so the thing that hears the speech must also
// hear the pause that ends it. Scribe streams a partial transcript while the
// person is still talking and commits the segment itself when its voice
// detector has heard enough silence — so the model can be reading the words
// before the sentence is over, and the turn begins about half a second after
// it is. OpenAI's `gpt-transcribe` (the ears until 2026-09-12) could do only
// one of those: it holds every word until 700 ms of silence has passed and
// then sends them all at once. The adapter itself lives in
// `@cloudflare/voice-elevenlabs`; this module is the assistant's settings for
// it and the choice between the two providers, kept pure so both are tested.
import { VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 } from "./shared.js";

/** Which provider the assistant listens through. */
export type VoiceAssistantSttProviderV1 = "scribe" | "openai";

export const VOICE_ASSISTANT_STT_DEFAULT_PROVIDER_V1: VoiceAssistantSttProviderV1 =
  "scribe";

/**
 * How Scribe listens.
 *
 * `pcm_16000` is what both clients send, so nothing is resampled. Half a
 * second of silence ends a turn: long enough to survive the pause in the
 * middle of a sentence most of the time, short enough that the answer does
 * not feel late; a longer mid-sentence pause splits the turn in two, and two
 * short Turns is a better failure than a lost one. Logging is off because
 * the account's words are not the provider's to keep.
 */
export const VOICE_ASSISTANT_SCRIBE_OPTIONS_V1 = {
  modelId: "scribe_v2_realtime",
  audioFormat: "pcm_16000",
  sampleRate: VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1,
  vadSilenceThresholdSecs: 0.5,
  vadThreshold: 0.4,
  minSpeechDurationMs: 100,
  minSilenceDurationMs: 100,
  enableLogging: false,
} as const;

export interface VoiceAssistantSttEnvV1 {
  /** Exactly `openai` listens through OpenAI; anything else is the default. */
  VOICE_ASSISTANT_STT?: string;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
}

/** Reads the provider the deployment asked for; the default when it did not. */
export function voiceAssistantSttProviderV1(
  env: Pick<VoiceAssistantSttEnvV1, "VOICE_ASSISTANT_STT">,
): VoiceAssistantSttProviderV1 {
  return env.VOICE_ASSISTANT_STT === "openai"
    ? "openai"
    : VOICE_ASSISTANT_STT_DEFAULT_PROVIDER_V1;
}

/** The key the chosen provider listens with, or undefined when it is absent. */
export function voiceAssistantSttKeyV1(
  env: VoiceAssistantSttEnvV1,
): string | undefined {
  const key =
    voiceAssistantSttProviderV1(env) === "openai"
      ? env.OPENAI_API_KEY
      : env.ELEVENLABS_API_KEY;
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

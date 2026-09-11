// Which transcription upstream dictation opens, and how its frames read.
//
// Everything here is a pure function over configuration and text, so it is
// tested without a socket. With the shared wire vocabulary in
// `openai-realtime.ts` it is the whole of the provider: the relay above it
// speaks only `VoiceDictationServerFrameV1`, so a second provider is a change
// to these two files alone.
//
// Contract, from the OpenAI Realtime transcription guide and a run against
// the live endpoint (2026-09-11): a `transcription` session is configured
// with `session.audio.input.{format, noise_reduction, transcription,
// turn_detection}`; audio arrives as base64 PCM16 in
// `input_audio_buffer.append`; `input_audio_buffer.commit` closes the turn;
// the server answers `session.updated`, then
// `conversation.item.input_audio_transcription.delta` while the person
// speaks, then `input_audio_buffer.committed` and `.completed`.
//
// The model is `gpt-live-transcribe`, OpenAI's current streaming
// speech-to-text model, billed per audio minute. Turn detection is null
// because it has to be: the streaming models (`gpt-live-transcribe` and the
// `gpt-realtime-whisper` dictation asked for before) answer any
// `turn_detection` with "Turn detection is not supported for this
// transcription model." and the session dies there, which is why no capture
// in production ever reached `ready`. The models that do take VAD
// (`gpt-transcribe`, `gpt-4o-transcribe`) hold their deltas until the turn
// commits and then send them all at once, and live text as the person speaks
// is the point of dictation.
//
// So a capture is one item, not a series of them: deltas accumulate against
// it from about half a second behind the speaker, nothing is committed while
// the person talks, and the relay's own commit after `stop` is what produces
// the single `.completed` transcript. No commit, no transcript — that was
// confirmed against a 73-second capture that was never committed.
import { VOICE_REALTIME_TRANSCRIPTION_URL_V1 } from "./openai-realtime.js";
import { VOICE_DICTATION_SAMPLE_RATE_V1 } from "./shared.js";

/** The streaming transcription model dictation uses. */
export const VOICE_DICTATION_MODEL_V1 = "gpt-live-transcribe";

export interface VoiceDictationEnvV1 {
  /** The direct OpenAI path. Deployed as a Worker secret. */
  OPENAI_API_KEY?: string;
  /**
   * A local stand-in, set only by the test harness and local development.
   * Production sets no such var and this branch does not exist there.
   */
  VOICE_DICTATION_UPSTREAM_URL?: string;
}

export type VoiceDictationUpstreamTargetV1 =
  | { path: "override"; url: string; headers: Record<string, string> }
  | { path: "openai"; url: string; headers: Record<string, string> }
  | { path: "unconfigured"; message: string };

export const VOICE_DICTATION_UNCONFIGURED_MESSAGE_V1 =
  "Voice isn't set up on this deployment yet. Type your message instead.";

/** Which upstream this deployment dictates through, and with what credential. */
export function voiceDictationUpstreamTargetV1(
  env: VoiceDictationEnvV1,
): VoiceDictationUpstreamTargetV1 {
  if (env.VOICE_DICTATION_UPSTREAM_URL) {
    return {
      path: "override",
      url: env.VOICE_DICTATION_UPSTREAM_URL,
      headers: {},
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      path: "openai",
      url: VOICE_REALTIME_TRANSCRIPTION_URL_V1,
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    };
  }
  return {
    path: "unconfigured",
    message: VOICE_DICTATION_UNCONFIGURED_MESSAGE_V1,
  };
}

/** True when dictation can open an upstream at all. */
export function voiceDictationConfiguredV1(env: VoiceDictationEnvV1): boolean {
  return voiceDictationUpstreamTargetV1(env).path !== "unconfigured";
}

/**
 * The one thing said to the upstream before audio starts.
 *
 * `turn_detection: null` is not a preference. The upstream refuses the
 * session outright if this model is given any turn detection, and the server
 * defaults it to `server_vad` when the field is absent, so the null has to be
 * sent explicitly. The consequence is the relay's: one item per capture,
 * deltas while the person speaks, and the transcript only after the relay
 * commits at `stop`.
 */
export function voiceDictationSessionUpdateV1(): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: VOICE_DICTATION_SAMPLE_RATE_V1 },
          noise_reduction: { type: "near_field" },
          transcription: { model: VOICE_DICTATION_MODEL_V1 },
          turn_detection: null,
        },
      },
    },
  };
}

export const VOICE_DICTATION_UPSTREAM_REFUSAL_MESSAGE_V1 =
  "Dictation stopped: the speech service refused the session. Try again.";

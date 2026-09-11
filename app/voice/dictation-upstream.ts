// Which transcription upstream dictation opens, and how its frames read.
//
// Everything here is a pure function over configuration and text, so it is
// tested without a socket. It is also the whole of the provider's
// vocabulary: the relay above it speaks only `VoiceDictationServerFrameV1`,
// so a second provider is a change to this file alone.
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
// (`gpt-transcribe`, `gpt-4o-transcribe`) do not stream deltas, and live
// text as the person speaks is the point of dictation.
//
// So a capture is one item, not a series of them: deltas accumulate against
// it from about half a second behind the speaker, nothing is committed while
// the person talks, and the relay's own commit after `stop` is what produces
// the single `.completed` transcript. No commit, no transcript — that was
// confirmed against a 73-second capture that was never committed.
import {
  VOICE_DICTATION_SAMPLE_RATE_V1,
  type VoiceDictationServerFrameV1,
} from "./shared.js";

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
      url: "wss://api.openai.com/v1/realtime?intent=transcription",
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

/** One frame of PCM16 as the upstream takes it. */
export function voiceDictationAppendV1(pcm: ArrayBuffer): string {
  return JSON.stringify({
    type: "input_audio_buffer.append",
    audio: base64(new Uint8Array(pcm)),
  });
}

export function voiceDictationCommitV1(): string {
  return JSON.stringify({ type: "input_audio_buffer.commit" });
}

export const VOICE_DICTATION_UPSTREAM_REFUSAL_MESSAGE_V1 =
  "Dictation stopped: the speech service refused the session. Try again.";

/**
 * One upstream event, reduced to what the relay tracks.
 *
 * Every transcription belongs to an item the relay's commit after `stop`
 * closed. A capture is normally one such item; the ordering the relay keeps
 * costs nothing and holds if the upstream ever commits more than one. An
 * `error` that says the buffer had nothing to commit is the one refusal that
 * is not a failure after `stop` — it means the person pressed stop without
 * saying anything new.
 */
export type VoiceDictationUpstreamEventV1 =
  | { kind: "delta"; text: string; itemId?: string }
  | { kind: "committed"; itemId: string }
  | { kind: "session-updated" }
  | { kind: "completed"; text: string; itemId?: string }
  | { kind: "failed"; message: string; itemId?: string }
  | { kind: "error"; message: string; emptyBuffer: boolean };

const EMPTY_BUFFER_CODES = new Set([
  "input_audio_buffer_commit_empty",
  "input_audio_buffer_too_small",
]);

export function translateVoiceDictationUpstreamFrameV1(
  raw: string,
): VoiceDictationUpstreamEventV1 | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
  if (type === "session.updated") return { kind: "session-updated" };
  if (type === "conversation.item.input_audio_transcription.delta") {
    const text = typeof event.delta === "string" ? event.delta : "";
    if (!text) return undefined;
    return { kind: "delta", text, ...(itemId ? { itemId } : {}) };
  }
  if (type === "input_audio_buffer.committed") {
    if (!itemId) return undefined;
    return { kind: "committed", itemId };
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = typeof event.transcript === "string" ? event.transcript : "";
    return {
      kind: "completed",
      text: text.trim(),
      ...(itemId ? { itemId } : {}),
    };
  }
  if (type === "conversation.item.input_audio_transcription.failed") {
    return {
      kind: "failed",
      message: errorMessage(event.error),
      ...(itemId ? { itemId } : {}),
    };
  }
  if (type === "error") {
    const error =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : {};
    const code = typeof error.code === "string" ? error.code : "";
    const message = errorMessage(event.error);
    return {
      kind: "error",
      message,
      emptyBuffer:
        EMPTY_BUFFER_CODES.has(code) ||
        /buffer (is )?(too small|empty)|nothing to commit/i.test(message),
    };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "the transcription service refused the session";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

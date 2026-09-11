// Which transcription upstream dictation opens, and how its frames read.
//
// Everything here is a pure function over configuration and text, so it is
// tested without a socket. It is also the whole of the provider's
// vocabulary: the relay above it speaks only `VoiceDictationServerFrameV1`,
// so a second provider is a change to this file alone.
//
// Contract, from the OpenAI Realtime transcription guide and the
// `session.update` reference (read 2026-09-11): a `transcription` session is
// configured with `session.audio.input.{format, noise_reduction,
// transcription, turn_detection}`; audio arrives as base64 PCM16 in
// `input_audio_buffer.append`; `input_audio_buffer.commit` closes a turn by
// hand; the server answers `conversation.item.input_audio_transcription.delta`
// and `.completed`.
//
// The model is `gpt-live-transcribe`, OpenAI's current streaming
// speech-to-text model, billed per audio minute on the realtime transcription
// endpoint. It is here because the realtime VAD guide says models that
// support VAD default to `server_vad` while `gpt-realtime-whisper` — what
// dictation asked for before — requires turn detection omitted or null, which
// is why every capture died at the first `session.update`. Server-side turn
// detection is what gives the relay its committed segments, so the model
// moved rather than the turn detection.
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
 * Server-side turn detection produces the `.completed` segments the composer
 * replaces its deltas with. 700 ms of silence closes a segment: long enough
 * that a breath mid-sentence does not fragment it, short enough that the
 * committed text keeps up with the speaker.
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
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
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
 * Every transcription belongs to an item the upstream committed — by its own
 * turn detection, or by the relay's commit after `stop` — and completions for
 * different items may arrive in any order. The relay keeps the committed
 * order and hands segments to the client in it, and `stop` is done only when
 * every committed item has answered. An `error` that says the buffer had
 * nothing to commit is the one refusal that is not a failure after `stop`.
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

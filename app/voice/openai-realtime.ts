// The vocabulary of OpenAI's realtime transcription socket, as pure functions.
//
// Both voice paths speak this protocol: dictation (`dictation-upstream.ts`, a
// streaming model with turn detection off) and the continuous assistant
// (`openai-transcriber.ts`, a VAD model that decides turns itself). What they
// share is the wire — how a frame of PCM16 is appended, and how a server
// event reduces to something either caller can act on — so it lives here and
// each path keeps only its own session configuration.
//
// Contract, from the OpenAI Realtime transcription guide and runs against the
// live endpoint (2026-09-11): audio arrives as base64 PCM16 in
// `input_audio_buffer.append`; the server answers `session.updated`, then
// `conversation.item.input_audio_transcription.delta`,
// `input_audio_buffer.committed` and `.completed`. With server-side turn
// detection it also announces `input_audio_buffer.speech_started` the moment
// it hears someone, which is what the assistant interrupts playback on.

/**
 * The only PCM rate the realtime socket accepts, whatever the client
 * captured at. Audio recorded at another rate is resampled to meet it.
 */
export const VOICE_REALTIME_PCM_RATE_V1 = 24_000;

/** One frame of PCM16 as the upstream takes it. */
export function voiceRealtimeAppendV1(pcm: ArrayBuffer): string {
  return JSON.stringify({
    type: "input_audio_buffer.append",
    audio: voiceRealtimeBase64V1(new Uint8Array(pcm)),
  });
}

export function voiceRealtimeCommitV1(): string {
  return JSON.stringify({ type: "input_audio_buffer.commit" });
}

/**
 * One upstream event, reduced to what a caller tracks.
 *
 * Every transcription belongs to an item — committed by the relay after
 * `stop` for dictation, by the server's own VAD for the assistant — so the
 * item id is carried through and completions are matched against it. An
 * `error` that says the buffer had nothing to commit is the one refusal that
 * is not a failure: it means the person committed without saying anything.
 */
export type VoiceRealtimeUpstreamEventV1 =
  | { kind: "delta"; text: string; itemId?: string }
  | { kind: "committed"; itemId: string }
  | { kind: "session-updated" }
  | { kind: "speech-started" }
  | { kind: "completed"; text: string; itemId?: string }
  | { kind: "failed"; message: string; itemId?: string }
  | { kind: "error"; message: string; emptyBuffer: boolean };

const EMPTY_BUFFER_CODES = new Set([
  "input_audio_buffer_commit_empty",
  "input_audio_buffer_too_small",
]);

export function translateVoiceRealtimeUpstreamFrameV1(
  raw: string,
): VoiceRealtimeUpstreamEventV1 | undefined {
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
  if (type === "input_audio_buffer.speech_started") {
    return { kind: "speech-started" };
  }
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
      message: voiceRealtimeErrorMessageV1(event.error),
      ...(itemId ? { itemId } : {}),
    };
  }
  if (type === "error") {
    const error =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : {};
    const code = typeof error.code === "string" ? error.code : "";
    const message = voiceRealtimeErrorMessageV1(event.error);
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

function voiceRealtimeErrorMessageV1(error: unknown): string {
  return error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "the transcription service refused the session";
}

function voiceRealtimeBase64V1(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

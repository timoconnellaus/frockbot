// Which transcription upstream dictation opens, and how its frames read.
//
// Separate from `voice-session.ts` so it can be tested without a Durable
// Object: everything here is a pure function over configuration and text, and
// nothing here imports `cloudflare:workers`. It is also the whole of the
// provider's vocabulary — the object above it speaks only the protocol in
// `@frockbot/protocol`, so a second provider is a change to this file alone.
import type { VoiceDictationServerFrameV1 } from "@frockbot/protocol";

/**
 * The transcription model (voice plan D3). `whisper-1` cannot stream deltas,
 * so it cannot write into the composer as a person speaks; this one can.
 */
export const VOICE_TRANSCRIPTION_MODEL_V1 = "gpt-live-transcribe";

export interface VoiceSessionEnvV1 {
  /**
   * The direct OpenAI path. Present, it is the one that runs: the AI Gateway's
   * realtime path has not yet been exercised with a transcription-only
   * session. Deployed as a Worker secret, so the release workflow's
   * `--secrets-file` list must carry the name or a deploy would delete it (ADR
   * 0025).
   */
  OPENAI_API_KEY?: string;
  /** `cf-aig-authorization` bearer for the `flock` AI Gateway. */
  FROCK_AI_GATEWAY_TOKEN?: string;
  FLOCK_AI_GATEWAY_TOKEN?: string;
  FROCK_AI_ACCOUNT_ID?: string;
  FLOCK_AI_ACCOUNT_ID?: string;
  FROCK_AI_GATEWAY_ID?: string;
  FLOCK_AI_GATEWAY_ID?: string;
  /**
   * A local stand-in, set only by the end-to-end harness and local
   * development. Production sets no such var and this branch does not exist
   * there — the same shape the Workspace seed door has.
   */
  VOICE_UPSTREAM_URL?: string;
}

export type VoiceUpstreamTargetV1 =
  | { path: "override"; url: string; headers: Record<string, string> }
  | { path: "openai"; url: string; headers: Record<string, string> }
  | { path: "gateway"; url: string; headers: Record<string, string> }
  | { path: "unconfigured"; message: string };

/**
 * Which upstream this deployment dictates through, and with what credential.
 *
 * Selectable without a code change on purpose, which is the plan's fallback
 * made concrete: a deployment holding an `OPENAI_API_KEY` takes the direct
 * path, and one that does not falls back to the Gateway's BYOK key. Moving
 * between the two is a secret, not a deploy of different code.
 */
export function voiceUpstreamTargetV1(
  env: VoiceSessionEnvV1,
): VoiceUpstreamTargetV1 {
  const model = encodeURIComponent(VOICE_TRANSCRIPTION_MODEL_V1);
  if (env.VOICE_UPSTREAM_URL) {
    return { path: "override", url: env.VOICE_UPSTREAM_URL, headers: {} };
  }
  if (env.OPENAI_API_KEY) {
    return {
      path: "openai",
      url: `wss://api.openai.com/v1/realtime?model=${model}`,
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
    };
  }
  const token = env.FROCK_AI_GATEWAY_TOKEN ?? env.FLOCK_AI_GATEWAY_TOKEN;
  const accountId = env.FROCK_AI_ACCOUNT_ID ?? env.FLOCK_AI_ACCOUNT_ID;
  const gatewayId =
    env.FROCK_AI_GATEWAY_ID ?? env.FLOCK_AI_GATEWAY_ID ?? "flock";
  if (token && accountId) {
    return {
      path: "gateway",
      url:
        `wss://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai` +
        `?model=${model}`,
      headers: {
        "cf-aig-authorization": `Bearer ${token}`,
      },
    };
  }
  return {
    path: "unconfigured",
    message:
      "Dictation isn't set up on this deployment yet. Type your message instead.",
  };
}

/**
 * The one thing said to the upstream before audio starts.
 *
 * The GA API accepts PCM16 as `audio/pcm` at 24 kHz. Server-side turn
 * detection produces the `.completed` segments the composer replaces its
 * deltas with.
 */
export function voiceUpstreamSessionUpdateV1(): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: { model: VOICE_TRANSCRIPTION_MODEL_V1 },
          turn_detection: { type: "server_vad", silence_duration_ms: 500 },
        },
      },
    },
  };
}

export const VOICE_UPSTREAM_REFUSAL_MESSAGE_V1 =
  "Dictation stopped: the speech service refused the connection. Try again.";

/**
 * Translate one upstream frame into what the browser is told, or nothing.
 *
 * `completed` marks the frame a pending commit is waiting for: it is the
 * signal that everything captured has been transcribed and the message may
 * go.
 */
export function translateVoiceUpstreamFrameV1(raw: string):
  | {
      frame: VoiceDictationServerFrameV1;
      completed?: true;
      upstreamError?: string;
    }
  | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "conversation.item.input_audio_transcription.delta") {
    const text = typeof event.delta === "string" ? event.delta : "";
    if (!text) return undefined;
    return { frame: { schemaVersion: 1, type: "delta", text } };
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = typeof event.transcript === "string" ? event.transcript : "";
    return {
      frame: { schemaVersion: 1, type: "transcript", text },
      completed: true,
    };
  }
  if (type === "error") {
    const error = event.error;
    const message =
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "the transcription service refused the session";
    return {
      frame: {
        schemaVersion: 1,
        type: "error",
        message: VOICE_UPSTREAM_REFUSAL_MESSAGE_V1,
      },
      upstreamError: message,
    };
  }
  return undefined;
}

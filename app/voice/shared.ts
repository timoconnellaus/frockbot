// The voice wire vocabulary both clients and both Worker adapters speak.
//
// Two channels share this file so a frame is spelled once. The dictation
// channel is FrockBot's own protocol; the assistant channel is the
// `@cloudflare/voice` protocol version 1 plus the custom messages below,
// which that SDK hands through untouched. Nothing here imports a Cloudflare
// SDK or the DOM: it is read by the Worker, the browser and the tests alike.

/** `GET /api/voice/capabilities`. */
export interface VoiceCapabilitiesV1 {
  schemaVersion: 1;
  dictation: boolean;
  assistant: boolean;
}

export function decodeVoiceCapabilitiesV1(input: unknown): VoiceCapabilitiesV1 {
  const value = record(input, "voice capabilities");
  if (value.schemaVersion !== 1) {
    throw new Error("voice capabilities schemaVersion is unsupported");
  }
  return {
    schemaVersion: 1,
    dictation: value.dictation === true,
    assistant: value.assistant === true,
  };
}

export const VOICE_DICTATION_PATH_V1 = "/api/voice/dictation";
export const VOICE_ASSISTANT_PATH_V1 = "/api/voice/assistant";
export const VOICE_CAPABILITIES_PATH_V1 = "/api/voice/capabilities";

/** What dictation captures and sends: PCM16 mono at this rate. */
export const VOICE_DICTATION_SAMPLE_RATE_V1 = 24_000;
/** What the assistant expects up the wire: PCM16 mono at this rate. */
export const VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 = 16_000;
/** What the assistant sends down the wire: PCM16 mono at this rate. */
export const VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1 = 24_000;

/** A capture nobody stops is closed rather than left to spend the budget. */
export const VOICE_DICTATION_MAX_MS_V1 = 5 * 60_000;
/** How long the upstream has to accept a dictation session. */
export const VOICE_DICTATION_CONNECT_TIMEOUT_MS_V1 = 10_000;
/** How long `stop` waits for the last segment before answering `final` anyway. */
export const VOICE_DICTATION_FINAL_TIMEOUT_MS_V1 = 6_000;
/** The account's dictation lease is renewed this often while a capture runs. */
export const VOICE_DICTATION_LEASE_RENEW_MS_V1 = 30_000;
/** Seconds of provider time one dictation lease reserves at a time. */
export const VOICE_DICTATION_RESERVE_SECONDS_V1 = 60;
/** Dictation seconds one account may spend per UTC day. */
export const VOICE_DICTATION_DAILY_SECONDS_V1 = 120 * 60;
/** Opening audio held while the upstream connects: 30 s at 24 kHz PCM16. */
export const VOICE_DICTATION_OPENING_BUFFER_BYTES_V1 =
  30 * VOICE_DICTATION_SAMPLE_RATE_V1 * 2;

/** Quiet this long, with the reply done, and the client sleeps the upstream. */
export const VOICE_ASSISTANT_SLEEP_AFTER_MS_V1 = 20_000;
/** Audio replayed ahead of a wake so the first syllable reaches the model. */
export const VOICE_ASSISTANT_PREROLL_MS_V1 = 500;
/** The server's own guard: no audio this long while awake and it sleeps. */
export const VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1 = 30_000;
/**
 * Daily meters, per account, over what actually costs money. A footer left
 * open in silence for hours costs nothing and counts nothing: the upstream
 * sleeps, and only awake STT seconds, synthesized characters, model turns and
 * Bot delegations are counted.
 */
export const VOICE_ASSISTANT_DAILY_STT_SECONDS_V1 = 240 * 60;
/** Seconds of awake transcription reserved ahead, and renewed, while awake. */
export const VOICE_ASSISTANT_STT_RESERVE_SECONDS_V1 = 60;
export const VOICE_ASSISTANT_DAILY_TTS_CHARACTERS_V1 = 200_000;
export const VOICE_ASSISTANT_DAILY_TURNS_V1 = 600;
export const VOICE_ASSISTANT_DAILY_DELEGATIONS_V1 = 200;
/** Delegations one spoken turn may admit before the assistant is told to stop. */
export const VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1 = 8;
/** A socket replaced within this window rejoins the same durable call. */
export const VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1 = 60_000;

// ---------------------------------------------------------------------------
// Dictation frames

export type VoiceDictationClientFrameV1 =
  | { schemaVersion: 1; type: "start"; sampleRate: number }
  | { schemaVersion: 1; type: "stop" };

export type VoiceDictationErrorCodeV1 =
  "unconfigured" | "upstream" | "timeout" | "limit" | "protocol";

export type VoiceDictationServerFrameV1 =
  | { schemaVersion: 1; type: "ready" }
  | { schemaVersion: 1; type: "delta"; text: string }
  | { schemaVersion: 1; type: "segment"; text: string }
  | { schemaVersion: 1; type: "final" }
  | { schemaVersion: 1; type: "notice"; message: string }
  | {
      schemaVersion: 1;
      type: "error";
      message: string;
      code?: VoiceDictationErrorCodeV1;
    };

export function decodeVoiceDictationClientFrameV1(
  input: unknown,
): VoiceDictationClientFrameV1 {
  const value = record(input, "dictation frame");
  if (value.schemaVersion !== 1) {
    throw new Error("dictation frame schemaVersion is unsupported");
  }
  if (value.type === "start") {
    if (value.sampleRate !== VOICE_DICTATION_SAMPLE_RATE_V1) {
      throw new Error(
        `dictation start must declare sampleRate ${VOICE_DICTATION_SAMPLE_RATE_V1}`,
      );
    }
    return {
      schemaVersion: 1,
      type: "start",
      sampleRate: VOICE_DICTATION_SAMPLE_RATE_V1,
    };
  }
  if (value.type === "stop") return { schemaVersion: 1, type: "stop" };
  throw new Error("dictation frame type is unknown");
}

export function decodeVoiceDictationServerFrameV1(
  input: unknown,
): VoiceDictationServerFrameV1 {
  const value = record(input, "dictation frame");
  if (value.schemaVersion !== 1) {
    throw new Error("dictation frame schemaVersion is unsupported");
  }
  switch (value.type) {
    case "ready":
      return { schemaVersion: 1, type: "ready" };
    case "final":
      return { schemaVersion: 1, type: "final" };
    case "delta":
    case "segment":
      return {
        schemaVersion: 1,
        type: value.type,
        text: text(value.text, "dictation text", 32_000),
      };
    case "notice":
      return {
        schemaVersion: 1,
        type: "notice",
        message: text(value.message, "dictation notice", 500),
      };
    case "error": {
      const code = value.code;
      return {
        schemaVersion: 1,
        type: "error",
        message: text(value.message, "dictation error", 500),
        ...(code === "unconfigured" ||
        code === "upstream" ||
        code === "timeout" ||
        code === "limit" ||
        code === "protocol"
          ? { code }
          : {}),
      };
    }
    default:
      throw new Error("dictation frame type is unknown");
  }
}

// ---------------------------------------------------------------------------
// Assistant custom messages (carried beside the `@cloudflare/voice` protocol)

/** The `@cloudflare/voice` pipeline status a client mirrors. */
export type VoiceAssistantStatusV1 =
  "idle" | "listening" | "thinking" | "speaking";

export type VoiceAssistantClientMessageV1 =
  | { schemaVersion: 1; type: "voice/sleep" }
  | { schemaVersion: 1; type: "voice/wake" }
  | { schemaVersion: 1; type: "voice/mute"; muted: boolean };

export type VoiceAssistantRefusalCodeV1 =
  "exclusive" | "superseded" | "quota" | "unconfigured";

export type VoiceAssistantUpstreamStateV1 = "asleep" | "starting" | "awake";

export type VoiceAssistantServerMessageV1 =
  | {
      schemaVersion: 1;
      type: "voice/refusal";
      code: VoiceAssistantRefusalCodeV1;
      message: string;
    }
  | {
      schemaVersion: 1;
      type: "voice/state";
      upstream: VoiceAssistantUpstreamStateV1;
      muted: boolean;
    };

/** Every JSON message a client may see: the SDK's own, or one of ours. */
export type VoiceAssistantSdkMessageV1 =
  | { type: "welcome"; protocol_version: number }
  | { type: "status"; status: VoiceAssistantStatusV1 }
  | { type: "audio_config"; format: string; sampleRate?: number }
  | { type: "playback_interrupt" }
  | { type: "error"; message: string; code?: string; retryable?: boolean }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "transcript_interim"; text: string }
  | { type: "transcript_start"; role: "user" | "assistant" }
  | { type: "transcript_delta"; text: string }
  | { type: "transcript_end"; text: string }
  | { type: "diagnostic" }
  | { type: "metrics" }
  | { type: "turn_metrics" }
  | { type: "completion_outcome" };

export function decodeVoiceAssistantClientMessageV1(
  input: unknown,
): VoiceAssistantClientMessageV1 | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) return undefined;
  if (value.type === "voice/sleep")
    return { schemaVersion: 1, type: "voice/sleep" };
  if (value.type === "voice/wake")
    return { schemaVersion: 1, type: "voice/wake" };
  if (value.type === "voice/mute") {
    return {
      schemaVersion: 1,
      type: "voice/mute",
      muted: value.muted === true,
    };
  }
  return undefined;
}

/**
 * One JSON text frame from the assistant socket, sorted into the SDK's
 * vocabulary or ours. Unknown types are returned as `undefined` rather than
 * thrown, because the SDK may add diagnostics between releases.
 */
export function decodeVoiceAssistantServerFrameV1(
  raw: string,
):
  | { kind: "sdk"; message: VoiceAssistantSdkMessageV1 }
  | { kind: "custom"; message: VoiceAssistantServerMessageV1 }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = parsed as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "voice/refusal") {
    const code = value.code;
    if (
      code !== "exclusive" &&
      code !== "superseded" &&
      code !== "quota" &&
      code !== "unconfigured"
    ) {
      return undefined;
    }
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/refusal",
        code,
        message: typeof value.message === "string" ? value.message : "",
      },
    };
  }
  if (type === "voice/state") {
    const upstream = value.upstream;
    if (
      upstream !== "asleep" &&
      upstream !== "starting" &&
      upstream !== "awake"
    ) {
      return undefined;
    }
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/state",
        upstream,
        muted: value.muted === true,
      },
    };
  }
  switch (type) {
    case "welcome":
      return {
        kind: "sdk",
        message: {
          type,
          protocol_version:
            typeof value.protocol_version === "number"
              ? value.protocol_version
              : 0,
        },
      };
    case "status": {
      const status = value.status;
      if (
        status !== "idle" &&
        status !== "listening" &&
        status !== "thinking" &&
        status !== "speaking"
      ) {
        return undefined;
      }
      return { kind: "sdk", message: { type, status } };
    }
    case "audio_config":
      return {
        kind: "sdk",
        message: {
          type,
          format: typeof value.format === "string" ? value.format : "",
          ...(typeof value.sampleRate === "number"
            ? { sampleRate: value.sampleRate }
            : {}),
        },
      };
    case "playback_interrupt":
      return { kind: "sdk", message: { type } };
    case "error":
      return {
        kind: "sdk",
        message: {
          type,
          message: typeof value.message === "string" ? value.message : "",
          ...(typeof value.code === "string" ? { code: value.code } : {}),
          ...(typeof value.retryable === "boolean"
            ? { retryable: value.retryable }
            : {}),
        },
      };
    case "transcript":
      return {
        kind: "sdk",
        message: {
          type,
          role: value.role === "assistant" ? "assistant" : "user",
          text: typeof value.text === "string" ? value.text : "",
        },
      };
    case "transcript_interim":
    case "transcript_delta":
    case "transcript_end":
      return {
        kind: "sdk",
        message: {
          type,
          text: typeof value.text === "string" ? value.text : "",
        },
      };
    case "transcript_start":
      return {
        kind: "sdk",
        message: {
          type,
          role: value.role === "assistant" ? "assistant" : "user",
        },
      };
    case "diagnostic":
    case "metrics":
    case "turn_metrics":
    case "completion_outcome":
      return { kind: "sdk", message: { type } };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} is invalid`);
  }
  return input as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  if (value.length > maximum) throw new Error(`${label} is too long`);
  return value;
}

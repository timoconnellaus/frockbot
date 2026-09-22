// The voice wire vocabulary both clients and both Worker adapters speak.
//
// Two channels share this file so a frame is spelled once. Both are
// FrockBot's own: the assistant channel keeps the frames the Cloudflare voice
// SDK used to speak — version 1, the same names, the same rates — because the
// clients implement them directly and ADR 0031 changed what is behind the
// socket, not what crosses it. Nothing here imports a Cloudflare SDK or the
// DOM: it is read by the Worker, the browser and the tests alike.

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
/** How long an OpenAI realtime upstream has to accept a session. */
export const VOICE_REALTIME_CONNECT_TIMEOUT_MS_V1 = 10_000;
/** How long `stop` waits for the last segment before answering `final` anyway. */
export const VOICE_DICTATION_FINAL_TIMEOUT_MS_V1 = 6_000;
/** The account's dictation lease is renewed this often while a capture runs. */
export const VOICE_DICTATION_LEASE_RENEW_MS_V1 = 30_000;
/** Seconds of provider time one dictation lease reserves at a time. */
export const VOICE_DICTATION_RESERVE_SECONDS_V1 = 60;
/** Dictation seconds one account may spend per UTC day. */
export const VOICE_DICTATION_DAILY_SECONDS_V1 = 120 * 60;
/**
 * How long the tidy-up after a capture may take before the raw transcript
 * stands. The draft is already on screen by then — Groq is a blink, Jev is
 * the review — so a slow answer loses its turn rather than the person's
 * patience. The bound has to cover both calls.
 */
export const VOICE_DICTATION_CLEANUP_TIMEOUT_MS_V1 = 12_000;
/**
 * Tidy-ups one account may spend per UTC day. At most one runs per capture,
 * so this is a second bound rather than the only one — it is what stops a
 * client that opens and stops captures in a loop from spending on a model.
 */
export const VOICE_DICTATION_DAILY_CLEANUPS_V1 = 400;
/** Opening audio held while the upstream connects: 30 s at 24 kHz PCM16. */
export const VOICE_DICTATION_OPENING_BUFFER_BYTES_V1 =
  30 * VOICE_DICTATION_SAMPLE_RATE_V1 * 2;

/** Quiet this long, with the reply done, and the client hibernates Gemini. */
export const VOICE_ASSISTANT_SLEEP_AFTER_MS_V1 = 120_000;
/** Audio replayed ahead of a wake so the first syllable reaches the model. */
export const VOICE_ASSISTANT_PREROLL_MS_V1 = 500;
/** The server's own guard: no audio this long while awake and it sleeps. */
export const VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1 = 30_000;
/**
 * Daily meters, per account, over what actually costs money. A footer left
 * open in silence for hours costs nothing and counts nothing: the Live session
 * is closed, and only the audio actually bridged each way, the model turns and
 * the Bot delegations are counted.
 *
 * The two audio meters are separate because the two directions are not priced
 * alike — Gemini Live output costs about 3.6x its input — so a day of being
 * talked at and a day of being talked to must not spend one allowance. Each
 * keeps the magnitude the old listening cap had.
 */
export const VOICE_ASSISTANT_DAILY_AUDIO_IN_SECONDS_V1 = 240 * 60;
export const VOICE_ASSISTANT_DAILY_AUDIO_OUT_SECONDS_V1 = 240 * 60;
/**
 * How much bridged audio is counted before the meter is written.
 *
 * Every frame is a storage write otherwise, forty times a second in each
 * direction. Blocks of five seconds keep the day's arithmetic honest and the
 * cap sharp to within one block.
 */
export const VOICE_ASSISTANT_METER_BLOCK_SECONDS_V1 = 5;
/** PCM16 mono at 16 kHz: what one second of the person costs the meter. */
export const VOICE_ASSISTANT_INPUT_BYTES_PER_SECOND_V1 =
  VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 * 2;
/** PCM16 mono at 24 kHz: what one second of the model costs it. */
export const VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1 =
  VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1 * 2;
/**
 * Opening audio held until this attempt's `voice/ready`: ten seconds at the
 * current input format. Derived from the rate, not a second magic number.
 */
export const VOICE_ASSISTANT_OPENING_BUFFER_SECONDS_V1 = 10;
export const VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1 =
  VOICE_ASSISTANT_OPENING_BUFFER_SECONDS_V1 *
  VOICE_ASSISTANT_INPUT_BYTES_PER_SECOND_V1;
/**
 * How long the server may spend on one opening: preparation, connection and
 * setup together. Kept below the client's 15 s start timeout.
 */
export const VOICE_ASSISTANT_OPENING_DEADLINE_MS_V1 = 10_000;
export const VOICE_ASSISTANT_DAILY_TURNS_V1 = 600;
export const VOICE_ASSISTANT_DAILY_DELEGATIONS_V1 = 200;
/** Delegations one spoken turn may admit before the assistant is told to stop. */
export const VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1 = 8;
/**
 * A socket replaced within this window rejoins the same durable call.
 *
 * Ours, not Google's: the probe found no stated lifetime for a resumption
 * handle, and a handle the server has forgotten closes the socket with 1008
 * rather than failing quietly (`docs/voice-gemini-probe.md`). So this stays a
 * policy about the person's own device coming back, and the 1008 is what
 * actually decides between resuming a session and opening a fresh one with a
 * handover.
 *
 * A live conversation uses this short window — a network flap continues the
 * call, a longer gap is a new one. A Pause, or the app leaving the screen,
 * uses the paused window instead: Gemini is
 * already closed, nothing is billed, and the person is coming back to the
 * same day rather than recovering from a drop.
 */
export const VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1 = 60_000;
/**
 * How long a paused call stays on the ledger after its socket goes.
 *
 * Pause and leaving the app both close Gemini first, so a socket the OS
 * then kills is not a hang-up. The same device coming back inside this
 * window continues the conversation; past it, the abandoned-call alarm
 * ends it the way the short window does for a live drop. Twenty-four
 * hours, not a calendar day: the meters still roll at UTC midnight, and
 * a call that crossed that line is still this call until they hang up.
 */
export const VOICE_ASSISTANT_PAUSED_REJOIN_WINDOW_MS_V1 = 24 * 60 * 60_000;

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
  /**
   * The capture is transcribed and is being tidied. The committed words are
   * already in the draft; this only asks the client to keep the socket open
   * for a `cleaned` that may still arrive.
   */
  | { schemaVersion: 1; type: "cleaning" }
  /**
   * The tidied form of everything this capture dictated, to replace the
   * capture's own span. Sent at most once, always before `final`, and only
   * when every guard accepted it — a capture whose tidy-up failed, timed out
   * or was refused simply gets `final` and keeps the raw transcript.
   */
  | { schemaVersion: 1; type: "cleaned"; text: string }
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
    case "cleaning":
      return { schemaVersion: 1, type: "cleaning" };
    case "final":
      return { schemaVersion: 1, type: "final" };
    case "cleaned":
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
// Assistant custom messages (carried beside the protocol-v1 frames)

/** The pipeline status a client mirrors. */
export type VoiceAssistantStatusV1 =
  "idle" | "listening" | "thinking" | "speaking";

export type VoiceOpeningModeV1 = "start" | "wake" | "rejoin" | "control";

export type VoiceOpeningFailCodeV1 =
  | "timeout"
  | "cancelled"
  | "overflow"
  | "upstream"
  | "quota"
  | "unconfigured"
  | "exclusive"
  | "superseded"
  | "ended"
  | "protocol"
  | "gap";

export type VoiceControlActionV1 = "pause" | "mute" | "end";

export type VoiceAssistantClientMessageV1 =
  | { schemaVersion: 1; type: "voice/sleep"; paused?: true }
  /**
   * One opening attempt: start, wake, rejoin, or a control-only reconnect.
   * Carries the target and the current pause/mute intent so they cannot race
   * a separate `start_call`.
   */
  | {
      schemaVersion: 1;
      type: "voice/open";
      attemptId: string;
      mode: VoiceOpeningModeV1;
      botId?: string;
      callId?: string;
      paused: boolean;
      muted: boolean;
    }
  | {
      schemaVersion: 1;
      type: "voice/control";
      attemptId: string;
      sequence: number;
      action: VoiceControlActionV1;
      muted?: boolean;
    }
  /**
   * What the speaker is doing, as the client's own player knows it. This is
   * what "a natural pause" means on the server: a Bot answer that arrives
   * while the person is still hearing something waits for it rather than
   * cutting it off. `playing` is sound actually leaving the device.
   */
  | { schemaVersion: 1; type: "voice/speech"; playing: boolean }
  /**
   * Mid-call retarget (ADR 0029). Who a new call opens on travels on
   * `voice/open`; this frame moves an already admitted call.
   */
  | { schemaVersion: 1; type: "voice/target"; botId: string };

export type VoiceAssistantRefusalCodeV1 =
  "exclusive" | "superseded" | "quota" | "unconfigured";

export type VoiceAssistantUpstreamStateV1 = "asleep" | "starting" | "awake";

const ATTEMPT_ID_V1 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function attemptId(value: unknown): string | undefined {
  return typeof value === "string" && ATTEMPT_ID_V1.test(value)
    ? value
    : undefined;
}

export type VoiceAssistantServerMessageV1 =
  /**
   * Which Bot the call is talking to (ADR 0029). The same shape the client
   * sends to open a call on a Bot, sent back when the call is admitted and
   * whenever `switch_bot` moves it, so the screen follows the voice.
   */
  | { schemaVersion: 1; type: "voice/target"; botId: string }
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
    }
  /**
   * Durable ownership for this attempt. `ready` is Gemini setup; this is
   * the call existing, including a paused rejoin that never opens Gemini.
   */
  | {
      schemaVersion: 1;
      type: "voice/admitted";
      attemptId: string;
      callId: string;
      paused: boolean;
      muted: boolean;
    }
  | {
      schemaVersion: 1;
      type: "voice/ready";
      attemptId: string;
      callId: string;
    }
  | {
      schemaVersion: 1;
      type: "voice/open-failed";
      attemptId: string;
      code: VoiceOpeningFailCodeV1;
    }
  | {
      schemaVersion: 1;
      type: "voice/control-ack";
      attemptId: string;
      sequence: number;
    }
  /**
   * Where a request to a Bot is: asked, its answer being put into words by
   * the assistant, or done. `runId` is the Turn the request became, so the
   * activity slot can open that Work rather than the Bot's latest. Chrome
   * only; nothing durable turns on it.
   */
  | {
      schemaVersion: 1;
      type: "voice/delegation";
      botId: string;
      botName: string;
      runId: string;
      state: "asked" | "answering" | "finished";
    };

/**
 * Every JSON message a client may see: a protocol-v1 frame, or one of ours.
 * The last four are diagnostics the Cloudflare voice SDK used to emit; clients
 * still ignore them by name rather than falling through to an error.
 */
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
    return {
      schemaVersion: 1,
      type: "voice/sleep",
      ...(value.paused === true ? { paused: true as const } : {}),
    };
  if (value.type === "voice/open") {
    const id = attemptId(value.attemptId);
    const mode = value.mode;
    if (
      !id ||
      (mode !== "start" &&
        mode !== "wake" &&
        mode !== "rejoin" &&
        mode !== "control")
    ) {
      return undefined;
    }
    const botId = typeof value.botId === "string" ? value.botId.trim() : "";
    const callId = typeof value.callId === "string" ? value.callId.trim() : "";
    return {
      schemaVersion: 1,
      type: "voice/open",
      attemptId: id,
      mode,
      ...(botId ? { botId } : {}),
      ...(callId ? { callId } : {}),
      paused: value.paused === true,
      muted: value.muted === true,
    };
  }
  if (value.type === "voice/control") {
    const id = attemptId(value.attemptId);
    const action = value.action;
    if (
      !id ||
      (action !== "pause" && action !== "mute" && action !== "end") ||
      typeof value.sequence !== "number" ||
      !Number.isInteger(value.sequence) ||
      value.sequence < 0
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      type: "voice/control",
      attemptId: id,
      sequence: value.sequence,
      action,
      ...(action === "mute" ? { muted: value.muted === true } : {}),
    };
  }
  if (value.type === "voice/speech") {
    return {
      schemaVersion: 1,
      type: "voice/speech",
      playing: value.playing === true,
    };
  }
  if (value.type === "voice/target") {
    // An empty or non-string id is not a target: the call keeps the Bot it
    // has rather than being pointed at nothing.
    const botId = typeof value.botId === "string" ? value.botId.trim() : "";
    if (!botId) return undefined;
    return { schemaVersion: 1, type: "voice/target", botId };
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
  if (type === "voice/target") {
    const botId = typeof value.botId === "string" ? value.botId.trim() : "";
    if (!botId) return undefined;
    return {
      kind: "custom",
      message: { schemaVersion: 1, type: "voice/target", botId },
    };
  }
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
  if (type === "voice/delegation") {
    if (
      typeof value.botId !== "string" ||
      typeof value.botName !== "string" ||
      typeof value.runId !== "string" ||
      (value.state !== "asked" &&
        value.state !== "answering" &&
        value.state !== "finished")
    ) {
      return undefined;
    }
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/delegation",
        botId: value.botId,
        botName: value.botName,
        runId: value.runId,
        state: value.state,
      },
    };
  }
  if (type === "voice/admitted") {
    const id = attemptId(value.attemptId);
    const callId = typeof value.callId === "string" ? value.callId.trim() : "";
    if (!id || !callId) return undefined;
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/admitted",
        attemptId: id,
        callId,
        paused: value.paused === true,
        muted: value.muted === true,
      },
    };
  }
  if (type === "voice/ready") {
    const id = attemptId(value.attemptId);
    const callId = typeof value.callId === "string" ? value.callId.trim() : "";
    if (!id || !callId) return undefined;
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/ready",
        attemptId: id,
        callId,
      },
    };
  }
  if (type === "voice/open-failed") {
    const id = attemptId(value.attemptId);
    const code = value.code;
    if (
      !id ||
      (code !== "timeout" &&
        code !== "cancelled" &&
        code !== "overflow" &&
        code !== "upstream" &&
        code !== "quota" &&
        code !== "unconfigured" &&
        code !== "exclusive" &&
        code !== "superseded" &&
        code !== "ended" &&
        code !== "protocol" &&
        code !== "gap")
    ) {
      return undefined;
    }
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/open-failed",
        attemptId: id,
        code,
      },
    };
  }
  if (type === "voice/control-ack") {
    const id = attemptId(value.attemptId);
    if (
      !id ||
      typeof value.sequence !== "number" ||
      !Number.isInteger(value.sequence) ||
      value.sequence < 0
    ) {
      return undefined;
    }
    return {
      kind: "custom",
      message: {
        schemaVersion: 1,
        type: "voice/control-ack",
        attemptId: id,
        sequence: value.sequence,
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

// Version 1 of the composer dictation protocol.
//
// Two legs, one shape. The browser opens an authenticated WebSocket to the
// gateway, which hands it to the per-User `VoiceSession` Durable Object; that
// object opens the upstream OpenAI realtime *transcription* session and
// translates in both directions. This module is the wire between the browser
// and the Durable Object, and nothing here is the upstream's own protocol:
// the Durable Object never forwards a provider frame verbatim, so a change of
// provider is a change to one file on the server and none in the client.
//
// Audio travels as binary frames — PCM16 little-endian, 16 kHz, mono, the
// format OpenAI's realtime transcription sessions take — and every control
// frame is JSON text. That split is what lets the receiver decide by frame
// type rather than by parsing.

/** The `?version=` a client presents; a mismatch is refused at the door. */
export const VOICE_DICTATION_VERSION_V1 = 1 as const;

/** The sample rate the worklet resamples to and the upstream is told to expect. */
export const VOICE_DICTATION_SAMPLE_RATE_V1 = 16_000;

/** What the browser says. Audio is binary and carries no envelope. */
export type VoiceDictationClientFrameV1 =
  /** Stop capturing, transcribe what is buffered, and answer `final`. */
  | { schemaVersion: 1; type: "commit" }
  /** Throw the buffer away. The draft is the client's business, not ours. */
  | { schemaVersion: 1; type: "cancel" };

/** What the Durable Object says. */
export type VoiceDictationServerFrameV1 =
  /** The upstream session is open and audio may start. */
  | { schemaVersion: 1; type: "ready" }
  /** Text to append to the draft as it is heard. */
  | { schemaVersion: 1; type: "delta"; text: string }
  /** One finished segment, replacing the deltas that built it. */
  | { schemaVersion: 1; type: "transcript"; text: string }
  /** Everything buffered has been transcribed; the client may send. */
  | { schemaVersion: 1; type: "final" }
  /**
   * Dictation cannot continue, and `message` is plain English a person can
   * act on — an exhausted quota, an unconfigured deployment, a refused
   * upstream. The socket closes after it.
   */
  | { schemaVersion: 1; type: "error"; message: string };

function frameObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const frame = value as Record<string, unknown>;
  if (frame.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  return frame;
}

function frameText(
  frame: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = frame[key];
  // Bounded because a delta is appended to a draft the composer then sends:
  // an upstream that streams without end must not be able to grow the draft
  // without end either.
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error(`${label}.${key} is invalid`);
  }
  return value;
}

export function decodeVoiceDictationClientFrameV1(
  value: unknown,
): VoiceDictationClientFrameV1 {
  const label = "voice dictation client frame";
  const frame = frameObject(value, label);
  if (frame.type === "commit" || frame.type === "cancel") {
    return { schemaVersion: 1, type: frame.type };
  }
  throw new Error(`${label}.type is invalid`);
}

export function decodeVoiceDictationServerFrameV1(
  value: unknown,
): VoiceDictationServerFrameV1 {
  const label = "voice dictation server frame";
  const frame = frameObject(value, label);
  switch (frame.type) {
    case "ready":
    case "final":
      return { schemaVersion: 1, type: frame.type };
    case "delta":
      return {
        schemaVersion: 1,
        type: "delta",
        text: frameText(frame, "text", label),
      };
    case "transcript":
      return {
        schemaVersion: 1,
        type: "transcript",
        text: frameText(frame, "text", label),
      };
    case "error":
      return {
        schemaVersion: 1,
        type: "error",
        message: frameText(frame, "message", label),
      };
    default:
      throw new Error(`${label}.type is invalid`);
  }
}

/** Parses a text frame off a socket. Invalid JSON is an invalid frame. */
export function parseVoiceDictationServerFrameV1(
  text: string,
): VoiceDictationServerFrameV1 {
  return decodeVoiceDictationServerFrameV1(JSON.parse(text) as unknown);
}

export function parseVoiceDictationClientFrameV1(
  text: string,
): VoiceDictationClientFrameV1 {
  return decodeVoiceDictationClientFrameV1(JSON.parse(text) as unknown);
}

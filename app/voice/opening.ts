// Attempt-owned voice opening: the wire envelope, the setup fingerprint and
// the constants both clients and the Worker agree on.
//
// JSON frames live in `shared.ts`. This file is the rest of S6 that is not a
// Durable Object: PCM framing, the opening budget derived from the input
// format, and the semantic identity a resumption handle is allowed to match.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1,
  VOICE_ASSISTANT_OPENING_BUFFER_SECONDS_V1,
} from "./shared.js";

export type {
  VoiceControlActionV1,
  VoiceOpeningFailCodeV1,
  VoiceOpeningModeV1,
} from "./shared.js";

export {
  VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1,
  VOICE_ASSISTANT_OPENING_BUFFER_SECONDS_V1,
  VOICE_ASSISTANT_OPENING_DEADLINE_MS_V1,
} from "./shared.js";

/** One byte of version, sixteen of attempt UUID, four of sequence. */
export const VOICE_ASSISTANT_PCM_ENVELOPE_VERSION_V1 = 1;
export const VOICE_ASSISTANT_PCM_HEADER_BYTES_V1 = 1 + 16 + 4;

/** Start a fresh attempt before an unsigned 32-bit sequence wraps. */
export const VOICE_ASSISTANT_PCM_SEQUENCE_WRAP_V1 = 0xfffffff0;

export type VoiceOpeningPhaseV1 =
  | "admitting"
  | "preparing"
  | "configuring"
  | "ready"
  | "closed";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isVoiceAttemptIdV1(value: string): boolean {
  return UUID_V4.test(value);
}

/** Sixteen raw bytes of a UUID string, or undefined when the spelling is wrong. */
export function voiceAttemptIdBytesV1(id: string): Uint8Array | undefined {
  if (!isVoiceAttemptIdV1(id)) return undefined;
  const hex = id.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function voiceAttemptIdFromBytesV1(
  bytes: Uint8Array,
): string | undefined {
  if (bytes.byteLength !== 16) return undefined;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isVoiceAttemptIdV1(id) ? id : undefined;
}

export interface VoicePcmEnvelopeV1 {
  version: 1;
  attemptId: string;
  sequence: number;
  pcm: Uint8Array;
}

/**
 * Assistant PCM in both directions: version, attempt UUID, little-endian
 * unsigned 32-bit sequence, then PCM16 little-endian bytes.
 */
export function encodeVoiceAssistantPcmEnvelopeV1(input: {
  attemptId: string;
  sequence: number;
  pcm: Uint8Array;
}): Uint8Array {
  const attempt = voiceAttemptIdBytesV1(input.attemptId);
  if (!attempt) throw new Error("voice pcm envelope attemptId is invalid");
  if (
    !Number.isInteger(input.sequence) ||
    input.sequence < 0 ||
    input.sequence > 0xffffffff
  ) {
    throw new Error("voice pcm envelope sequence is invalid");
  }
  if (input.pcm.byteLength % 2 !== 0) {
    throw new Error("voice pcm envelope payload is misaligned");
  }
  const frame = new Uint8Array(
    VOICE_ASSISTANT_PCM_HEADER_BYTES_V1 + input.pcm.byteLength,
  );
  frame[0] = VOICE_ASSISTANT_PCM_ENVELOPE_VERSION_V1;
  frame.set(attempt, 1);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(17, input.sequence, true);
  frame.set(input.pcm, VOICE_ASSISTANT_PCM_HEADER_BYTES_V1);
  return frame;
}

/**
 * One inbound assistant PCM frame. Wrong version, short/odd payload or a
 * malformed attempt UUID answers undefined rather than throwing: a live call
 * drops the frame instead of dying on one.
 */
export function decodeVoiceAssistantPcmEnvelopeV1(
  bytes: Uint8Array,
): VoicePcmEnvelopeV1 | undefined {
  if (bytes.byteLength < VOICE_ASSISTANT_PCM_HEADER_BYTES_V1) return undefined;
  if (bytes[0] !== VOICE_ASSISTANT_PCM_ENVELOPE_VERSION_V1) return undefined;
  const pcmLength = bytes.byteLength - VOICE_ASSISTANT_PCM_HEADER_BYTES_V1;
  if (pcmLength === 0 || pcmLength % 2 !== 0) return undefined;
  const attemptId = voiceAttemptIdFromBytesV1(bytes.subarray(1, 17));
  if (!attemptId) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: 1,
    attemptId,
    sequence: view.getUint32(17, true),
    pcm: bytes.subarray(VOICE_ASSISTANT_PCM_HEADER_BYTES_V1),
  };
}

export type VoicePcmSequenceDecisionV1 =
  | { kind: "accept"; sequence: number }
  | { kind: "drop" }
  | { kind: "gap"; sequence: number };

/**
 * Inbound sequence against the last accepted one for this attempt. The first
 * frame of an attempt may be 0. Duplicates drop; a skip is a gap.
 */
export function decideVoicePcmSequenceV1(
  lastAccepted: number | undefined,
  sequence: number,
): VoicePcmSequenceDecisionV1 {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    return { kind: "drop" };
  }
  if (lastAccepted === undefined) {
    return sequence === 0 ? { kind: "accept", sequence } : { kind: "gap", sequence };
  }
  if (sequence === lastAccepted) return { kind: "drop" };
  if (sequence === lastAccepted + 1) return { kind: "accept", sequence };
  if (sequence < lastAccepted) return { kind: "drop" };
  return { kind: "gap", sequence };
}

export interface VoiceSetupFingerprintInputV1 {
  botId: string;
  model: string;
  voiceName: string;
  tools: readonly string[];
  googleSearch: boolean;
  /**
   * Semantic Memory identity: durable fact ids and forgotten tombstones, not
   * a clock string and not the rendered prompt.
   */
  memoryIdentity: string;
}

/**
 * Stable setup identity a resumption handle is allowed to match. Clock strings
 * and incidental prompt rendering stay out of it.
 */
export async function voiceSetupFingerprintV1(
  input: VoiceSetupFingerprintInputV1,
): Promise<string> {
  const tools = [...input.tools].sort().join(",");
  return sha256HexTextV1(
    [
      input.botId,
      input.model,
      input.voiceName,
      tools,
      input.googleSearch ? "1" : "0",
      input.memoryIdentity,
    ].join("\0"),
  );
}

/** The opening budget, as a check the format constants still produce 320,000. */
export function voiceAssistantOpeningBudgetBytesV1(): number {
  return (
    VOICE_ASSISTANT_OPENING_BUFFER_SECONDS_V1 *
    VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 *
    2
  );
}

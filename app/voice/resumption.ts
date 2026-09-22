// Durable Gemini Live resumption: a call-owned handle, never a client secret.
//
// A handle is offered only for matching call/setup ownership and reconciled
// effect state. `resumable: false` is persisted as that, not treated as a
// missing update. Handles stay out of logs and client state.

export const VOICE_RESUMPTION_PREFIX_V1 = "voice:resumption:";
export const VOICE_ENDED_RECEIPT_KEY_V1 = "voice:call:ended";

export function voiceResumptionKeyV1(callId: string): string {
  return `${VOICE_RESUMPTION_PREFIX_V1}${callId}`;
}

export interface VoiceResumptionRecordV1 {
  schemaVersion: 1;
  callId: string;
  botId: string;
  model: string;
  fingerprint: string;
  handle?: string;
  resumable: boolean;
  updatedAt: string;
  lastSettledTurnSequence: number;
}

export interface VoiceEndedReceiptV1 {
  schemaVersion: 1;
  callId: string;
  deviceKey: string;
  endedAt: string;
}

export function decodeVoiceResumptionRecordV1(
  input: unknown,
): VoiceResumptionRecordV1 | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) return undefined;
  if (typeof value.callId !== "string" || !value.callId) return undefined;
  if (typeof value.botId !== "string") return undefined;
  if (typeof value.model !== "string" || !value.model) return undefined;
  if (typeof value.fingerprint !== "string" || !value.fingerprint) {
    return undefined;
  }
  if (typeof value.updatedAt !== "string" || !value.updatedAt) return undefined;
  if (
    typeof value.lastSettledTurnSequence !== "number" ||
    !Number.isInteger(value.lastSettledTurnSequence) ||
    value.lastSettledTurnSequence < 0
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    callId: value.callId,
    botId: value.botId,
    model: value.model,
    fingerprint: value.fingerprint,
    ...(typeof value.handle === "string" && value.handle
      ? { handle: value.handle }
      : {}),
    resumable: value.resumable === true,
    updatedAt: value.updatedAt,
    lastSettledTurnSequence: value.lastSettledTurnSequence,
  };
}

export function decodeVoiceEndedReceiptV1(
  input: unknown,
): VoiceEndedReceiptV1 | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) return undefined;
  if (typeof value.callId !== "string" || !value.callId) return undefined;
  if (typeof value.deviceKey !== "string" || !value.deviceKey) return undefined;
  if (typeof value.endedAt !== "string" || !value.endedAt) return undefined;
  return {
    schemaVersion: 1,
    callId: value.callId,
    deviceKey: value.deviceKey,
    endedAt: value.endedAt,
  };
}

export type VoiceResumptionOfferV1 =
  | { status: "offer"; handle: string }
  | { status: "fresh"; reason: VoiceResumptionRejectV1 };

export type VoiceResumptionRejectV1 =
  | "missing"
  | "not-resumable"
  | "fingerprint"
  | "call"
  | "bot"
  | "model"
  | "uncertain";

/**
 * Whether this record may be offered back to Gemini. A handle alone never
 * proves an effect outcome: uncertain in-flight work forces a fresh opening.
 */
export function offerVoiceResumptionV1(input: {
  record: VoiceResumptionRecordV1 | undefined;
  callId: string;
  botId: string;
  model: string;
  fingerprint: string;
  uncertainEffects: boolean;
}): VoiceResumptionOfferV1 {
  const record = input.record;
  if (!record) return { status: "fresh", reason: "missing" };
  if (record.callId !== input.callId) return { status: "fresh", reason: "call" };
  if (record.botId !== input.botId) return { status: "fresh", reason: "bot" };
  if (record.model !== input.model) return { status: "fresh", reason: "model" };
  if (record.fingerprint !== input.fingerprint) {
    return { status: "fresh", reason: "fingerprint" };
  }
  if (input.uncertainEffects) return { status: "fresh", reason: "uncertain" };
  if (!record.resumable || !record.handle) {
    return { status: "fresh", reason: "not-resumable" };
  }
  return { status: "offer", handle: record.handle };
}

export function voiceMemoryIdentityV1(input: {
  durableIds: readonly string[];
  forgottenIds: readonly string[];
}): string {
  const durable = [...input.durableIds].sort().join(",");
  const forgotten = [...input.forgottenIds].sort().join(",");
  return `${durable}|${forgotten}`;
}

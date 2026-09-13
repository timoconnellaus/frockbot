// Written in the Bot settlement transaction so eviction cannot lose the wake.
// The voice object reads the answer from the authoritative run, by request id.
import type { StoredRunOriginV1 } from "@frockbot/core/durable";

export const VOICE_REPLY_OUTBOX_PREFIX_V1 = "voice-reply:";

/** One answer a voice call is owed, durable from the instant it exists. */
export interface VoiceReplyOutboxEntryV1 {
  schemaVersion: 1;
  /** The Turn that produced the answer. Also the request id it answers. */
  runId: string;
  callId: string;
  voiceTurnId: string;
  settledAt: string;
}

export function voiceReplyOutboxKeyV1(runId: string): string {
  return `${VOICE_REPLY_OUTBOX_PREFIX_V1}${runId}`;
}

/** The voice return address a run was admitted under, if it had one. */
export function voiceOriginOfRunV1(run: {
  admission?: { origin?: { kind: string } };
}): Extract<StoredRunOriginV1, { kind: "voice" }> | undefined {
  const origin = run.admission?.origin;
  return origin?.kind === "voice"
    ? (origin as Extract<StoredRunOriginV1, { kind: "voice" }>)
    : undefined;
}

/**
 * The outbox entry a settling voice request contributes, and nothing at all
 * for every other Turn — so a chat Turn's settlement writes exactly the bytes
 * it wrote before voice existed.
 */
export function voiceReplyOutboxRecordsV1(input: {
  run: { runId: string; admission?: { origin?: { kind: string } } };
  now: string;
}): Record<string, unknown> {
  const origin = voiceOriginOfRunV1(input.run);
  if (!origin) return {};
  return {
    [voiceReplyOutboxKeyV1(input.run.runId)]: {
      schemaVersion: 1,
      runId: input.run.runId,
      callId: origin.callId,
      voiceTurnId: origin.voiceTurnId,
      settledAt: input.now,
    } satisfies VoiceReplyOutboxEntryV1,
  };
}

/** True for a record this build wrote; anything else is dropped on read. */
export function isVoiceReplyOutboxEntryV1(
  value: unknown,
): value is VoiceReplyOutboxEntryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.runId === "string" &&
    typeof candidate.callId === "string" &&
    typeof candidate.voiceTurnId === "string" &&
    typeof candidate.settledAt === "string"
  );
}

export const VOICE_MAX_TRANSCRIPT_ENTRIES_V1 = 160;
export const VOICE_MAX_TOOL_CALLS_V1 = 80;
export const VOICE_MAX_PENDING_ANSWERS_V1 = 32;
export const VOICE_MAX_SESSIONS_V1 = 24;

export type VoiceOfflineReasonV1 =
  "stopped" | "idle" | "quota" | "error" | "replaced";

export interface VoiceTranscriptEntryV1 {
  schemaVersion: 1;
  id: string;
  speaker: "user" | "assistant";
  text: string;
  at: string;
}

export interface VoiceToolCallEntryV1 {
  schemaVersion: 1;
  id: string;
  name: VoiceToolNameV1;
  label: string;
  at: string;
}

export interface VoicePendingAnswerV1 {
  schemaVersion: 1;
  answerId: string;
  botId: string;
  botName: string;
  question: string;
  answer: string;
  answeredAt: string;
  briefedAt?: string;
}

export interface VoiceSessionRecordV1 {
  schemaVersion: 1;
  sessionId: string;
  deviceId: string;
  startedAt: string;
  endedAt?: string;
  endedReason?: VoiceOfflineReasonV1;
  seconds: number;
  transcript: VoiceTranscriptEntryV1[];
  toolCalls: VoiceToolCallEntryV1[];
}

export interface VoiceStateV1 {
  schemaVersion: 1;
  enabled: boolean;
  updatedAt: string;
  activeSessionId?: string;
  activeDeviceId?: string;
  resumptionHandle?: string;
}

export interface VoiceLedgerViewV1 {
  schemaVersion: 1;
  state: VoiceStateV1;
  sessions: VoiceSessionRecordV1[];
  pendingAnswers: VoicePendingAnswerV1[];
}

export type VoiceToolNameV1 =
  "list_bots" | "bot_activity" | "memory_search" | "pending_answers";

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function boundedString(input: unknown, label: string, max: number): string {
  if (typeof input !== "string" || input.length === 0 || input.length > max) {
    throw new Error(`${label} must be a bounded string`);
  }
  return input;
}

function optionalString(
  input: unknown,
  label: string,
  max: number,
): string | undefined {
  return input === undefined ? undefined : boundedString(input, label, max);
}

export function decodeVoiceStateV1(input: unknown): VoiceStateV1 {
  const value = record(input, "voice state");
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") {
    throw new Error("voice state is invalid");
  }
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    updatedAt: boundedString(value.updatedAt, "voice state.updatedAt", 64),
    ...(optionalString(
      value.activeSessionId,
      "voice state.activeSessionId",
      128,
    )
      ? { activeSessionId: value.activeSessionId as string }
      : {}),
    ...(optionalString(value.activeDeviceId, "voice state.activeDeviceId", 128)
      ? { activeDeviceId: value.activeDeviceId as string }
      : {}),
    ...(optionalString(
      value.resumptionHandle,
      "voice state.resumptionHandle",
      16_384,
    )
      ? { resumptionHandle: value.resumptionHandle as string }
      : {}),
  };
}

export function decodeVoiceLedgerViewV1(input: unknown): VoiceLedgerViewV1 {
  const value = record(input, "voice ledger");
  if (value.schemaVersion !== 1) {
    throw new Error("voice ledger.schemaVersion is unsupported");
  }
  if (!Array.isArray(value.sessions) || !Array.isArray(value.pendingAnswers)) {
    throw new Error("voice ledger lists are invalid");
  }
  return {
    schemaVersion: 1,
    state: decodeVoiceStateV1(value.state),
    sessions: value.sessions.slice(
      0,
      VOICE_MAX_SESSIONS_V1,
    ) as VoiceSessionRecordV1[],
    pendingAnswers: value.pendingAnswers.slice(
      0,
      VOICE_MAX_PENDING_ANSWERS_V1,
    ) as VoicePendingAnswerV1[],
  };
}

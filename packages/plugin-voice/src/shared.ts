export const VOICE_MAX_TRANSCRIPT_ENTRIES_V1 = 160;
export const VOICE_MAX_TOOL_CALLS_V1 = 80;
export const VOICE_MAX_PENDING_ANSWERS_V1 = 32;
export const VOICE_MAX_SESSIONS_V1 = 24;
export const VOICE_MAX_ASK_RECORDS_V1 = 160;
export const VOICE_ANSWER_OUTBOX_MAX_V1 = 32;

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

export interface VoiceAskEventV1 {
  schemaVersion: 1;
  type: "voice/ask";
  askId: string;
  sessionId: string;
  botId: string;
  botName: string;
  question: string;
  runId: string;
  askedAt: string;
}

export interface VoiceAnsweredEventV1 {
  schemaVersion: 1;
  type: "voice/answered";
  askId: string;
  botId: string;
  runId: string;
  answer: string;
  answeredAt: string;
}

export interface VoiceBriefedEventV1 {
  schemaVersion: 1;
  type: "voice/briefed";
  askId: string;
  sessionId: string;
  briefedAt: string;
}

export interface VoiceAskFailedEventV1 {
  schemaVersion: 1;
  type: "voice/failed";
  askId: string;
  botId: string;
  runId: string;
  reason: string;
  failedAt: string;
}

/** One durable Voice question and the events that have settled it so far. */
export interface VoiceAskRecordV1 {
  schemaVersion: 1;
  ask: VoiceAskEventV1;
  answered?: VoiceAnsweredEventV1;
  briefed?: VoiceBriefedEventV1;
  failed?: VoiceAskFailedEventV1;
}

/** The Bot Durable Object's idempotent delivery into the User authority. */
export type VoiceAnswerDeliveryV1 =
  | {
      schemaVersion: 1;
      outcome: "answered";
      userId: string;
      askId: string;
      botId: string;
      runId: string;
      answer: string;
      at: string;
    }
  | {
      schemaVersion: 1;
      outcome: "failed";
      userId: string;
      askId: string;
      botId: string;
      runId: string;
      reason: string;
      at: string;
    };

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

export interface VoiceAssistantQuotaViewV1 {
  schemaVersion: 1;
  month: string;
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number;
}

export interface VoiceAssistantViewV1 {
  schemaVersion: 1;
  ledger: VoiceLedgerViewV1;
  quota: VoiceAssistantQuotaViewV1;
}

export type VoiceToolNameV1 =
  | "list_bots"
  | "bot_activity"
  | "memory_search"
  | "pending_answers"
  | "ask_bot";

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
    sessions: value.sessions
      .slice(0, VOICE_MAX_SESSIONS_V1)
      .map(decodeVoiceSessionRecordV1),
    pendingAnswers: value.pendingAnswers
      .slice(0, VOICE_MAX_PENDING_ANSWERS_V1)
      .map(decodeVoicePendingAnswerV1),
  };
}

function timestamp(input: unknown, label: string): string {
  const value = boundedString(input, label, 64);
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${label} is invalid`);
  return value;
}

function natural(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return input as number;
}

function decodeVoiceTranscriptEntryV1(input: unknown): VoiceTranscriptEntryV1 {
  const value = record(input, "voice transcript entry");
  if (
    value.schemaVersion !== 1 ||
    (value.speaker !== "user" && value.speaker !== "assistant")
  ) {
    throw new Error("voice transcript entry is invalid");
  }
  return {
    schemaVersion: 1,
    id: boundedString(value.id, "voice transcript entry.id", 128),
    speaker: value.speaker,
    text: boundedString(value.text, "voice transcript entry.text", 4_000),
    at: timestamp(value.at, "voice transcript entry.at"),
  };
}

function decodeVoiceToolCallEntryV1(input: unknown): VoiceToolCallEntryV1 {
  const value = record(input, "voice tool call");
  const names: VoiceToolNameV1[] = [
    "list_bots",
    "bot_activity",
    "memory_search",
    "pending_answers",
    "ask_bot",
  ];
  if (
    value.schemaVersion !== 1 ||
    !names.includes(value.name as VoiceToolNameV1)
  ) {
    throw new Error("voice tool call is invalid");
  }
  return {
    schemaVersion: 1,
    id: boundedString(value.id, "voice tool call.id", 128),
    name: value.name as VoiceToolNameV1,
    label: boundedString(value.label, "voice tool call.label", 160),
    at: timestamp(value.at, "voice tool call.at"),
  };
}

function decodeVoiceSessionRecordV1(input: unknown): VoiceSessionRecordV1 {
  const value = record(input, "voice session");
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.transcript) ||
    !Array.isArray(value.toolCalls)
  ) {
    throw new Error("voice session is invalid");
  }
  const reasons: VoiceOfflineReasonV1[] = [
    "stopped",
    "idle",
    "quota",
    "error",
    "replaced",
  ];
  if (
    value.endedReason !== undefined &&
    !reasons.includes(value.endedReason as VoiceOfflineReasonV1)
  ) {
    throw new Error("voice session.endedReason is invalid");
  }
  return {
    schemaVersion: 1,
    sessionId: boundedString(value.sessionId, "voice session.sessionId", 128),
    deviceId: boundedString(value.deviceId, "voice session.deviceId", 128),
    startedAt: timestamp(value.startedAt, "voice session.startedAt"),
    ...(value.endedAt === undefined
      ? {}
      : { endedAt: timestamp(value.endedAt, "voice session.endedAt") }),
    ...(value.endedReason === undefined
      ? {}
      : { endedReason: value.endedReason as VoiceOfflineReasonV1 }),
    seconds: natural(value.seconds, "voice session.seconds"),
    transcript: value.transcript
      .slice(-VOICE_MAX_TRANSCRIPT_ENTRIES_V1)
      .map(decodeVoiceTranscriptEntryV1),
    toolCalls: value.toolCalls
      .slice(-VOICE_MAX_TOOL_CALLS_V1)
      .map(decodeVoiceToolCallEntryV1),
  };
}

export function decodeVoicePendingAnswerV1(
  input: unknown,
): VoicePendingAnswerV1 {
  const value = record(input, "voice pending answer");
  if (value.schemaVersion !== 1)
    throw new Error("voice pending answer is invalid");
  return {
    schemaVersion: 1,
    answerId: boundedString(
      value.answerId,
      "voice pending answer.answerId",
      128,
    ),
    botId: boundedString(value.botId, "voice pending answer.botId", 128),
    botName: boundedString(value.botName, "voice pending answer.botName", 160),
    question: boundedString(
      value.question,
      "voice pending answer.question",
      2_000,
    ),
    answer: boundedString(value.answer, "voice pending answer.answer", 4_000),
    answeredAt: timestamp(value.answeredAt, "voice pending answer.answeredAt"),
    ...(value.briefedAt === undefined
      ? {}
      : {
          briefedAt: timestamp(
            value.briefedAt,
            "voice pending answer.briefedAt",
          ),
        }),
  };
}

export function decodeVoiceAskRecordV1(input: unknown): VoiceAskRecordV1 {
  const value = record(input, "voice ask record");
  const ask = record(value.ask, "voice ask record.ask");
  if (
    value.schemaVersion !== 1 ||
    ask.schemaVersion !== 1 ||
    ask.type !== "voice/ask"
  ) {
    throw new Error("voice ask record is invalid");
  }
  const decodedAsk: VoiceAskEventV1 = {
    schemaVersion: 1,
    type: "voice/ask",
    askId: boundedString(ask.askId, "voice ask.askId", 128),
    sessionId: boundedString(ask.sessionId, "voice ask.sessionId", 128),
    botId: boundedString(ask.botId, "voice ask.botId", 128),
    botName: boundedString(ask.botName, "voice ask.botName", 160),
    question: boundedString(ask.question, "voice ask.question", 2_000),
    runId: boundedString(ask.runId, "voice ask.runId", 128),
    askedAt: timestamp(ask.askedAt, "voice ask.askedAt"),
  };
  let answered: VoiceAnsweredEventV1 | undefined;
  if (value.answered !== undefined) {
    const event = record(value.answered, "voice ask record.answered");
    if (event.schemaVersion !== 1 || event.type !== "voice/answered") {
      throw new Error("voice answered event is invalid");
    }
    answered = {
      schemaVersion: 1,
      type: "voice/answered",
      askId: boundedString(event.askId, "voice answered.askId", 128),
      botId: boundedString(event.botId, "voice answered.botId", 128),
      runId: boundedString(event.runId, "voice answered.runId", 128),
      answer: boundedString(event.answer, "voice answered.answer", 4_000),
      answeredAt: timestamp(event.answeredAt, "voice answered.answeredAt"),
    };
  }
  let briefed: VoiceBriefedEventV1 | undefined;
  if (value.briefed !== undefined) {
    const event = record(value.briefed, "voice ask record.briefed");
    if (event.schemaVersion !== 1 || event.type !== "voice/briefed") {
      throw new Error("voice briefed event is invalid");
    }
    briefed = {
      schemaVersion: 1,
      type: "voice/briefed",
      askId: boundedString(event.askId, "voice briefed.askId", 128),
      sessionId: boundedString(event.sessionId, "voice briefed.sessionId", 128),
      briefedAt: timestamp(event.briefedAt, "voice briefed.briefedAt"),
    };
  }
  let failed: VoiceAskFailedEventV1 | undefined;
  if (value.failed !== undefined) {
    const event = record(value.failed, "voice ask record.failed");
    if (event.schemaVersion !== 1 || event.type !== "voice/failed") {
      throw new Error("voice failed event is invalid");
    }
    failed = {
      schemaVersion: 1,
      type: "voice/failed",
      askId: boundedString(event.askId, "voice failed.askId", 128),
      botId: boundedString(event.botId, "voice failed.botId", 128),
      runId: boundedString(event.runId, "voice failed.runId", 128),
      reason: boundedString(event.reason, "voice failed.reason", 2_000),
      failedAt: timestamp(event.failedAt, "voice failed.failedAt"),
    };
  }
  for (const event of [answered, briefed, failed]) {
    if (event && event.askId !== decodedAsk.askId) {
      throw new Error("voice ask event identity does not match its record");
    }
  }
  return {
    schemaVersion: 1,
    ask: decodedAsk,
    ...(answered ? { answered } : {}),
    ...(briefed ? { briefed } : {}),
    ...(failed ? { failed } : {}),
  };
}

export function decodeVoiceAnswerDeliveryV1(
  input: unknown,
): VoiceAnswerDeliveryV1 {
  const value = record(input, "voice answer delivery");
  if (
    value.schemaVersion !== 1 ||
    (value.outcome !== "answered" && value.outcome !== "failed")
  ) {
    throw new Error("voice answer delivery is invalid");
  }
  const base = {
    schemaVersion: 1 as const,
    userId: boundedString(value.userId, "voice answer delivery.userId", 128),
    askId: boundedString(value.askId, "voice answer delivery.askId", 128),
    botId: boundedString(value.botId, "voice answer delivery.botId", 128),
    runId: boundedString(value.runId, "voice answer delivery.runId", 128),
    at: timestamp(value.at, "voice answer delivery.at"),
  };
  return value.outcome === "answered"
    ? {
        ...base,
        outcome: "answered",
        answer: boundedString(
          value.answer,
          "voice answer delivery.answer",
          4_000,
        ),
      }
    : {
        ...base,
        outcome: "failed",
        reason: boundedString(
          value.reason,
          "voice answer delivery.reason",
          2_000,
        ),
      };
}

export function decodeVoiceAssistantViewV1(
  input: unknown,
): VoiceAssistantViewV1 {
  const value = record(input, "voice assistant view");
  const quota = record(value.quota, "voice assistant quota");
  if (value.schemaVersion !== 1 || quota.schemaVersion !== 1) {
    throw new Error("voice assistant view version is unsupported");
  }
  return {
    schemaVersion: 1,
    ledger: decodeVoiceLedgerViewV1(value.ledger),
    quota: {
      schemaVersion: 1,
      month: boundedString(quota.month, "voice assistant quota.month", 7),
      usedSeconds: natural(
        quota.usedSeconds,
        "voice assistant quota.usedSeconds",
      ),
      limitSeconds: natural(
        quota.limitSeconds,
        "voice assistant quota.limitSeconds",
      ),
      remainingSeconds: natural(
        quota.remainingSeconds,
        "voice assistant quota.remainingSeconds",
      ),
    },
  };
}

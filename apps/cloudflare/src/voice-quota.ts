// The durable per-User voice budget (voice plan D1), as User Durable Object
// state.
//
// Voice costs money per second of audio, and a stuck microphone spends it with
// nobody watching. So the budget lives where the User's authority already is —
// the `UserConfiguration` object — and the `VoiceSession` Durable Object,
// which holds no authority of its own (D2, and ADR 0017's rule for subagent
// objects), *asks* before it opens a microphone and *reports* when it closes
// one.
//
// The unit is a whole second of captured audio, counted against a rolling
// calendar day in UTC. A day counter is the smallest durable thing that
// bounds a runaway: it only ever rises, it needs no scheduled reset, and an
// old day's key is deleted the next time the User dictates.
//
// The reporting half is idempotent on the session id, in the shape
// `plugin-subagents/src/quota.ts` uses for slots: a session that reports twice
// — a retried close, an object that came back after an eviction — is charged
// the difference and never twice for the same seconds.

export const VOICE_QUOTA_PREFIX = "voice:quota:";
export const VOICE_SESSION_PREFIX = "voice:session:";

/**
 * The default daily budget, generous on purpose.
 *
 * Dictation is measured in sentences, not hours: sixty minutes of *captured
 * audio* in a day is far more than a person dictating messages will reach, and
 * far less than an open microphone left running overnight. One constant, no
 * setting — the plan leaves a per-User override to a later slice.
 */
export const VOICE_MINUTES_PER_DAY_V1 = 60;

export const VOICE_SECONDS_PER_DAY_V1 = VOICE_MINUTES_PER_DAY_V1 * 60;

/**
 * The assistant is an open-microphone conversation rather than a brief
 * composer capture, so it has its own monthly ceiling. The number remains one
 * platform constant and not a setting; product policy can replace it later
 * without moving authority out of the User Durable Object.
 */
export const VOICE_ASSISTANT_MINUTES_PER_MONTH_V1 = 60;
export const VOICE_ASSISTANT_SECONDS_PER_MONTH_V1 =
  VOICE_ASSISTANT_MINUTES_PER_MONTH_V1 * 60;
export const VOICE_ASSISTANT_QUOTA_PREFIX_V1 = "voice:assistant:quota:";
export const VOICE_ASSISTANT_USAGE_PREFIX_V1 = "voice:assistant:usage:";
export const VOICE_QUOTA_MONTH = /^\d{4}-\d{2}$/;

/** `YYYY-MM-DD`, the same shape the authoring quota's day key has. */
export const VOICE_QUOTA_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function voiceQuotaDayV1(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function voiceQuotaMonthV1(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

export function voiceQuotaKeyV1(day: string): string {
  if (!VOICE_QUOTA_DAY.test(day)) throw new Error("voice quota day is invalid");
  return `${VOICE_QUOTA_PREFIX}${day}`;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function voiceSessionKeyV1(day: string, sessionId: string): string {
  if (!VOICE_QUOTA_DAY.test(day)) throw new Error("voice quota day is invalid");
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("voice session id is invalid");
  }
  return `${VOICE_SESSION_PREFIX}${day}:${sessionId}`;
}

export function voiceAssistantQuotaKeyV1(month: string): string {
  if (!VOICE_QUOTA_MONTH.test(month)) {
    throw new Error("voice assistant quota month is invalid");
  }
  return `${VOICE_ASSISTANT_QUOTA_PREFIX_V1}${month}`;
}

export function voiceAssistantUsageKeyV1(
  month: string,
  sessionId: string,
): string {
  if (!VOICE_QUOTA_MONTH.test(month)) {
    throw new Error("voice assistant quota month is invalid");
  }
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("voice assistant session id is invalid");
  }
  return `${VOICE_ASSISTANT_USAGE_PREFIX_V1}${month}:${sessionId}`;
}

/** The refusal a person reads. Plain English, and it says when it lifts. */
export function voiceQuotaRefusalV1(): string {
  return (
    `You've used up today's ${VOICE_MINUTES_PER_DAY_V1} minutes of dictation. ` +
    `Type your message for now — the microphone comes back tomorrow.`
  );
}

export function voiceAssistantQuotaRefusalV1(): string {
  return (
    `You've used this month's ${VOICE_ASSISTANT_MINUTES_PER_MONTH_V1} minutes of Voice. ` +
    "Voice will be ready again next month."
  );
}

export interface VoiceAssistantQuotaReceiptV1 {
  schemaVersion: 1;
  status: "reserved" | "refused";
  month: string;
  sessionId: string;
  usedSeconds: number;
  limitSeconds: number;
  reason?: string;
}

export interface VoiceAssistantUsageReceiptV1 {
  schemaVersion: 1;
  status: "recorded";
  month: string;
  sessionId: string;
  usedSeconds: number;
  limitSeconds: number;
}

export interface VoiceQuotaReceiptV1 {
  schemaVersion: 1;
  status: "reserved" | "refused";
  day: string;
  sessionId: string;
  /** Whole seconds already spent today, before this session. */
  usedSeconds: number;
  limitSeconds: number;
  /** Present only when refused, and written for a person to read. */
  reason?: string;
}

export interface VoiceUsageReceiptV1 {
  schemaVersion: 1;
  status: "recorded";
  day: string;
  sessionId: string;
  usedSeconds: number;
  limitSeconds: number;
}

interface StoredVoiceDayV1 {
  schemaVersion: 1;
  day: string;
  seconds: number;
}

interface StoredVoiceSessionV1 {
  schemaVersion: 1;
  day: string;
  sessionId: string;
  seconds: number;
}

/** The narrow storage surface, so one in-memory fake satisfies the tests. */
export interface VoiceQuotaTransaction {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface VoiceQuotaStorage extends VoiceQuotaTransaction {
  transaction<T>(
    callback: (storage: VoiceQuotaTransaction) => Promise<T>,
  ): Promise<T>;
}

function storedSeconds(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const seconds = (value as StoredVoiceDayV1).seconds;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 0;
}

/**
 * Takes today's budget into account and admits — or refuses — one capture.
 *
 * A breach is never a throw: an exhausted budget is an ordinary outcome the
 * composer shows as a sentence, exactly as a refused subagent slot is.
 */
export async function reserveVoiceCaptureV1(
  storage: VoiceQuotaStorage,
  request: { day: string; sessionId: string },
): Promise<VoiceQuotaReceiptV1> {
  const dayKey = voiceQuotaKeyV1(request.day);
  const sessionKey = voiceSessionKeyV1(request.day, request.sessionId);
  return storage.transaction(async (transaction) => {
    const used = storedSeconds(await transaction.get<StoredVoiceDayV1>(dayKey));
    if (used >= VOICE_SECONDS_PER_DAY_V1) {
      return {
        schemaVersion: 1,
        status: "refused",
        day: request.day,
        sessionId: request.sessionId,
        usedSeconds: used,
        limitSeconds: VOICE_SECONDS_PER_DAY_V1,
        reason: voiceQuotaRefusalV1(),
      } satisfies VoiceQuotaReceiptV1;
    }
    // Yesterday's counters are swept on the way in rather than by an alarm:
    // the object is already open and writing, and nothing else needs waking.
    await sweepOldDaysV1(transaction, request.day);
    if ((await transaction.get(sessionKey)) === undefined) {
      await transaction.put(sessionKey, {
        schemaVersion: 1,
        day: request.day,
        sessionId: request.sessionId,
        seconds: 0,
      } satisfies StoredVoiceSessionV1);
    }
    return {
      schemaVersion: 1,
      status: "reserved",
      day: request.day,
      sessionId: request.sessionId,
      usedSeconds: used,
      limitSeconds: VOICE_SECONDS_PER_DAY_V1,
    } satisfies VoiceQuotaReceiptV1;
  });
}

/**
 * Charges a session for the audio it has captured so far.
 *
 * `seconds` is the session's running total, not a delta, so a report that
 * arrives twice — or out of order after a retry — settles on the larger
 * number rather than compounding.
 */
export async function recordVoiceUsageV1(
  storage: VoiceQuotaStorage,
  request: { day: string; sessionId: string; seconds: number },
): Promise<VoiceUsageReceiptV1> {
  const dayKey = voiceQuotaKeyV1(request.day);
  const sessionKey = voiceSessionKeyV1(request.day, request.sessionId);
  const reported = Number.isSafeInteger(request.seconds)
    ? Math.max(0, request.seconds)
    : 0;
  return storage.transaction(async (transaction) => {
    const session = await transaction.get<StoredVoiceSessionV1>(sessionKey);
    const charged = storedSeconds(session);
    const delta = Math.max(0, reported - charged);
    const used = storedSeconds(await transaction.get<StoredVoiceDayV1>(dayKey));
    const total = used + delta;
    if (delta > 0) {
      await transaction.put(dayKey, {
        schemaVersion: 1,
        day: request.day,
        seconds: total,
      } satisfies StoredVoiceDayV1);
      await transaction.put(sessionKey, {
        schemaVersion: 1,
        day: request.day,
        sessionId: request.sessionId,
        seconds: reported,
      } satisfies StoredVoiceSessionV1);
    }
    return {
      schemaVersion: 1,
      status: "recorded",
      day: request.day,
      sessionId: request.sessionId,
      usedSeconds: total,
      limitSeconds: VOICE_SECONDS_PER_DAY_V1,
    } satisfies VoiceUsageReceiptV1;
  });
}

/** Admits one assistant session against the User's current UTC month. */
export async function reserveVoiceAssistantV1(
  storage: VoiceQuotaStorage,
  request: { month: string; sessionId: string },
): Promise<VoiceAssistantQuotaReceiptV1> {
  const quotaKey = voiceAssistantQuotaKeyV1(request.month);
  const usageKey = voiceAssistantUsageKeyV1(request.month, request.sessionId);
  return storage.transaction(async (transaction) => {
    const used = storedSeconds(
      await transaction.get<StoredVoiceDayV1>(quotaKey),
    );
    if (used >= VOICE_ASSISTANT_SECONDS_PER_MONTH_V1) {
      return {
        schemaVersion: 1,
        status: "refused",
        month: request.month,
        sessionId: request.sessionId,
        usedSeconds: used,
        limitSeconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
        reason: voiceAssistantQuotaRefusalV1(),
      };
    }
    await sweepOldAssistantMonthsV1(transaction, request.month);
    if ((await transaction.get(usageKey)) === undefined) {
      await transaction.put(usageKey, {
        schemaVersion: 1,
        day: request.month,
        sessionId: request.sessionId,
        seconds: 0,
      } satisfies StoredVoiceSessionV1);
    }
    return {
      schemaVersion: 1,
      status: "reserved",
      month: request.month,
      sessionId: request.sessionId,
      usedSeconds: used,
      limitSeconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
    };
  });
}

/** Charges the largest reported whole-second total for this assistant session. */
export async function recordVoiceAssistantUsageV1(
  storage: VoiceQuotaStorage,
  request: { month: string; sessionId: string; seconds: number },
): Promise<VoiceAssistantUsageReceiptV1> {
  const quotaKey = voiceAssistantQuotaKeyV1(request.month);
  const usageKey = voiceAssistantUsageKeyV1(request.month, request.sessionId);
  const reported = Number.isSafeInteger(request.seconds)
    ? Math.max(0, request.seconds)
    : 0;
  return storage.transaction(async (transaction) => {
    const session = await transaction.get<StoredVoiceSessionV1>(usageKey);
    const charged = storedSeconds(session);
    const delta = Math.max(0, reported - charged);
    const used = storedSeconds(
      await transaction.get<StoredVoiceDayV1>(quotaKey),
    );
    const total = used + delta;
    if (delta > 0) {
      await transaction.put(quotaKey, {
        schemaVersion: 1,
        day: request.month,
        seconds: total,
      } satisfies StoredVoiceDayV1);
      await transaction.put(usageKey, {
        schemaVersion: 1,
        day: request.month,
        sessionId: request.sessionId,
        seconds: reported,
      } satisfies StoredVoiceSessionV1);
    }
    return {
      schemaVersion: 1,
      status: "recorded",
      month: request.month,
      sessionId: request.sessionId,
      usedSeconds: total,
      limitSeconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
    };
  });
}

export async function readVoiceAssistantQuotaV1(
  storage: VoiceQuotaTransaction,
  month: string,
): Promise<{
  schemaVersion: 1;
  month: string;
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number;
}> {
  const usedSeconds = storedSeconds(
    await storage.get<StoredVoiceDayV1>(voiceAssistantQuotaKeyV1(month)),
  );
  return {
    schemaVersion: 1,
    month,
    usedSeconds,
    limitSeconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
    remainingSeconds: Math.max(
      0,
      VOICE_ASSISTANT_SECONDS_PER_MONTH_V1 - usedSeconds,
    ),
  };
}

async function sweepOldAssistantMonthsV1(
  transaction: VoiceQuotaTransaction,
  currentMonth: string,
): Promise<void> {
  for (const prefix of [
    VOICE_ASSISTANT_QUOTA_PREFIX_V1,
    VOICE_ASSISTANT_USAGE_PREFIX_V1,
  ]) {
    const held = await transaction.list<unknown>({ prefix, limit: 256 });
    for (const key of held.keys()) {
      if (!key.startsWith(`${prefix}${currentMonth}`)) {
        await transaction.delete(key);
      }
    }
  }
}

/** Drops every day counter and session record that is not today's. */
async function sweepOldDaysV1(
  transaction: VoiceQuotaTransaction,
  today: string,
): Promise<void> {
  for (const prefix of [VOICE_QUOTA_PREFIX, VOICE_SESSION_PREFIX]) {
    const held = await transaction.list<unknown>({ prefix, limit: 256 });
    for (const key of held.keys()) {
      if (!key.startsWith(`${prefix}${today}`)) await transaction.delete(key);
    }
  }
}

export function decodeVoiceQuotaReceiptV1(
  input: unknown,
  label = "voice quota receipt",
): VoiceQuotaReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status !== "reserved" && value.status !== "refused") {
    throw new Error(`${label}.status is invalid`);
  }
  const day = value.day;
  const sessionId = value.sessionId;
  if (typeof day !== "string" || !VOICE_QUOTA_DAY.test(day)) {
    throw new Error(`${label}.day is invalid`);
  }
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new Error(`${label}.sessionId is invalid`);
  }
  const integer = (name: string): number => {
    const candidate = value[name];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new Error(`${label}.${name} is invalid`);
    }
    return candidate as number;
  };
  return {
    schemaVersion: 1,
    status: value.status,
    day,
    sessionId,
    usedSeconds: integer("usedSeconds"),
    limitSeconds: integer("limitSeconds"),
    ...(typeof value.reason === "string" && value.reason
      ? { reason: value.reason }
      : {}),
  };
}

export function decodeVoiceAssistantQuotaReceiptV1(
  input: unknown,
  label = "voice assistant quota receipt",
): VoiceAssistantQuotaReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status !== "reserved" && value.status !== "refused") {
    throw new Error(`${label}.status is invalid`);
  }
  if (typeof value.month !== "string" || !VOICE_QUOTA_MONTH.test(value.month)) {
    throw new Error(`${label}.month is invalid`);
  }
  if (
    typeof value.sessionId !== "string" ||
    !SESSION_ID.test(value.sessionId)
  ) {
    throw new Error(`${label}.sessionId is invalid`);
  }
  const integer = (name: string): number => {
    const candidate = value[name];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new Error(`${label}.${name} is invalid`);
    }
    return candidate as number;
  };
  return {
    schemaVersion: 1,
    status: value.status,
    month: value.month,
    sessionId: value.sessionId,
    usedSeconds: integer("usedSeconds"),
    limitSeconds: integer("limitSeconds"),
    ...(typeof value.reason === "string" && value.reason
      ? { reason: value.reason }
      : {}),
  };
}

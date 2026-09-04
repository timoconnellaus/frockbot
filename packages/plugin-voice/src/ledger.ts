import {
  VOICE_MAX_PENDING_ANSWERS_V1,
  VOICE_MAX_SESSIONS_V1,
  VOICE_MAX_TOOL_CALLS_V1,
  VOICE_MAX_TRANSCRIPT_ENTRIES_V1,
  type VoiceLedgerViewV1,
  type VoiceOfflineReasonV1,
  type VoicePendingAnswerV1,
  type VoiceSessionRecordV1,
  type VoiceStateV1,
  type VoiceToolCallEntryV1,
  type VoiceTranscriptEntryV1,
} from "./shared.js";

export const VOICE_STATE_KEY_V1 = "voice:assistant:state";
export const VOICE_SESSION_PREFIX_V1 = "voice:assistant:ledger:session:";
export const VOICE_PENDING_PREFIX_V1 = "voice:assistant:ledger:answer:";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface VoiceLedgerTransactionV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T>(options: {
    prefix: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
}

export interface VoiceLedgerStorageV1 extends VoiceLedgerTransactionV1 {
  transaction<T>(
    callback: (storage: VoiceLedgerTransactionV1) => Promise<T>,
  ): Promise<T>;
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: string, label: string): string {
  if (value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stateOrDefault(
  value: VoiceStateV1 | undefined,
  at: string,
): VoiceStateV1 {
  if (value?.schemaVersion === 1 && typeof value.enabled === "boolean") {
    return value;
  }
  return { schemaVersion: 1, enabled: false, updatedAt: at };
}

function sessionKey(sessionId: string): string {
  return `${VOICE_SESSION_PREFIX_V1}${identifier(sessionId, "voice session id")}`;
}

function pendingKey(answerId: string): string {
  return `${VOICE_PENDING_PREFIX_V1}${identifier(answerId, "voice answer id")}`;
}

function boundedText(value: string, label: string, max = 4_000): string {
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${label} is invalid`);
  return text;
}

export class VoiceLedgerV1 {
  constructor(private readonly storage: VoiceLedgerStorageV1) {}

  async start(input: {
    sessionId: string;
    deviceId: string;
    at: string;
  }): Promise<{ state: VoiceStateV1; replacedSessionId?: string }> {
    const sessionId = identifier(input.sessionId, "voice session id");
    const deviceId = identifier(input.deviceId, "voice device id");
    const at = timestamp(input.at, "voice session time");
    return this.storage.transaction(async (transaction) => {
      const current = stateOrDefault(
        await transaction.get<VoiceStateV1>(VOICE_STATE_KEY_V1),
        at,
      );
      const replacedSessionId =
        current.enabled && current.activeSessionId !== sessionId
          ? current.activeSessionId
          : undefined;
      if (replacedSessionId) {
        const oldKey = sessionKey(replacedSessionId);
        const old = await transaction.get<VoiceSessionRecordV1>(oldKey);
        if (old && !old.endedAt) {
          await transaction.put(oldKey, {
            ...old,
            endedAt: at,
            endedReason: "replaced",
          } satisfies VoiceSessionRecordV1);
        }
      }
      const key = sessionKey(sessionId);
      if ((await transaction.get(key)) === undefined) {
        await transaction.put(key, {
          schemaVersion: 1,
          sessionId,
          deviceId,
          startedAt: at,
          seconds: 0,
          transcript: [],
          toolCalls: [],
        } satisfies VoiceSessionRecordV1);
      }
      const state: VoiceStateV1 = {
        schemaVersion: 1,
        enabled: true,
        updatedAt: at,
        activeSessionId: sessionId,
        activeDeviceId: deviceId,
        ...(current.resumptionHandle
          ? { resumptionHandle: current.resumptionHandle }
          : {}),
      };
      await transaction.put(VOICE_STATE_KEY_V1, state);
      return { state, ...(replacedSessionId ? { replacedSessionId } : {}) };
    });
  }

  async end(input: {
    sessionId: string;
    at: string;
    reason: VoiceOfflineReasonV1;
    seconds: number;
  }): Promise<VoiceStateV1> {
    const key = sessionKey(input.sessionId);
    const at = timestamp(input.at, "voice session time");
    return this.storage.transaction(async (transaction) => {
      const current = stateOrDefault(
        await transaction.get<VoiceStateV1>(VOICE_STATE_KEY_V1),
        at,
      );
      const session = await transaction.get<VoiceSessionRecordV1>(key);
      if (session && !session.endedAt) {
        await transaction.put(key, {
          ...session,
          endedAt: at,
          endedReason: input.reason,
          seconds: Math.max(
            session.seconds,
            Number.isSafeInteger(input.seconds) ? input.seconds : 0,
          ),
        } satisfies VoiceSessionRecordV1);
      }
      if (current.activeSessionId !== input.sessionId) return current;
      const state: VoiceStateV1 = {
        schemaVersion: 1,
        enabled: false,
        updatedAt: at,
        ...(current.resumptionHandle
          ? { resumptionHandle: current.resumptionHandle }
          : {}),
      };
      await transaction.put(VOICE_STATE_KEY_V1, state);
      return state;
    });
  }

  async saveResumptionHandle(input: {
    sessionId: string;
    handle: string;
    at: string;
  }): Promise<void> {
    if (input.handle.length === 0 || input.handle.length > 16_384) {
      throw new Error("voice resumption handle is invalid");
    }
    await this.storage.transaction(async (transaction) => {
      const current = stateOrDefault(
        await transaction.get<VoiceStateV1>(VOICE_STATE_KEY_V1),
        timestamp(input.at, "voice session time"),
      );
      if (current.activeSessionId !== input.sessionId) return;
      await transaction.put(VOICE_STATE_KEY_V1, {
        ...current,
        updatedAt: input.at,
        resumptionHandle: input.handle,
      } satisfies VoiceStateV1);
    });
  }

  async appendTranscript(
    sessionId: string,
    entry: VoiceTranscriptEntryV1,
  ): Promise<void> {
    const key = sessionKey(sessionId);
    await this.storage.transaction(async (transaction) => {
      const session = await transaction.get<VoiceSessionRecordV1>(key);
      if (!session || session.transcript.some((held) => held.id === entry.id)) {
        return;
      }
      await transaction.put(key, {
        ...session,
        transcript: [
          ...session.transcript,
          {
            ...entry,
            text: boundedText(entry.text, "voice transcript text"),
          },
        ].slice(-VOICE_MAX_TRANSCRIPT_ENTRIES_V1),
      } satisfies VoiceSessionRecordV1);
    });
  }

  async appendToolCall(
    sessionId: string,
    entry: VoiceToolCallEntryV1,
  ): Promise<void> {
    const key = sessionKey(sessionId);
    await this.storage.transaction(async (transaction) => {
      const session = await transaction.get<VoiceSessionRecordV1>(key);
      if (!session || session.toolCalls.some((held) => held.id === entry.id)) {
        return;
      }
      await transaction.put(key, {
        ...session,
        toolCalls: [...session.toolCalls, entry].slice(
          -VOICE_MAX_TOOL_CALLS_V1,
        ),
      } satisfies VoiceSessionRecordV1);
    });
  }

  /** B2 writes through this idempotent seam after a Bot answers. */
  async recordPendingAnswer(answer: VoicePendingAnswerV1): Promise<void> {
    const key = pendingKey(answer.answerId);
    if ((await this.storage.get(key)) === undefined) {
      await this.storage.put(key, answer);
    }
  }

  async view(at = new Date().toISOString()): Promise<VoiceLedgerViewV1> {
    const [state, sessions, pending] = await Promise.all([
      this.storage.get<VoiceStateV1>(VOICE_STATE_KEY_V1),
      this.storage.list<VoiceSessionRecordV1>({
        prefix: VOICE_SESSION_PREFIX_V1,
        limit: VOICE_MAX_SESSIONS_V1,
        reverse: true,
      }),
      this.storage.list<VoicePendingAnswerV1>({
        prefix: VOICE_PENDING_PREFIX_V1,
        limit: VOICE_MAX_PENDING_ANSWERS_V1,
        reverse: true,
      }),
    ]);
    return {
      schemaVersion: 1,
      state: stateOrDefault(state, at),
      sessions: [...sessions.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, VOICE_MAX_SESSIONS_V1),
      pendingAnswers: [...pending.values()]
        .filter((answer) => !answer.briefedAt)
        .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt))
        .slice(0, VOICE_MAX_PENDING_ANSWERS_V1),
    };
  }
}

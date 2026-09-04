import {
  decodeVoiceAskRecordV1,
  VOICE_MAX_ASK_RECORDS_V1,
  VOICE_MAX_PENDING_ANSWERS_V1,
  VOICE_MAX_SESSIONS_V1,
  VOICE_MAX_TOOL_CALLS_V1,
  VOICE_MAX_TRANSCRIPT_ENTRIES_V1,
  type VoiceAnsweredEventV1,
  type VoiceAskEventV1,
  type VoiceAskFailedEventV1,
  type VoiceAskRecordV1,
  type VoiceBriefedEventV1,
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
export const VOICE_ASK_PREFIX_V1 = "voice:assistant:ledger:ask:";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface VoiceLedgerTransactionV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
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

function askKey(askId: string): string {
  return `${VOICE_ASK_PREFIX_V1}${identifier(askId, "voice ask id")}`;
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
      const sessions = await transaction.list<VoiceSessionRecordV1>({
        prefix: VOICE_SESSION_PREFIX_V1,
        limit: VOICE_MAX_SESSIONS_V1 + 1,
      });
      const expired = [...sessions.entries()]
        .sort((left, right) =>
          right[1].startedAt.localeCompare(left[1].startedAt),
        )
        .slice(VOICE_MAX_SESSIONS_V1);
      for (const [expiredKey] of expired) {
        await transaction.delete(expiredKey);
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

  /**
   * Records intent before agent admission and enforces Voice's two bounds.
   * A replay of the same ask is admitted; reuse of its id with different
   * content is rejected rather than silently changing the durable intent.
   */
  async recordAsk(
    input: VoiceAskEventV1,
  ): Promise<
    | { status: "recorded" | "replayed"; record: VoiceAskRecordV1 }
    | { status: "refused"; reason: string }
  > {
    const record = decodeVoiceAskRecordV1({ schemaVersion: 1, ask: input });
    const key = askKey(record.ask.askId);
    return this.storage.transaction(async (transaction) => {
      const held = await transaction.get<unknown>(key);
      if (held !== undefined) {
        const existing = decodeVoiceAskRecordV1(held);
        if (JSON.stringify(existing.ask) !== JSON.stringify(record.ask)) {
          throw new Error("voice ask id was reused for different content");
        }
        return { status: "replayed" as const, record: existing };
      }
      const [storedAsks, storedAnswers] = await Promise.all([
        transaction.list<unknown>({
          prefix: VOICE_ASK_PREFIX_V1,
          limit: VOICE_MAX_ASK_RECORDS_V1 + 1,
        }),
        transaction.list<VoicePendingAnswerV1>({
          prefix: VOICE_PENDING_PREFIX_V1,
          limit: VOICE_MAX_PENDING_ANSWERS_V1,
        }),
      ]);
      const asks = [...storedAsks.entries()].map(([storedKey, value]) => [
        storedKey,
        decodeVoiceAskRecordV1(value),
      ]) as Array<[string, VoiceAskRecordV1]>;
      if (
        asks.some(
          ([, candidate]) =>
            candidate.ask.sessionId === record.ask.sessionId &&
            candidate.ask.botId === record.ask.botId &&
            !candidate.answered &&
            !candidate.failed,
        )
      ) {
        return {
          status: "refused" as const,
          reason: `${record.ask.botName} is already answering a Voice question from this session.`,
        };
      }
      const unbriefed = [...storedAnswers.values()].filter(
        (answer) => !answer.briefedAt,
      ).length;
      if (unbriefed >= VOICE_MAX_PENDING_ANSWERS_V1) {
        return {
          status: "refused" as const,
          reason: "Voice already has 32 Bot answers waiting to be heard.",
        };
      }
      if (asks.length >= VOICE_MAX_ASK_RECORDS_V1) {
        const removable = asks
          .filter(([, candidate]) => candidate.failed || candidate.briefed)
          .sort((left, right) =>
            left[1].ask.askedAt.localeCompare(right[1].ask.askedAt),
          );
        const needed = asks.length - VOICE_MAX_ASK_RECORDS_V1 + 1;
        if (removable.length < needed) {
          return {
            status: "refused" as const,
            reason: "Voice already has too many Bot questions in progress.",
          };
        }
        for (const [expiredKey] of removable.slice(0, needed)) {
          await transaction.delete(expiredKey);
        }
      }
      await transaction.put(key, record);
      return { status: "recorded" as const, record };
    });
  }

  async readAsk(askId: string): Promise<VoiceAskRecordV1 | undefined> {
    const stored = await this.storage.get<unknown>(askKey(askId));
    return stored === undefined ? undefined : decodeVoiceAskRecordV1(stored);
  }

  /** `voice/answered` and its pending projection commit atomically. */
  async recordAnswered(
    event: VoiceAnsweredEventV1,
  ): Promise<{ record: VoiceAskRecordV1; answer: VoicePendingAnswerV1 }> {
    const key = askKey(event.askId);
    return this.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) throw new Error("voice ask was not found");
      const current = decodeVoiceAskRecordV1(stored);
      if (
        current.ask.botId !== event.botId ||
        current.ask.runId !== event.runId
      ) {
        throw new Error("voice answer does not match its ask");
      }
      const settledEvent = current.answered ?? event;
      const answered = decodeVoiceAskRecordV1({
        ...current,
        answered: settledEvent,
        failed: undefined,
      });
      const answer: VoicePendingAnswerV1 = {
        schemaVersion: 1,
        answerId: current.ask.askId,
        botId: current.ask.botId,
        botName: current.ask.botName,
        question: current.ask.question,
        answer: answered.answered!.answer,
        answeredAt: answered.answered!.answeredAt,
        ...(answered.briefed ? { briefedAt: answered.briefed.briefedAt } : {}),
      };
      await transaction.put(key, answered);
      await transaction.put(pendingKey(answer.answerId), answer);
      return { record: answered, answer };
    });
  }

  async recordFailed(event: VoiceAskFailedEventV1): Promise<VoiceAskRecordV1> {
    const key = askKey(event.askId);
    return this.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) throw new Error("voice ask was not found");
      const current = decodeVoiceAskRecordV1(stored);
      if (
        current.ask.botId !== event.botId ||
        current.ask.runId !== event.runId
      ) {
        throw new Error("voice failure does not match its ask");
      }
      if (current.answered || current.failed) return current;
      const failed = decodeVoiceAskRecordV1({ ...current, failed: event });
      await transaction.put(key, failed);
      return failed;
    });
  }

  /** A provider turn is acknowledged only after its speech turn completes. */
  async markBriefed(input: {
    askIds: readonly string[];
    sessionId: string;
    at: string;
  }): Promise<number> {
    const sessionId = identifier(input.sessionId, "voice session id");
    const briefedAt = timestamp(input.at, "voice briefing time");
    return this.storage.transaction(async (transaction) => {
      let changed = 0;
      for (const askId of [...new Set(input.askIds)].slice(
        0,
        VOICE_MAX_PENDING_ANSWERS_V1,
      )) {
        const key = askKey(askId);
        const stored = await transaction.get<unknown>(key);
        if (stored === undefined) continue;
        const current = decodeVoiceAskRecordV1(stored);
        if (!current.answered || current.briefed) continue;
        const briefed: VoiceBriefedEventV1 = {
          schemaVersion: 1,
          type: "voice/briefed",
          askId: current.ask.askId,
          sessionId,
          briefedAt,
        };
        await transaction.put(
          key,
          decodeVoiceAskRecordV1({ ...current, briefed }),
        );
        const answerKey = pendingKey(current.ask.askId);
        const answer = await transaction.get<VoicePendingAnswerV1>(answerKey);
        if (answer) {
          await transaction.put(answerKey, { ...answer, briefedAt });
        }
        changed += 1;
      }
      return changed;
    });
  }

  /** B2 writes through this idempotent seam after a Bot answers. */
  async recordPendingAnswer(answer: VoicePendingAnswerV1): Promise<void> {
    const key = pendingKey(answer.answerId);
    await this.storage.transaction(async (transaction) => {
      if ((await transaction.get(key)) === undefined) {
        await transaction.put(key, answer);
      }
      const answers = await transaction.list<VoicePendingAnswerV1>({
        prefix: VOICE_PENDING_PREFIX_V1,
        limit: VOICE_MAX_PENDING_ANSWERS_V1 + 1,
      });
      const expired = [...answers.entries()]
        .sort((left, right) =>
          right[1].answeredAt.localeCompare(left[1].answeredAt),
        )
        .slice(VOICE_MAX_PENDING_ANSWERS_V1);
      for (const [expiredKey] of expired) {
        await transaction.delete(expiredKey);
      }
    });
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

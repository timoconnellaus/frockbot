// Indexed voice recovery.
//
// Startup reads the current call, the activation, and the active/pending
// indexes. It does not list retained call history. Obligations and their
// index rows change in one transaction; a throw leaves neither.

import type { VoiceLedgerStorageV1 } from "./ledger.js";

export const VOICE_ACTIVATION_KEY_V1 = "activation";
export const VOICE_WORK_PREFIX_V1 = "work:";
export const VOICE_PENDING_PREFIX_V1 = "pending:";
export const VOICE_ACTIVE_PREFIX_V1 = "active:";
export const VOICE_SOURCE_PIN_PREFIX_V1 = "voice:source-pin:";
export const VOICE_SEALED_CALL_PREFIX_V1 = "voice:call:sealed:";

/** Local due records handled before the drain yields. */
export const VOICE_MAINTENANCE_BATCH_V1 = 8;
/** One external operation per invocation. The next batch is a successor. */
export const VOICE_MAINTENANCE_EXTERNAL_PER_PASS_V1 = 1;
export const VOICE_MAINTENANCE_LOCAL_BUDGET_MS_V1 = 100;
export const VOICE_MAINTENANCE_CONTINUATION_SECONDS_V1 = 2;
export const VOICE_DELIVERY_BACKOFF_CAP_SECONDS_V1 = 300;

export type VoiceWorkKindV1 =
  "transcript" | "memory" | "delegation" | "retention" | "abandon" | "turn";

export interface VoiceWorkRecordV1 {
  schemaVersion: 1;
  kind: VoiceWorkKindV1;
  id: string;
  ref: string;
  callId: string;
  botId?: string;
  state: "pending" | "claimed" | "uncertain" | "done" | "failed";
  nextAt: number;
  attempts: number;
  claimActivation?: string;
  lastError?: string;
}

export interface VoiceActiveWorkV1 {
  schemaVersion: 1;
  kind: string;
  id: string;
  callId: string;
  requestId: string;
  activation: string;
}

export function voiceWorkKeyV1(kind: string, id: string): string {
  return `${VOICE_WORK_PREFIX_V1}${kind}:${id}`;
}

export function voicePendingKeyV1(
  dueAt: number,
  kind: string,
  id: string,
): string {
  return `${VOICE_PENDING_PREFIX_V1}${String(dueAt).padStart(16, "0")}:${kind}:${id}`;
}

export function voiceActiveKeyV1(kind: string, id: string): string {
  return `${VOICE_ACTIVE_PREFIX_V1}${kind}:${id}`;
}

export function voiceDeliveryBackoffSecondsV1(attempts: number): number {
  const seconds = 2 ** Math.max(1, attempts);
  return Math.min(VOICE_DELIVERY_BACKOFF_CAP_SECONDS_V1, seconds);
}

async function transact<T>(
  storage: VoiceLedgerStorageV1,
  run: (storage: VoiceLedgerStorageV1) => Promise<T>,
): Promise<T> {
  if (storage.transaction) return storage.transaction(run);
  return run(storage);
}

/** Writes a work row and its pending index together. */
export async function putVoiceWorkV1(
  storage: VoiceLedgerStorageV1,
  work: VoiceWorkRecordV1,
  previousDueAt?: number,
): Promise<void> {
  await transact(storage, async (tx) => {
    if (previousDueAt !== undefined && previousDueAt !== work.nextAt) {
      await tx.delete(voicePendingKeyV1(previousDueAt, work.kind, work.id));
    }
    await tx.put(voiceWorkKeyV1(work.kind, work.id), work);
    if (work.state === "done") {
      await tx.delete(voicePendingKeyV1(work.nextAt, work.kind, work.id));
      await tx.delete(voiceActiveKeyV1(work.kind, work.id));
      return;
    }
    await tx.put(
      voicePendingKeyV1(work.nextAt, work.kind, work.id),
      voiceWorkKeyV1(work.kind, work.id),
    );
  });
}

export async function putVoiceActiveWorkV1(
  storage: VoiceLedgerStorageV1,
  active: VoiceActiveWorkV1,
): Promise<void> {
  await transact(storage, async (tx) => {
    await tx.put(voiceActiveKeyV1(active.kind, active.id), active);
  });
}

/**
 * Replaces the activation and fences paid work stamped with any other one.
 * A delayed callback for the previous activation cannot mark the new work
 * abandoned: the fence only matches the activation it was given.
 */
export async function beginVoiceActivationV1(
  storage: VoiceLedgerStorageV1,
  activation: string,
): Promise<{ fenced: string[] }> {
  const previous = await storage.get<string>(VOICE_ACTIVATION_KEY_V1);
  await storage.put(VOICE_ACTIVATION_KEY_V1, activation);
  if (!previous || previous === activation) return { fenced: [] };
  return fenceVoiceActivationV1(storage, previous, activation);
}

export async function fenceVoiceActivationV1(
  storage: VoiceLedgerStorageV1,
  staleActivation: string,
  currentActivation: string,
): Promise<{ fenced: string[] }> {
  const fenced: string[] = [];
  const active = await storage.list<VoiceActiveWorkV1>({
    prefix: VOICE_ACTIVE_PREFIX_V1,
    limit: VOICE_MAINTENANCE_BATCH_V1,
  });
  for (const [key, record] of active) {
    if (record.activation !== staleActivation) continue;
    if (record.activation === currentActivation) continue;
    const work = await storage.get<VoiceWorkRecordV1>(
      voiceWorkKeyV1(record.kind, record.id),
    );
    await transact(storage, async (tx) => {
      await tx.delete(key);
      if (!work) return;
      await tx.put(voiceWorkKeyV1(work.kind, work.id), {
        ...work,
        state: "uncertain",
        claimActivation: staleActivation,
        lastError: "the previous activation ended before the outcome was known",
      } satisfies VoiceWorkRecordV1);
    });
    fenced.push(record.id);
  }
  return { fenced };
}

/** Due pending keys, oldest first, bounded. */
export async function dueVoiceWorkV1(
  storage: VoiceLedgerStorageV1,
  now: number,
  limit = VOICE_MAINTENANCE_BATCH_V1,
): Promise<VoiceWorkRecordV1[]> {
  const pending = await storage.list<string>({
    prefix: VOICE_PENDING_PREFIX_V1,
    limit,
  });
  const due: VoiceWorkRecordV1[] = [];
  for (const [key, workKey] of pending) {
    const dueAt = Number(
      key.slice(
        VOICE_PENDING_PREFIX_V1.length,
        VOICE_PENDING_PREFIX_V1.length + 16,
      ),
    );
    if (!Number.isFinite(dueAt) || dueAt > now) break;
    const work = await storage.get<VoiceWorkRecordV1>(workKey);
    if (work) due.push(work);
  }
  return due;
}

export interface VoiceSealedCallV1 {
  schemaVersion: 1;
  callId: string;
  botId?: string;
  startedAt: string;
  endedAt: string;
  turnSequence: number;
}

/**
 * Seals the call, records transcript and memory obligations, pins the source,
 * and clears current ownership. One transaction: a throw keeps the live call.
 */
export async function sealVoiceCallV1(
  storage: VoiceLedgerStorageV1,
  input: {
    callId: string;
    botId?: string;
    startedAt: string;
    endedAt: string;
    turnSequence: number;
    now: number;
  },
): Promise<VoiceSealedCallV1> {
  const sealed: VoiceSealedCallV1 = {
    schemaVersion: 1,
    callId: input.callId,
    ...(input.botId ? { botId: input.botId } : {}),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    turnSequence: input.turnSequence,
  };
  const obligations: VoiceWorkRecordV1[] = [
    {
      schemaVersion: 1,
      kind: "transcript",
      id: input.callId,
      ref: `${VOICE_SEALED_CALL_PREFIX_V1}${input.callId}`,
      callId: input.callId,
      ...(input.botId ? { botId: input.botId } : {}),
      state: "pending",
      nextAt: input.now,
      attempts: 0,
    },
    {
      schemaVersion: 1,
      kind: "memory",
      id: input.callId,
      ref: `voice:memory:job:${input.callId}`,
      callId: input.callId,
      ...(input.botId ? { botId: input.botId } : {}),
      state: "pending",
      nextAt: input.now,
      attempts: 0,
    },
  ];
  await transact(storage, async (tx) => {
    const existing = await tx.get<VoiceSealedCallV1>(
      `${VOICE_SEALED_CALL_PREFIX_V1}${input.callId}`,
    );
    if (existing) return;
    await tx.put(`${VOICE_SEALED_CALL_PREFIX_V1}${input.callId}`, sealed);
    await tx.put(`${VOICE_SOURCE_PIN_PREFIX_V1}${input.callId}`, {
      schemaVersion: 1,
      callId: input.callId,
      consumers: ["transcript", "memory"],
    });
    for (const work of obligations) {
      await tx.put(voiceWorkKeyV1(work.kind, work.id), work);
      await tx.put(
        voicePendingKeyV1(work.nextAt, work.kind, work.id),
        voiceWorkKeyV1(work.kind, work.id),
      );
    }
    const current = await tx.get<{ callId?: string }>("voice:call:current");
    if (current?.callId === input.callId) await tx.delete("voice:call:current");
  });
  return sealed;
}

/**
 * Pre-armed maintenance. Application rows and the SDK schedule are not one
 * transaction, so the callback is booked before the obligation is written and
 * waits out that section if it arrives early.
 */
export class VoiceMaintenanceSchedulerV1 {
  private section: Promise<void> = Promise.resolve();

  constructor(
    private readonly schedule: (
      delaySeconds: number,
      token: string,
    ) => Promise<void>,
  ) {}

  /** Schedule, then commit. A callback waits until this section releases. */
  async commit(write: () => Promise<void>): Promise<string> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.section;
    this.section = previous.then(() => gate);
    await previous;
    const token = crypto.randomUUID();
    try {
      await this.schedule(VOICE_MAINTENANCE_CONTINUATION_SECONDS_V1, token);
      await write();
      return token;
    } finally {
      release();
    }
  }

  /**
   * Runs after the producer section. Stops only when nothing is pending.
   * Otherwise arms a distinct successor before the drain claims work.
   */
  async onCallback(input: {
    pending: () => Promise<boolean>;
    drain: () => Promise<void>;
  }): Promise<"stopped" | "continued"> {
    await this.section;
    if (!(await input.pending())) return "stopped";
    await this.schedule(
      VOICE_MAINTENANCE_CONTINUATION_SECONDS_V1,
      crypto.randomUUID(),
    );
    await input.drain();
    return "continued";
  }
}

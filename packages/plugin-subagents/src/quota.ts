// The per-User concurrent-subagent bound, as durable User Durable Object state.
//
// A Bot's own bound (four) is countable in the Bot Durable Object, because the
// keys are there. A User's (eight) is not: a User's Bots are separate objects
// and no one of them can see the others. So the counter lives where the
// authority for User-scoped state already is, and the Bot Durable Object
// *reserves* a slot over a narrow RPC before it dispatches — the
// `AUTHORING_QUOTA_RESERVATION_PREFIX` pattern in `plugin-authoring/src/quota.ts`.
//
// The one difference from the authoring quota is what a unit *is*. An authored
// generation is spent; a running subagent is *held*, and comes back. So the
// reservation is a live key that a settle releases, not a day counter that only
// ever rises — and both halves are idempotent on `(botId, taskId)`, so a
// resumed Turn neither takes a second slot nor releases someone else's.

import { isTaskIdV1, TASK_CONCURRENCY_PER_USER_V1 } from "./records.js";

/** `PUBLIC_IDENTIFIER_PATTERN`: the shape every Bot id already has. */
const SLOT_BOT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const SUBAGENT_SLOT_PREFIX = "subagent:slot:";

/** The durable per-User bound, overridable by nothing today: it is the plan's. */
export const SUBAGENT_SLOT_LIMIT_V1 = TASK_CONCURRENCY_PER_USER_V1;

export function subagentSlotKeyV1(botId: string, taskId: string): string {
  // Two ids, one key. Neither may carry the separator, or a key would be
  // ambiguous about where the Bot ends and the task begins — and both patterns
  // already exclude it, so this is the check that says so out loud.
  if (!isTaskIdV1(taskId) || !SLOT_BOT_ID.test(botId)) {
    throw new Error("subagent slot key is invalid");
  }
  return `${SUBAGENT_SLOT_PREFIX}${botId}:${taskId}`;
}

export interface SubagentSlotRequestV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  taskId: string;
  reservedAt: string;
}

export type SubagentSlotReceiptV1 =
  | {
      schemaVersion: 1;
      status: "reserved";
      botId: string;
      taskId: string;
      held: number;
      limit: number;
    }
  | {
      schemaVersion: 1;
      status: "refused";
      botId: string;
      taskId: string;
      reason: string;
      held: number;
      limit: number;
    };

interface StoredSubagentSlotV1 {
  schemaVersion: 1;
  botId: string;
  taskId: string;
  reservedAt: string;
}

/**
 * The narrow storage surface this module needs from the User Durable Object.
 * Deliberately the same shape as {@link TaskStorageWritesV1}, so one in-memory
 * fake — and one Durable Object storage — satisfies both sides of the bound.
 */
export interface SubagentSlotTransaction {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface SubagentSlotStorage extends SubagentSlotTransaction {
  transaction<T>(
    callback: (storage: SubagentSlotTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * Takes one slot for a task, or refuses. Never throws for a breach: a bound is
 * an observable outcome the Bot's tool result reports.
 */
export async function reserveSubagentSlotV1(
  storage: SubagentSlotStorage,
  request: SubagentSlotRequestV1,
): Promise<SubagentSlotReceiptV1> {
  const key = subagentSlotKeyV1(request.botId, request.taskId);
  // One transaction from the count to the write: the read-modify-write spans
  // awaits, so two dispatches racing at the bound must not both be admitted.
  return storage.transaction(async (transaction) => {
    const held = await transaction.list<StoredSubagentSlotV1>({
      prefix: SUBAGENT_SLOT_PREFIX,
    });
    if (held.has(key)) {
      // Already ours. A resumed Turn re-executing the same dispatch reads its
      // own reservation back rather than taking a second one.
      return {
        schemaVersion: 1,
        status: "reserved",
        botId: request.botId,
        taskId: request.taskId,
        held: held.size,
        limit: SUBAGENT_SLOT_LIMIT_V1,
      };
    }
    if (held.size >= SUBAGENT_SLOT_LIMIT_V1) {
      return {
        schemaVersion: 1,
        status: "refused",
        botId: request.botId,
        taskId: request.taskId,
        reason: `this User already has ${held.size} subagents running; the bound is ${SUBAGENT_SLOT_LIMIT_V1}`,
        held: held.size,
        limit: SUBAGENT_SLOT_LIMIT_V1,
      };
    }
    await transaction.put(key, {
      schemaVersion: 1,
      botId: request.botId,
      taskId: request.taskId,
      reservedAt: request.reservedAt,
    } satisfies StoredSubagentSlotV1);
    return {
      schemaVersion: 1,
      status: "reserved",
      botId: request.botId,
      taskId: request.taskId,
      held: held.size + 1,
      limit: SUBAGENT_SLOT_LIMIT_V1,
    };
  });
}

/** Gives one slot back. Idempotent: releasing a slot nobody holds is a no-op. */
export async function releaseSubagentSlotV1(
  storage: SubagentSlotStorage,
  request: { botId: string; taskId: string },
): Promise<{ schemaVersion: 1; status: "released"; held: number }> {
  const key = subagentSlotKeyV1(request.botId, request.taskId);
  return storage.transaction(async (transaction) => {
    await transaction.delete(key);
    const held = await transaction.list<StoredSubagentSlotV1>({
      prefix: SUBAGENT_SLOT_PREFIX,
    });
    return { schemaVersion: 1, status: "released", held: held.size };
  });
}

export function decodeSubagentSlotReceiptV1(
  input: unknown,
  label = "subagent slot receipt",
): SubagentSlotReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const text = (name: string, maximum: number): string => {
    const candidate = value[name];
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > maximum
    ) {
      throw new Error(`${label}.${name} is invalid`);
    }
    return candidate;
  };
  const integer = (name: string): number => {
    const candidate = value[name];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new Error(`${label}.${name} is invalid`);
    }
    return candidate as number;
  };
  const botId = text("botId", 128);
  const taskId = text("taskId", 128);
  if (value.status === "reserved") {
    return {
      schemaVersion: 1,
      status: "reserved",
      botId,
      taskId,
      held: integer("held"),
      limit: integer("limit"),
    };
  }
  if (value.status === "refused") {
    return {
      schemaVersion: 1,
      status: "refused",
      botId,
      taskId,
      reason: text("reason", 1_024),
      held: integer("held"),
      limit: integer("limit"),
    };
  }
  throw new Error(`${label}.status is invalid`);
}

/** The narrow RPC the Bot Durable Object calls on the User Durable Object. */
export interface SubagentSlotBinding {
  reserve(request: SubagentSlotRequestV1): Promise<SubagentSlotReceiptV1>;
  release(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    taskId: string;
  }): Promise<void>;
}

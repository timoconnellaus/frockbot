/** Durable per-User concurrency budget for agent-lane Turns. */
export const AGENT_TURN_CONCURRENCY_PER_USER_V1 = 8;
export const AGENT_TURN_SLOT_PREFIX_V1 = "agent-turn:slot:";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

export interface AgentTurnSlotRequestV1 {
  schemaVersion: 1;
  userId: string;
  requesterId: string;
  runId: string;
  reservedAt: string;
}

export type AgentTurnSlotReceiptV1 =
  | {
      schemaVersion: 1;
      status: "reserved";
      requesterId: string;
      runId: string;
      held: number;
      limit: number;
    }
  | {
      schemaVersion: 1;
      status: "refused";
      requesterId: string;
      runId: string;
      reason: string;
      held: number;
      limit: number;
    };

export interface AgentTurnSlotTransactionV1 {
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface AgentTurnSlotStorageV1 extends AgentTurnSlotTransactionV1 {
  transaction<T>(
    callback: (storage: AgentTurnSlotTransactionV1) => Promise<T>,
  ): Promise<T>;
}

export function agentTurnSlotKeyV1(requesterId: string, runId: string): string {
  if (!ID.test(requesterId) || !ID.test(runId)) {
    throw new Error("agent Turn slot key is invalid");
  }
  return `${AGENT_TURN_SLOT_PREFIX_V1}${requesterId}:${runId}`;
}

export async function reserveAgentTurnSlotV1(
  storage: AgentTurnSlotStorageV1,
  request: AgentTurnSlotRequestV1,
): Promise<AgentTurnSlotReceiptV1> {
  const key = agentTurnSlotKeyV1(request.requesterId, request.runId);
  return storage.transaction(async (transaction) => {
    const held = await transaction.list({ prefix: AGENT_TURN_SLOT_PREFIX_V1 });
    if (held.has(key)) {
      return {
        schemaVersion: 1,
        status: "reserved",
        requesterId: request.requesterId,
        runId: request.runId,
        held: held.size,
        limit: AGENT_TURN_CONCURRENCY_PER_USER_V1,
      };
    }
    if (held.size >= AGENT_TURN_CONCURRENCY_PER_USER_V1) {
      return {
        schemaVersion: 1,
        status: "refused",
        requesterId: request.requesterId,
        runId: request.runId,
        reason: `this User already has ${held.size} agent Turns running; the bound is ${AGENT_TURN_CONCURRENCY_PER_USER_V1}`,
        held: held.size,
        limit: AGENT_TURN_CONCURRENCY_PER_USER_V1,
      };
    }
    await transaction.put(key, {
      schemaVersion: 1,
      requesterId: request.requesterId,
      runId: request.runId,
      reservedAt: request.reservedAt,
    });
    return {
      schemaVersion: 1,
      status: "reserved",
      requesterId: request.requesterId,
      runId: request.runId,
      held: held.size + 1,
      limit: AGENT_TURN_CONCURRENCY_PER_USER_V1,
    };
  });
}

export async function releaseAgentTurnSlotV1(
  storage: AgentTurnSlotStorageV1,
  request: { requesterId: string; runId: string },
): Promise<{ schemaVersion: 1; status: "released"; held: number }> {
  const key = agentTurnSlotKeyV1(request.requesterId, request.runId);
  return storage.transaction(async (transaction) => {
    await transaction.delete(key);
    const held = await transaction.list({ prefix: AGENT_TURN_SLOT_PREFIX_V1 });
    return { schemaVersion: 1, status: "released", held: held.size };
  });
}

export function decodeAgentTurnSlotReceiptV1(
  input: unknown,
): AgentTurnSlotReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("agent Turn slot receipt must be an object");
  }
  const value = input as Record<string, unknown>;
  const requesterId = value.requesterId;
  const runId = value.runId;
  const held = value.held;
  const limit = value.limit;
  if (
    value.schemaVersion !== 1 ||
    (value.status !== "reserved" && value.status !== "refused") ||
    typeof requesterId !== "string" ||
    typeof runId !== "string" ||
    !Number.isSafeInteger(held) ||
    !Number.isSafeInteger(limit)
  ) {
    throw new Error("agent Turn slot receipt is invalid");
  }
  if (value.status === "refused") {
    if (typeof value.reason !== "string" || !value.reason) {
      throw new Error("agent Turn slot refusal is invalid");
    }
    return {
      schemaVersion: 1,
      status: "refused",
      requesterId,
      runId,
      reason: value.reason,
      held: held as number,
      limit: limit as number,
    };
  }
  return {
    schemaVersion: 1,
    status: "reserved",
    requesterId,
    runId,
    held: held as number,
    limit: limit as number,
  };
}

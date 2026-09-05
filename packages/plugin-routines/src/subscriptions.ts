import { canonicalCommandFingerprintV1 } from "@frockbot/configuration-core";
import {
  decodeRoutineSubscriptionIntentV1,
  type RoutineSubscriptionIntentV1,
} from "@frockbot/connection-core";
import type { RoutineRecordV1 } from "./records.js";
import type {
  RoutineStorageReadsV1,
  RoutineStorageWritesV1,
  RoutineStorageV1,
} from "./store.js";

const PREFIX = "routine-subscription:",
  POINTER = "routine-subscription-current:";
interface Binding {
  schemaVersion: 1;
  intent: RoutineSubscriptionIntentV1;
  pending: boolean;
  dueAt: number;
}
function decode(value: unknown): Binding {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("intent" in value) ||
    !("pending" in value) ||
    typeof value.pending !== "boolean" ||
    !("dueAt" in value) ||
    typeof value.dueAt !== "number" ||
    !Number.isFinite(value.dueAt)
  )
    throw new Error("Routine event binding is invalid");
  return {
    schemaVersion: 1,
    intent: decodeRoutineSubscriptionIntentV1(value.intent),
    pending: value.pending,
    dueAt: value.dueAt,
  };
}
/** Staged in the same Bot transaction as the Routine; no provider call occurs here. */
export async function stageRoutineSubscriptionV1(
  tx: RoutineStorageWritesV1,
  routineId: string,
  next?: RoutineRecordV1,
  force = false,
) {
  const current = await tx.get<string>(`${POINTER}${routineId}`);
  const held = current
    ? decode(await tx.get(`${PREFIX}${current}`))
    : undefined;
  const trigger =
    next?.trigger?.kind === "connection"
      ? {
          connectionId: next.trigger.connectionId,
          triggerType: next.trigger.triggerType,
          config: next.trigger.config,
        }
      : undefined;
  const same =
    held &&
    trigger &&
    canonicalCommandFingerprintV1("trigger", held.intent.trigger) ===
      canonicalCommandFingerprintV1("trigger", trigger);
  if (same && held) {
    if (held.intent.enabled === next!.enabled && !force) return;
    await tx.put(`${PREFIX}${current}`, {
      schemaVersion: 1,
      intent: {
        ...held.intent,
        revision: held.intent.revision + 1,
        enabled: next!.enabled,
      },
      pending: true,
      dueAt: Date.now(),
    } satisfies Binding);
    return;
  }
  if (held && !held.intent.deleted) {
    await tx.put(`${PREFIX}${current}`, {
      schemaVersion: 1,
      intent: {
        ...held.intent,
        revision: held.intent.revision + 1,
        enabled: false,
        deleted: true,
      },
      pending: true,
      dueAt: Date.now(),
    } satisfies Binding);
    await tx.delete(`${POINTER}${routineId}`);
  }
  if (!trigger) return;
  if ((await tx.list({ prefix: PREFIX, limit: 1000 })).size >= 1000)
    throw new Error(
      "This Bot has reached its event subscription history limit",
    );
  const subscriptionId = crypto.randomUUID();
  await tx.put(`${PREFIX}${subscriptionId}`, {
    schemaVersion: 1,
    intent: {
      schemaVersion: 1,
      subscriptionId,
      routineId,
      revision: 1,
      enabled: next!.enabled,
      deleted: false,
      trigger,
    },
    pending: true,
    dueAt: Date.now(),
  } satisfies Binding);
  await tx.put(`${POINTER}${routineId}`, subscriptionId);
}
export async function routineSubscriptionMatchesV1(
  tx: RoutineStorageReadsV1,
  routineId: string,
  subscriptionId: string,
): Promise<boolean> {
  if ((await tx.get(`${POINTER}${routineId}`)) !== subscriptionId) return false;
  const binding = decode(await tx.get(`${PREFIX}${subscriptionId}`));
  return binding.intent.enabled && !binding.intent.deleted;
}
export async function routineSubscriptionDeadlinesV1(
  tx: RoutineStorageReadsV1,
): Promise<number[]> {
  return [...(await tx.list({ prefix: PREFIX })).values()]
    .map(decode)
    .filter((binding) => binding.pending)
    .map((binding) => binding.dueAt);
}
export async function flushRoutineSubscriptionsV1(
  storage: RoutineStorageV1,
  send: (intent: RoutineSubscriptionIntentV1) => Promise<unknown>,
  force = false,
): Promise<void> {
  for (const [key, value] of await storage.list({ prefix: PREFIX })) {
    const binding = decode(value);
    if (!binding.pending || (!force && binding.dueAt > Date.now())) continue;
    await storage.transaction(async (tx) => {
      const live = decode(await tx.get(key));
      if (live.intent.revision === binding.intent.revision)
        await tx.put(key, { ...live, dueAt: Date.now() + 60_000 });
    });
    try {
      const receipt = await send(binding.intent);
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("schemaVersion" in receipt) ||
        receipt.schemaVersion !== 1 ||
        !("status" in receipt) ||
        receipt.status !== "recorded"
      )
        throw new Error("Routine subscription was not acknowledged");
      await storage.transaction(async (tx) => {
        const live = decode(await tx.get(key));
        if (live.intent.revision === binding.intent.revision)
          await tx.put(key, { ...live, pending: false });
      });
    } catch {
      /* The persisted deadline retries the same desired revision. */
    }
  }
}

export async function routineSubscriptionBindingsV1(
  storage: RoutineStorageReadsV1,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, id] of await storage.list<unknown>({ prefix: POINTER })) {
    if (typeof id !== "string")
      throw new Error("Routine event binding is invalid");
    const held = decode(await storage.get(`${PREFIX}${id}`));
    if (
      held.intent.subscriptionId !== id ||
      held.intent.routineId !== key.slice(POINTER.length) ||
      held.intent.deleted
    )
      throw new Error("Routine event binding is invalid");
    result[held.intent.routineId] = id;
  }
  return result;
}

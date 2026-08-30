import { decodeSessionEvent, type SessionEvent } from "@frockbot/agent-core";
import {
  requireStoredRunV1,
  type BotTurnCompletion,
  type StoredRun,
} from "./backend-contracts.js";

export interface RunTerminalStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface RunTerminalKeys {
  run: string;
  activeRun: string;
  latestEvents: string;
  notificationPrefix: string;
}

export async function completeStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  result: BotTurnCompletion,
): Promise<"completed" | "cancelled"> {
  const activeRunId = await storage.get<string>(keys.activeRun);
  if (activeRunId !== runId) throw new Error(`run "${runId}" is not active`);
  const stored = await storage.get<StoredRun>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = requireStoredRunV1(stored);
  const events = result.events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...events].map(decodeSessionEvent);
  if (run.stopRequestedAt) {
    const { responseText: _text, failure: _failure, ...settled } = run;
    const cancelled = requireStoredRunV1({
      ...settled,
      events,
      status: "cancelled",
      phase: settled.phase === "reconciling" ? "executing" : settled.phase,
    } satisfies StoredRun);
    await storage.put({
      [keys.run]: structuredClone(cancelled),
      [keys.latestEvents]: structuredClone(latestEvents),
    });
    await storage.delete(keys.activeRun);
    return "cancelled";
  }
  const completed = requireStoredRunV1({
    ...run,
    events,
    status: "completed",
    responseText: result.text,
  } satisfies StoredRun);
  const records: Record<string, unknown> = {
    [keys.run]: structuredClone(completed),
    [keys.latestEvents]: structuredClone(latestEvents),
  };
  if (result.notification) {
    records[`${keys.notificationPrefix}${result.notification.notificationId}`] =
      structuredClone(result.notification);
  }
  await storage.put(records);
  await storage.delete(keys.activeRun);
  return "completed";
}

export async function failStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<"failed" | "cancelled" | "preserved-completion" | "missing"> {
  const stored = await storage.get<StoredRun>(keys.run);
  if (!stored) return "missing";
  const run = requireStoredRunV1(stored);
  if (run.status === "completed") return "preserved-completion";
  if (run.stopRequestedAt) {
    const cancelled = await cancelStoredRun(
      storage,
      keys,
      runId,
      previous,
      events,
    );
    return cancelled;
  }
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const failed = requireStoredRunV1({
    ...run,
    events: decodedEvents,
    status: "failed",
    failure,
  } satisfies StoredRun);
  await storage.put({
    [keys.run]: structuredClone(failed),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
  if ((await storage.get<string>(keys.activeRun)) === runId) {
    await storage.delete(keys.activeRun);
  }
  return "failed";
}

/**
 * Settles a stopped run as terminal `cancelled` and clears its active marker.
 * A cancelled run produces no response text, no failure, and no notification.
 */
export async function cancelStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
): Promise<"cancelled" | "preserved-completion" | "missing"> {
  const stored = await storage.get<StoredRun>(keys.run);
  if (!stored) return "missing";
  const run = requireStoredRunV1(stored);
  if (run.status === "completed") return "preserved-completion";
  if (!run.stopRequestedAt) {
    throw new Error(`run "${runId}" has no durable stop intent`);
  }
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const { responseText: _text, failure: _failure, ...settled } = run;
  const cancelled = requireStoredRunV1({
    ...settled,
    events: decodedEvents,
    status: "cancelled",
    phase: settled.phase === "reconciling" ? "executing" : settled.phase,
  } satisfies StoredRun);
  await storage.put({
    [keys.run]: structuredClone(cancelled),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
  if ((await storage.get<string>(keys.activeRun)) === runId) {
    await storage.delete(keys.activeRun);
  }
  return "cancelled";
}

export async function requireStoredRunReconciliation(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<void> {
  const activeRunId = await storage.get<string>(keys.activeRun);
  if (activeRunId !== runId) throw new Error(`run "${runId}" is not active`);
  const stored = await storage.get<StoredRun>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = requireStoredRunV1(stored);
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const reconciliation = requireStoredRunV1({
    ...run,
    events: decodedEvents,
    status: "reconciliation-required",
    phase: "reconciling",
    failure,
  } satisfies StoredRun);
  await storage.put({
    [keys.run]: structuredClone(reconciliation),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
}

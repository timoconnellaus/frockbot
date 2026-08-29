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
): Promise<void> {
  const activeRunId = await storage.get<string>(keys.activeRun);
  if (activeRunId !== runId) throw new Error(`run "${runId}" is not active`);
  const stored = await storage.get<StoredRun>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = requireStoredRunV1(stored);
  const events = result.events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...events].map(decodeSessionEvent);
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
}

export async function failStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<"failed" | "preserved-completion" | "missing"> {
  const stored = await storage.get<StoredRun>(keys.run);
  if (!stored) return "missing";
  const run = requireStoredRunV1(stored);
  if (run.status === "completed") return "preserved-completion";
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
    phase: "reconciliation-required",
    failure,
  } satisfies StoredRun);
  await storage.put({
    [keys.run]: structuredClone(reconciliation),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
}

import {
  decodeSessionEvent,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import type {
  BotTurnCompletion,
  StoredRunCodecV1,
  StoredRunV1,
} from "./run-records.js";

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

export async function completeStoredRun<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  result: BotTurnCompletion,
): Promise<"completed" | "cancelled"> {
  const activeRunId = await storage.get<string>(keys.activeRun);
  if (activeRunId !== runId) throw new Error(`run "${runId}" is not active`);
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = codec.require(stored);
  const events = result.events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...events].map(decodeSessionEvent);
  // Durable Stop intent recorded before this settlement wins: the run becomes
  // terminal `cancelled` with no response text, failure, or notification.
  if (run.stopRequestedAt) {
    const { responseText: _text, failure: _failure, ...settled } = run;
    const cancelled = codec.require({
      ...settled,
      events,
      status: "cancelled",
      phase:
        settled.phase === "reconciliation-required"
          ? "executing"
          : settled.phase,
    } satisfies StoredRunV1<Snapshot>);
    await storage.put({
      [keys.run]: structuredClone(cancelled),
      [keys.latestEvents]: structuredClone(latestEvents),
    });
    await storage.delete(keys.activeRun);
    return "cancelled";
  }
  const completed = codec.require({
    ...run,
    events,
    status: "completed",
    responseText: result.text,
  } satisfies StoredRunV1<Snapshot>);
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

/**
 * Settles a stopped run as terminal `cancelled` and clears its active marker.
 * A cancelled run produces no response text, no failure, and no notification.
 */
export async function cancelStoredRun<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
): Promise<"cancelled" | "preserved-completion" | "missing"> {
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) return "missing";
  const run = codec.require(stored);
  if (run.status === "completed") return "preserved-completion";
  if (!run.stopRequestedAt) {
    throw new Error(`run "${runId}" has no durable stop intent`);
  }
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const { responseText: _text, failure: _failure, ...settled } = run;
  const cancelled = codec.require({
    ...settled,
    events: decodedEvents,
    status: "cancelled",
    phase:
      settled.phase === "reconciliation-required" ? "executing" : settled.phase,
  } satisfies StoredRunV1<Snapshot>);
  await storage.put({
    [keys.run]: structuredClone(cancelled),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
  if ((await storage.get<string>(keys.activeRun)) === runId) {
    await storage.delete(keys.activeRun);
  }
  return "cancelled";
}

export async function failStoredRun<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<"failed" | "cancelled" | "preserved-completion" | "missing"> {
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) return "missing";
  const run = codec.require(stored);
  if (run.status === "completed") return "preserved-completion";
  // A stopped run never becomes `failed`: Stop is the durable outcome.
  if (run.stopRequestedAt) {
    return cancelStoredRun(codec, storage, keys, runId, previous, events);
  }
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const failed = codec.require({
    ...run,
    events: decodedEvents,
    status: "failed",
    phase: run.phase === "reconciliation-required" ? "executing" : run.phase,
    failure,
  } satisfies StoredRunV1<Snapshot>);
  await storage.put({
    [keys.run]: structuredClone(failed),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
  if ((await storage.get<string>(keys.activeRun)) === runId) {
    await storage.delete(keys.activeRun);
  }
  return "failed";
}

export async function requireStoredRunReconciliation<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<void> {
  const activeRunId = await storage.get<string>(keys.activeRun);
  if (activeRunId !== runId) throw new Error(`run "${runId}" is not active`);
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = codec.require(stored);
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const reconciliation = codec.require({
    ...run,
    events: decodedEvents,
    status: "reconciliation-required",
    phase: "reconciliation-required",
    failure,
  } satisfies StoredRunV1<Snapshot>);
  await storage.put({
    [keys.run]: structuredClone(reconciliation),
    [keys.latestEvents]: structuredClone(latestEvents),
  });
}

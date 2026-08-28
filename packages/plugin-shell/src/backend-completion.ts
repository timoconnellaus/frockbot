import type { SessionEvent } from "@frockbot/agent-core";
import type { BotTurnCompletion, StoredRun } from "./backend-contracts.js";

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
  const run = await storage.get<StoredRun>(keys.run);
  if (!run) throw new Error(`run "${runId}" was not accepted`);
  const records: Record<string, unknown> = {
    [keys.run]: {
      ...run,
      events: structuredClone(result.events),
      status: "completed",
      responseText: result.text,
    } satisfies StoredRun,
    [keys.latestEvents]: structuredClone([...previous, ...result.events]),
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
  const run = await storage.get<StoredRun>(keys.run);
  if (!run) return "missing";
  if (run.status === "completed") return "preserved-completion";
  await storage.put({
    [keys.run]: {
      ...run,
      events: structuredClone([...events]),
      status: "failed",
      failure,
    } satisfies StoredRun,
    [keys.latestEvents]: structuredClone([...previous, ...events]),
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
  const run = await storage.get<StoredRun>(keys.run);
  if (!run) throw new Error(`run "${runId}" was not accepted`);
  await storage.put({
    [keys.run]: {
      ...run,
      events: structuredClone([...events]),
      status: "reconciliation-required",
      phase: "reconciliation-required",
      failure,
    } satisfies StoredRun,
    [keys.latestEvents]: structuredClone([...previous, ...events]),
  });
}

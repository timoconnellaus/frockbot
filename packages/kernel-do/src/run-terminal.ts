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

/**
 * Records a Package writes in the same transaction that settles a Turn. The
 * kernel never reads them: it is handed opaque key/value pairs and a reader
 * bound to the settling transaction, exactly as it is handed notification
 * content, so a Package can make a durable decision atomic with the settlement
 * without the kernel holding the policy that produced it.
 */
export type TerminalPackageRecords<Snapshot> = (input: {
  run: StoredRunV1<Snapshot>;
  read<T>(key: string): Promise<T | undefined>;
}) => Promise<Record<string, unknown>>;

/** The kernel owns these; a Package record may never land on one. */
function assertPackageRecordKeys(
  records: Record<string, unknown>,
  keys: RunTerminalKeys,
): void {
  for (const key of Object.keys(records)) {
    if (
      key === keys.run ||
      key === keys.activeRun ||
      key === keys.latestEvents ||
      key.startsWith(keys.notificationPrefix)
    ) {
      throw new Error(`terminal record "${key}" is a kernel key`);
    }
  }
}

/**
 * Records a Package writes in the transaction that settles a Turn as
 * `superseded`. Same shape and same rule as `TerminalPackageRecords`: the
 * kernel writes opaque keys and holds none of the policy that produced them.
 * It is a separate seam because a superseded Turn is not a completed one — the
 * Package that owns the conversation wants to leave the *next* Turn a durable
 * note, not advance the records a finished Turn advances.
 */
export type SupersededPackageRecords<Snapshot> = (input: {
  run: StoredRunV1<Snapshot>;
  read<T>(key: string): Promise<T | undefined>;
}) => Promise<Record<string, unknown>>;

/**
 * Settles a superseded run as terminal `superseded` and clears its active
 * marker. Like a cancelled run it produces no response text, no failure, and
 * no notification: the Turn that replaced it is what the User is watching.
 */
export async function supersedeStoredRun<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  packageRecords?: SupersededPackageRecords<Snapshot>,
): Promise<"superseded"> {
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = codec.require(stored);
  if (!run.supersededAt) {
    throw new Error(`run "${runId}" has no durable supersede intent`);
  }
  const decodedEvents = events.map(decodeSessionEvent);
  const { responseText: _text, failure: _failure, ...settled } = run;
  // A run superseded while still queued never started, never appended an
  // event, and never spoke: it settles as a record on its own and leaves both
  // the session log and the running Turn exactly where they were.
  const queued = settled.phase === "queued";
  const superseded = codec.require({
    ...settled,
    events: queued ? [] : decodedEvents,
    status: "superseded",
    phase:
      settled.phase === "reconciliation-required"
        ? "executing"
        : settled.phase === "queued"
          ? "admitted"
          : settled.phase,
  } satisfies StoredRunV1<Snapshot>);
  const records: Record<string, unknown> = {
    [keys.run]: structuredClone(superseded),
    ...(queued
      ? {}
      : {
          [keys.latestEvents]: structuredClone(
            [...previous, ...decodedEvents].map(decodeSessionEvent),
          ),
        }),
  };
  if (packageRecords && !queued) {
    const contributed = await packageRecords({
      run: superseded,
      read: <T>(key: string) => storage.get<T>(key),
    });
    assertPackageRecordKeys(contributed, keys);
    for (const [key, value] of Object.entries(contributed)) {
      records[key] = structuredClone(value);
    }
  }
  await storage.put(records);
  if ((await storage.get<string>(keys.activeRun)) === runId) {
    await storage.delete(keys.activeRun);
  }
  return "superseded";
}

export async function completeStoredRun<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  result: BotTurnCompletion,
  packageRecords?: TerminalPackageRecords<Snapshot>,
  supersededRecords?: SupersededPackageRecords<Snapshot>,
): Promise<"completed" | "cancelled" | "superseded"> {
  const activeRunId = await storage.get<string>(keys.activeRun);
  if (activeRunId !== runId) throw new Error(`run "${runId}" is not active`);
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) throw new Error(`run "${runId}" was not accepted`);
  const run = codec.require(stored);
  const events = result.events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...events].map(decodeSessionEvent);
  // Stop outranks supersede: the User asked for this Turn to stop, and a
  // message that arrived after that does not turn their cancellation into
  // something else.
  if (run.supersededAt && !run.stopRequestedAt) {
    return supersedeStoredRun(
      codec,
      storage,
      keys,
      runId,
      previous,
      result.events,
      supersededRecords,
    );
  }
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
  if (packageRecords) {
    const contributed = await packageRecords({
      run: completed,
      read: <T>(key: string) => storage.get<T>(key),
    });
    assertPackageRecordKeys(contributed, keys);
    for (const [key, value] of Object.entries(contributed)) {
      records[key] = structuredClone(value);
    }
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
  supersededRecords?: SupersededPackageRecords<Snapshot>,
): Promise<
  "failed" | "cancelled" | "superseded" | "preserved-completion" | "missing"
> {
  const stored = await storage.get<StoredRunV1<Snapshot>>(keys.run);
  if (!stored) return "missing";
  const run = codec.require(stored);
  if (run.status === "completed") return "preserved-completion";
  // A stopped run never becomes `failed`: Stop is the durable outcome.
  if (run.stopRequestedAt) {
    return cancelStoredRun(codec, storage, keys, runId, previous, events);
  }
  // Nor does a superseded one. The Turn that replaced it is the outcome.
  if (run.supersededAt) {
    return supersedeStoredRun(
      codec,
      storage,
      keys,
      runId,
      previous,
      events,
      supersededRecords,
    );
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

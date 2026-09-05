import {
  decodeSessionEvent,
  Session,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import type {
  BotNotificationIntent,
  BotTurnCompletion,
  StoredRunCodecV1,
  StoredRunV1,
} from "./run-records.js";
import { storedRunRecordV2 } from "./run-records.js";
import { storedRunEventFieldsV2 } from "./run-records.js";
import { repairedSessionLogV1 } from "./run-recovery.js";
import {
  SessionEventLog,
  type SessionEventLogStorage,
} from "./session-event-log.js";

/**
 * The events a terminal settlement commits, with any Turn they were left
 * inside closed.
 *
 * A Turn interrupted mid-answer unwinds without writing a `turn/end`: the
 * outcome of its model request is unknown, and a `turn/end` would claim to know
 * how it ended. That is right while the run might still resume — and wrong the
 * moment it will not. Settling one and committing its events as they stand left
 * an open turn in the durable session log, so `turn N started while turn N-1 is
 * open` refused every later message on that Bot, forever, and printed itself
 * verbatim into the person's next bubble.
 *
 * So closing the turn happens exactly here: at the one point where the run is
 * certainly not resuming. `reconcileInterrupted` writes the same repair the
 * recovery path already writes — every unresolved tool occurrence closed as
 * `interrupted`, then `step/end` and `turn/end` — so the settled log is a
 * complete account and the next Turn starts on a closed one.
 *
 * A log that is already closed produces no repairs, and one too malformed to
 * reconcile is left exactly as it is: repairing that blindly would invent
 * history.
 */
function settledEventsV1(
  sessionId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
): { events: SessionEvent[]; latestEvents: SessionEvent[] } {
  const decoded = events.map(decodeSessionEvent);
  const latest = [...previous, ...decoded].map(decodeSessionEvent);
  let repairs: SessionEvent[] = [];
  try {
    repairs = new Session(sessionId, () => {}, latest).reconcileInterrupted();
  } catch {
    repairs = [];
  }
  const settled = [...latest, ...repairs];
  // A Turn abandoned earlier in the log cannot be closed by appending, and a
  // settlement that only appends leaves it open forever. The run's own events
  // are committed as they stand — that record is this run's account, not the
  // conversation's — while the forward log is repaired in place so the next
  // Turn starts on a log that reads as a complete history.
  return {
    events: [...decoded, ...repairs],
    latestEvents: repairedSessionLogV1(sessionId, settled) ?? settled,
  };
}

export interface RunTerminalStorage extends SessionEventLogStorage {}

export interface RunTerminalKeys {
  run: string;
  activeRun: string;
  latestEvents: string;
  notificationPrefix: string;
}

async function hydratedRun<Snapshot>(
  codec: StoredRunCodecV1<Snapshot>,
  storage: RunTerminalStorage,
  key: string,
): Promise<StoredRunV1<Snapshot> | undefined> {
  const stored = codec.optional(await storage.get<unknown>(key));
  if (!stored?.eventRange) return stored;
  const events = await new SessionEventLog(storage).readRange(
    stored.sessionId,
    stored.eventRange.startSeq,
    stored.eventRange.endSeq,
  );
  if (events.length !== stored.eventRange.endSeq - stored.eventRange.startSeq) {
    throw new Error(`run "${stored.runId}" has an incomplete event range`);
  }
  return codec.require({ ...stored, events });
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
 * The notification a Turn that ended `failed` owes the person who was waiting
 * on it, decided by the Package that owns notification content.
 *
 * A completed Turn already tells them — "Bob replied", with what it said —
 * through the completion's own intent. A failed Turn had none, so the only
 * person who ever learned was the one still looking at that conversation. This
 * is the same seam for the other outcome: the kernel hands over the settled
 * record, whose `configurationSnapshot` is the durable copy of the settings
 * the Turn was admitted under, and writes back whatever intent comes out
 * without reading it.
 *
 * It is consulted only on the transition into `failed`, so a replay or a
 * recovery pass over a run that already settled writes nothing — an
 * acknowledged notification stays acknowledged.
 */
export type FailedRunNotification<Snapshot> = (
  run: StoredRunV1<Snapshot>,
) => BotNotificationIntent | undefined;

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
  const run = await hydratedRun(codec, storage, keys.run);
  if (!run) throw new Error(`run "${runId}" was not accepted`);
  if (!run.supersededAt) {
    throw new Error(`run "${runId}" has no durable supersede intent`);
  }
  const settledEvents = settledEventsV1(run.sessionId, previous, events);
  const decodedEvents = settledEvents.events;
  const { responseText: _text, failure: _failure, ...settled } = run;
  // A run superseded while still queued never started, never appended an
  // event, and never spoke: it settles as a record on its own and leaves both
  // the session log and the running Turn exactly where they were.
  const queued = settled.phase === "queued";
  const superseded = codec.require({
    ...settled,
    ...storedRunEventFieldsV2(
      run.previousEventCount,
      queued ? [] : decodedEvents,
    ),
    status: "superseded",
    phase:
      settled.phase === "reconciliation-required"
        ? "executing"
        : settled.phase === "queued"
          ? "admitted"
          : settled.phase,
  } satisfies StoredRunV1<Snapshot>);
  const records: Record<string, unknown> = {
    [keys.run]: structuredClone(storedRunRecordV2(superseded)),
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
  if (!queued) {
    await new SessionEventLog(storage).rewrite(
      run.sessionId,
      settledEvents.latestEvents,
    );
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
  const run = await hydratedRun(codec, storage, keys.run);
  if (!run) throw new Error(`run "${runId}" was not accepted`);
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
      ...storedRunEventFieldsV2(run.previousEventCount, events),
      status: "cancelled",
      phase:
        settled.phase === "reconciliation-required"
          ? "executing"
          : settled.phase,
    } satisfies StoredRunV1<Snapshot>);
    await new SessionEventLog(storage).rewrite(run.sessionId, latestEvents);
    await storage.put({
      [keys.run]: structuredClone(storedRunRecordV2(cancelled)),
    });
    await storage.delete(keys.activeRun);
    return "cancelled";
  }
  const completed = codec.require({
    ...run,
    ...storedRunEventFieldsV2(run.previousEventCount, events),
    status: "completed",
    responseText: result.text,
  } satisfies StoredRunV1<Snapshot>);
  const records: Record<string, unknown> = {
    [keys.run]: structuredClone(storedRunRecordV2(completed)),
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
  await new SessionEventLog(storage).rewrite(run.sessionId, latestEvents);
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
  const run = await hydratedRun(codec, storage, keys.run);
  if (!run) return "missing";
  if (run.status === "completed") return "preserved-completion";
  if (!run.stopRequestedAt) {
    throw new Error(`run "${runId}" has no durable stop intent`);
  }
  const settledEvents = settledEventsV1(run.sessionId, previous, events);
  const decodedEvents = settledEvents.events;
  const latestEvents = settledEvents.latestEvents;
  const { responseText: _text, failure: _failure, ...settled } = run;
  const cancelled = codec.require({
    ...settled,
    ...storedRunEventFieldsV2(run.previousEventCount, decodedEvents),
    status: "cancelled",
    phase:
      settled.phase === "reconciliation-required" ? "executing" : settled.phase,
  } satisfies StoredRunV1<Snapshot>);
  await new SessionEventLog(storage).rewrite(run.sessionId, latestEvents);
  await storage.put({
    [keys.run]: structuredClone(storedRunRecordV2(cancelled)),
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
  failureNotification?: FailedRunNotification<Snapshot>,
): Promise<
  "failed" | "cancelled" | "superseded" | "preserved-completion" | "missing"
> {
  const run = await hydratedRun(codec, storage, keys.run);
  if (!run) return "missing";
  if (run.status === "completed") return "preserved-completion";
  // Whether this settlement is the one that fails the run. A run already
  // `failed` can be settled again — recovery and the stale-run repair both
  // re-enter — and the second pass owes nobody a second notification.
  const alreadyFailed = run.status === "failed";
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
  const settledEvents = settledEventsV1(run.sessionId, previous, events);
  const decodedEvents = settledEvents.events;
  const latestEvents = settledEvents.latestEvents;
  const failed = codec.require({
    ...run,
    ...storedRunEventFieldsV2(run.previousEventCount, decodedEvents),
    status: "failed",
    phase: run.phase === "reconciliation-required" ? "executing" : run.phase,
    failure,
  } satisfies StoredRunV1<Snapshot>);
  const records: Record<string, unknown> = {
    [keys.run]: structuredClone(storedRunRecordV2(failed)),
  };
  const intent = alreadyFailed ? undefined : failureNotification?.(failed);
  if (intent) {
    records[`${keys.notificationPrefix}${intent.notificationId}`] =
      structuredClone(intent);
  }
  await new SessionEventLog(storage).rewrite(run.sessionId, latestEvents);
  await storage.put(records);
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
  const run = await hydratedRun(codec, storage, keys.run);
  if (!run) throw new Error(`run "${runId}" was not accepted`);
  const decodedEvents = events.map(decodeSessionEvent);
  const latestEvents = [...previous, ...decodedEvents].map(decodeSessionEvent);
  const reconciliation = codec.require({
    ...run,
    ...storedRunEventFieldsV2(run.previousEventCount, decodedEvents),
    status: "reconciliation-required",
    phase: "reconciliation-required",
    failure,
  } satisfies StoredRunV1<Snapshot>);
  await new SessionEventLog(storage).rewrite(run.sessionId, latestEvents);
  await storage.put({
    [keys.run]: structuredClone(storedRunRecordV2(reconciliation)),
  });
}

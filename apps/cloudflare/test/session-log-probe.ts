// Test-side reader for raw run records. Production records carry only a
// Session sequence range; workerd tests that deliberately inspect or rewind a
// run hydrate that range through the same accessor as production recovery.
import {
  decodeSessionEvent,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import { SessionEventLog } from "@frockbot/kernel-do";

interface EventRangedRunV1 {
  sessionId: string;
  events?: unknown[];
  eventRange?: { startSeq: number; endSeq: number };
}

type HydratedRunV1<Run extends EventRangedRunV1> = Omit<Run, "events"> & {
  events: SessionEvent[];
};

export async function hydrateStoredRunEventsV1<Run extends EventRangedRunV1>(
  storage: DurableObjectStorage,
  run: Run,
): Promise<HydratedRunV1<Run>> {
  if (run.eventRange) {
    const events = await new SessionEventLog(storage).readRange(
      run.sessionId,
      run.eventRange.startSeq,
      run.eventRange.endSeq,
    );
    return { ...run, events };
  }
  return { ...run, events: (run.events ?? []).map(decodeSessionEvent) };
}

export async function hydratedStoredRunsV1<Run extends EventRangedRunV1>(
  storage: DurableObjectStorage,
): Promise<Array<HydratedRunV1<Run>>> {
  const stored = await storage.list<Run>({ prefix: "run:" });
  return Promise.all(
    [...stored.values()].map((run) => hydrateStoredRunEventsV1(storage, run)),
  );
}

/** Rewinds a settled test run without restoring either legacy large value. */
export async function rewindStoredRunEventsV1<
  Run extends EventRangedRunV1 & { previousEventCount: number },
>(
  storage: DurableObjectStorage,
  key: string,
  raw: Run & { responseText?: string; failure?: string },
  events: SessionEvent[],
  patch: Record<string, unknown>,
): Promise<void> {
  const hydrated = await hydrateStoredRunEventsV1(storage, raw);
  const log = new SessionEventLog(storage);
  const latest = await log.read(hydrated.sessionId);
  await log.rewrite(hydrated.sessionId, [
    ...latest.slice(0, hydrated.previousEventCount),
    ...events,
  ]);
  const {
    events: _events,
    eventRange: _range,
    responseText: _response,
    failure: _failure,
    ...record
  } = hydrated;
  await storage.put(key, {
    ...record,
    ...patch,
    eventRange: {
      startSeq: hydrated.previousEventCount,
      endSeq: hydrated.previousEventCount + events.length,
    },
  });
}

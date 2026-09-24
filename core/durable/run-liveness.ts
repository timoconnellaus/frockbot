import {
  type SessionEvent,
  TURN_DEADLINE_MS_V1,
} from "@frockbot/core/contracts";
import type { StoredRunV1 } from "./run-records.js";

/**
 * How long past the Turn deadline a `running` record is still given the
 * benefit of the doubt.
 *
 * The deadline is enforced by a timer inside the loop, and the settlement that
 * follows it is a durable write on the far side of an abort: there is a real
 * interval in which a Turn is legitimately still finishing after its clock ran
 * out. A minute is far longer than that unwind takes and far shorter than the
 * hours an abandoned record has been claiming to work.
 */
export const STALE_RUNNING_RUN_GRACE_MS_V1 = 60_000;

/**
 * What a run settled by this rule records, in the same register as an
 * unretrievable Turn's settlement: what happened, and what to do about it.
 */
export const STALE_RUNNING_RUN_FAILURE_V1 =
  "This Turn stopped without finishing and was settled when nothing was left to finish it. Try sending it again.";

export interface RunLivenessV1 {
  /** Whether the run can still be a Turn somebody is running. */
  readonly working: boolean;
  /**
   * Whether the record claims to be running and demonstrably is not, so the
   * reader that asked owes it a terminal settlement.
   */
  readonly stale: boolean;
  /** Why it is stale, for the failure a settlement records. Absent when it is not. */
  readonly reason?: "deadline" | "turn-closed";
}

const NOT_RUNNING: RunLivenessV1 = { working: false, stale: false };

/**
 * The seq of the last `turn/start` this run wrote, or `undefined` when it has
 * not opened a Turn in the durable log yet.
 */
function openedTurnSeqV1(events: readonly SessionEvent[]): number | undefined {
  let seq: number | undefined;
  for (const event of events) {
    if (event.type === "turn/start") seq = event.seq;
  }
  return seq;
}

/**
 * Whether a run is honestly still working.
 *
 * `status === "running"` is not the test: a record is only ever moved off
 * `running` by a settlement, so every way a Turn can stop without settling —
 * a Worker torn down mid-answer, the "turn N started while turn N-1 is open"
 * wedges — leaves a record that says `running` until something settles it.
 * This rule is how the repair index decides a record it comes to is over.
 *
 * Three conditions, all of which must hold:
 *
 * - the record says `running`, which is necessary and was mistaken for
 *   sufficient;
 * - it has not outlived {@link TURN_DEADLINE_MS_V1} plus
 *   {@link STALE_RUNNING_RUN_GRACE_MS_V1}, because the loop stops waiting at
 *   the deadline and a record older than that cannot be a Turn anybody is
 *   still running;
 * - the durable session log does not already close the Turn it opened. A
 *   `turn/end` at or after this run's own `turn/start` means something has
 *   already written the Turn's ending — the admission repair, usually — and a
 *   record still saying `running` behind a closed Turn is a leftover, not work.
 *
 * A run that has not written its `turn/start` yet is judged on the deadline
 * alone: there is no Turn in the log to call closed, and the previous Turn's
 * `turn/end` says nothing about this one.
 *
 * Pure, and deliberately so: the settlement consults it inside its
 * transaction, and the tests reach the same verdict without one.
 */
export function runLivenessV1(input: {
  run:
    Pick<StoredRunV1<unknown>, "status" | "acceptedAt" | "events"> | undefined;
  /** The Bot's durable session log, as the run's own events sit inside it. */
  sessionEvents: readonly SessionEvent[];
  now?: number;
  deadlineMs?: number;
  graceMs?: number;
}): RunLivenessV1 {
  const run = input.run;
  if (!run || run.status !== "running") return NOT_RUNNING;
  const now = input.now ?? Date.now();
  const deadline =
    (input.deadlineMs ?? TURN_DEADLINE_MS_V1) +
    (input.graceMs ?? STALE_RUNNING_RUN_GRACE_MS_V1);
  const acceptedAt = Date.parse(run.acceptedAt);
  // An unparseable timestamp is not evidence of death. The record is left
  // alone rather than settled on a number nobody can read.
  if (Number.isFinite(acceptedAt) && now - acceptedAt > deadline) {
    return { working: false, stale: true, reason: "deadline" };
  }
  const opened = openedTurnSeqV1(run.events);
  if (
    opened !== undefined &&
    input.sessionEvents.some(
      (event) => event.type === "turn/end" && event.seq >= opened,
    )
  ) {
    return { working: false, stale: true, reason: "turn-closed" };
  }
  return { working: true, stale: false };
}

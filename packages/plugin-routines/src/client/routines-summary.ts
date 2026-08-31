/**
 * The Routines line the per-Bot info pane shows.
 *
 * GrokBot's info pane puts the agent's routines under the computer preview
 * (register row 51). The full section stays in Bot settings; the pane needs one
 * glance: how many Routines there are, how many are live, when the scheduler
 * next fires and when it last did.
 *
 * Everything here reads durable state the Routine list already carried. "Next
 * run" is only ever a moment the authority armed an alarm on — a paused
 * Routine and a webhook Routine both promise nothing, and this summary
 * promises nothing on their behalf.
 */
import type { RoutineViewV1 } from "../shared.js";

export interface RoutinesSummaryV1 {
  total: number;
  enabled: number;
  /** Routines fired by a webhook rather than a schedule. */
  webhooks: number;
  /** The soonest armed firing across every Routine, when there is one. */
  nextRunAt?: string;
  /** The Routine that firing belongs to. */
  nextRunName?: string;
  /** The most recent firing across every Routine, when there has been one. */
  lastRunAt?: string;
  lastRunName?: string;
}

function earliest(
  left: { at: string; name: string } | undefined,
  right: { at: string; name: string } | undefined,
): { at: string; name: string } | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.at < left.at ? right : left;
}

function latest(
  left: { at: string; name: string } | undefined,
  right: { at: string; name: string } | undefined,
): { at: string; name: string } | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.at > left.at ? right : left;
}

export function summarizeRoutinesV1(
  routines: readonly RoutineViewV1[],
): RoutinesSummaryV1 {
  let next: { at: string; name: string } | undefined;
  let last: { at: string; name: string } | undefined;
  let enabled = 0;
  let webhooks = 0;
  for (const routine of routines) {
    if (routine.enabled) enabled += 1;
    if (!routine.schedule) webhooks += 1;
    if (routine.nextRunAt) {
      next = earliest(next, { at: routine.nextRunAt, name: routine.name });
    }
    if (routine.lastRunAt) {
      last = latest(last, { at: routine.lastRunAt, name: routine.name });
    }
  }
  return {
    total: routines.length,
    enabled,
    webhooks,
    ...(next ? { nextRunAt: next.at, nextRunName: next.name } : {}),
    ...(last ? { lastRunAt: last.at, lastRunName: last.name } : {}),
  };
}

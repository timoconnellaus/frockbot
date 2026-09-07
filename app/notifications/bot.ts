// What a Bot tells the person who is not looking at it: the notification
// intents a settled Turn produces, and the durable records that settlement
// writes beside them.

import type { SessionEvent } from "@frockbot/core/contracts";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import { routineHandoffTextV1 } from "@frockbot/app/routines/inbox";
import {
  approvalNotificationBodyV1,
  approvalNotificationIdV1,
  approvalSendsV1,
} from "@frockbot/app/shell/approvals";
import type {
  BotNotificationIntent,
  BotTurnCompletion,
  StoredRun,
} from "@frockbot/app/shell/backend-contracts";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { notificationIdV1 } from "@frockbot/app/shell/notification-id";
import { runFailureCopyV1 } from "@frockbot/app/shell/run-failure-copy";
import {
  shellTerminalRecordsV1,
  supersededTurnRecordsV1,
} from "@frockbot/app/shell/terminal-records";

export async function listNotifications(
  state: ShellBotStateV1,
): Promise<BotNotificationIntent[]> {
  return state.authority.listNotifications();
}

export async function acknowledgeNotification(
  state: ShellBotStateV1,
  notificationId: string,
): Promise<void> {
  return state.authority.acknowledgeNotification(notificationId);
}

/** What a settled Turn tells the person who was not watching it. */
export function createNotification(
  settings: BotSettingsViewV1,
  result: BotTurnCompletion,
): BotNotificationIntent | undefined {
  // An approval is not an update, and `notifications.enabled` is the mute on
  // updates. A question that has stopped the Bot outranks it: the intent is
  // recorded at `critical` whatever the Bot's notification policy says,
  // exactly as a secret request would be. Muting silences chatter, not a
  // decision the Bot is waiting on.
  const [asked] = approvalSendsV1(result.events);
  if (asked) {
    return {
      notificationId: approvalNotificationIdV1(asked.approvalId),
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} needs your approval`,
      body: approvalNotificationBodyV1(asked),
      urgency: "critical",
    };
  }
  if (!settings.notifications.enabled) return undefined;
  const automation = result.events.some(
    (event) => event.type === "turn/admission" && event.turnType !== "chat",
  );
  if (automation) {
    const handoff = routineHandoffTextV1(result.events);
    // A firing that handed off is the only automation Turn that says
    // anything to a person here. A silent completion lands in the inbox and
    // notifies nobody: "persisted silently, arriving later as an
    // `automation_completion_inbox` row".
    if (handoff === undefined) return undefined;
    return {
      notificationId: notificationIdV1("routine-wake", result.runId),
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} finished a Routine`,
      body: handoff.slice(0, 240),
    };
  }
  return {
    notificationId: result.runId,
    runId: result.runId,
    createdAt: new Date().toISOString(),
    title: `${settings.profile.name} replied`,
    body: result.text.slice(0, 240),
  };
}

/**
 * What a Turn that did not finish tells the person who was waiting on it.
 *
 * A completed Turn notifies ("Bob replied", with what it said); a failed one
 * used to notify nobody, so a deadline, a provider outage, a restart or a
 * Composition that would not mount was visible only to whoever happened to
 * still be looking at that conversation. This is the same intent for the
 * other outcome, written in the transaction that settles the run, once per
 * failed run.
 *
 * The body is the product's own sentence for the failure — `runFailureCopyV1`
 * is the one place a stored diagnostic becomes something a person reads —
 * and never the diagnostic itself, which stays on the debug surface.
 */
export function createFailureNotification(
  settings: BotSettingsViewV1,
  failed: {
    runId: string;
    failure: string;
    events: readonly SessionEvent[];
  },
): BotNotificationIntent | undefined {
  // The mute on updates covers this one: a failure is an update about a Turn
  // that ended, not a decision the Bot is waiting on.
  if (!settings.notifications.enabled) return undefined;
  // An automation Turn does not speak to its User here. A Routine firing that
  // fails already records its own `routine-failed` notification, and a
  // subagent task its own; a second intent for the same failure would be two
  // rows for one event.
  const automation = failed.events.some(
    (event) => event.type === "turn/admission" && event.turnType !== "chat",
  );
  if (automation) return undefined;
  return {
    notificationId: notificationIdV1("run-failed", failed.runId),
    runId: failed.runId,
    createdAt: new Date().toISOString(),
    title: `${settings.profile.name} couldn't finish`,
    body: runFailureCopyV1({
      failure: failed.failure,
      events: failed.events,
    }).slice(0, 240),
  };
}

/**
 * Everything the Shell writes in the transaction that settles a Turn.
 *
 * The composition itself lives in `terminal-records.ts`, where "each producer
 * exactly once, and no producer silently overwrites another" is a checked
 * property rather than the shape of three spreads.
 */
export function terminalPackageRecords(input: {
  run: StoredRun;
  cursor: string;
  read<T>(key: string): Promise<T | undefined>;
}): Promise<Record<string, unknown>> {
  return shellTerminalRecordsV1({
    run: input.run,
    cursor: input.cursor,
    now: new Date().toISOString(),
    read: input.read,
  });
}

/**
 * What a superseded Turn leaves for the Turn that replaced it.
 *
 * One durable input, drained once by the next conversational Turn. The session
 * log already carries what the Turn sent and what its tools returned; this is
 * the part that is not in the log — that it was cut off, that nothing in
 * flight completed, and that a subagent it dispatched is still working.
 */
export function supersededPackageRecords(input: {
  run: StoredRun;
  read<T>(key: string): Promise<T | undefined>;
}): Promise<Record<string, unknown>> {
  return supersededTurnRecordsV1({
    run: input.run,
    now: new Date().toISOString(),
    read: input.read,
  });
}

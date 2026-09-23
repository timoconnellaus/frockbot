// The Bot Durable Object's side of Plugin health (ADR 0026 step 9): a
// failure becomes a notice in the User's inbox, counts toward the per-Bot
// quarantine, and — for a locked Plugin — fails the Turn instead.
import { notificationIdV1 } from "@frockbot/app/shell/notification-id";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "./catalog.js";
import { switchPluginForBotV1 } from "./authoring.js";
import {
  PLUGIN_QUARANTINE_THRESHOLD_V1,
  pluginFailureRunKindV1,
  readPluginHealthV1,
  recordPluginFailureV1,
  type PluginFailureKindV1,
  type PluginFailurePhaseV1,
  type PluginHealthRecordV1,
} from "./health.js";

/** One Plugin failing during one Turn, as the mount host reports it. */
export interface PluginFailureNoticeV1 {
  pluginId: string;
  phase: PluginFailurePhaseV1;
  message: string;
  /**
   * What the Plugin was doing, when it was not a Turn's own work: a card the
   * person pressed, a card the Bot asked it to draw, or this Bot's theme. None
   * is a Turn, so a notice about one must not say a Turn was lost. It changes
   * the words the person reads and nothing else: the count is the same.
   */
  kind?: Exclude<PluginFailureKindV1, "turn">;
}

/** What the mount host does with the failure: carry on without the Plugin, or not. */
export type PluginFailureVerdictV1 = { fatal: false } | { fatal: true };

function locked(pluginId: string): boolean {
  return DEPLOYMENT_PLUGIN_CATALOG_V1.some(
    (plugin) => plugin.pluginId === pluginId && plugin.seed === "locked",
  );
}

/** What failed, in the words the notice uses. */
function failureWords(failure: PluginFailureNoticeV1): string {
  switch (failure.kind) {
    case "press":
      return "could not answer a card press";
    case "draw":
      return "could not draw a card";
    case "theme":
      return "could not set this Bot's theme";
    default:
      return phaseWords(failure.phase);
  }
}

/** What a locked Plugin's failure cost, in the words the notice uses. */
function lockedCost(failure: PluginFailureNoticeV1): string {
  switch (failure.kind) {
    case "press":
      return "It is always on for this Bot, and the card was left exactly as it was.";
    case "draw":
      return "It is always on for this Bot, and the card could not be drawn.";
    case "theme":
      return "It is always on for this Bot, and its change to this Bot's theme was not applied.";
    default:
      return "It is always on for this Bot, so the Turn could not continue without it.";
  }
}

/** What the failure cost, in the words the notice uses. */
function failureCost(failure: PluginFailureNoticeV1): string {
  switch (failure.kind) {
    case "press":
      return "The card press did not go through, and this Bot carried on.";
    case "draw":
      return "The card could not be drawn, and this Bot carried on.";
    case "theme":
      return "Its change to this Bot's theme was not applied.";
    default:
      return "This Bot carried on without it.";
  }
}

/**
 * Where the Plugin stands against the count that would turn it off. A press
 * and a draw are counted the same way a Turn is, but neither is a Turn, so
 * only a run made of Turns alone may be read back to the person as Turns —
 * the run the count is of, not whichever failure happened to arrive last.
 */
function failureCount(health: PluginHealthRecordV1): string {
  return pluginFailureRunKindV1(health) === "turn"
    ? `${health.consecutiveFailures} of ${PLUGIN_QUARANTINE_THRESHOLD_V1} failing Turns in a row before it is turned off.`
    : `${health.consecutiveFailures} of ${PLUGIN_QUARANTINE_THRESHOLD_V1} failures in a row before it is turned off.`;
}

/**
 * The run that turned the Plugin off, in the words the notice uses. Presses
 * and draws are counted with Turns, so the run may be any mixture of them: a
 * run of one kind says which, and a mixed run says only that it failed.
 */
function quarantineRun(health: PluginHealthRecordV1): string {
  switch (pluginFailureRunKindV1(health)) {
    case "turn":
      return `failed on ${health.consecutiveFailures} Turns in a row`;
    case "press":
      return `failed on ${health.consecutiveFailures} card presses in a row`;
    case "draw":
      return `failed on ${health.consecutiveFailures} card draws in a row`;
    case "theme":
      return `failed to set this Bot's theme ${health.consecutiveFailures} times in a row`;
    default:
      return `failed ${health.consecutiveFailures} times in a row`;
  }
}

/** The notice's title, which must not say a Turn was lost when none was. */
function failureTitle(failure: PluginFailureNoticeV1): string {
  switch (failure.kind) {
    case "press":
      return "A plugin could not answer a card press";
    case "draw":
      return "A plugin could not draw a card";
    case "theme":
      return "A plugin could not set this Bot's theme";
    default:
      return "A plugin was skipped";
  }
}

function phaseWords(phase: PluginFailurePhaseV1): string {
  switch (phase) {
    case "hook":
      return "was skipped for this Turn";
    case "health":
      return "did not pass its health check";
    case "resolve":
      return "could not be admitted";
    case "mount":
      return "did not mount";
  }
}

/**
 * Record one failure and tell the User. A locked Plugin's failure is fatal:
 * "a locked Plugin cannot be skipped, so its failure fails the Turn". Every
 * other Plugin is skipped, noticed once per Turn and phase, and turned off
 * for this Bot at the third failing Turn in a row.
 */
export async function notePluginFailureV1(
  state: ShellBotStateV1,
  turn: { runId: string; generationId: string },
  failure: PluginFailureNoticeV1,
  now: () => Date = () => new Date(),
): Promise<PluginFailureVerdictV1> {
  if (locked(failure.pluginId)) {
    await state.authority.recordNotification({
      notificationId: notificationIdV1(
        "plugin-locked-failed",
        turn.runId,
        failure.pluginId,
        failure.phase,
        failure.kind ?? "turn",
      ),
      runId: turn.runId,
      createdAt: now().toISOString(),
      title: "A required plugin failed",
      body: `The plugin "${failure.pluginId}" ${failureWords(failure)}: ${failure.message}. ${lockedCost(failure)}`.slice(
        0,
        2_000,
      ),
      urgency: "critical",
    });
    return { fatal: true };
  }
  // A Plugin that is already off has been answered: its failures neither
  // count again nor raise a notice the User has dismissed, until a person
  // turns it back on and its history starts over.
  const existing = await readPluginHealthV1(
    state.ctx.storage,
    failure.pluginId,
  );
  if (existing?.quarantinedAt !== undefined) return { fatal: false };
  const { health, quarantined } = await recordPluginFailureV1(
    state.ctx.storage,
    {
      pluginId: failure.pluginId,
      runId: turn.runId,
      phase: failure.phase,
      message: failure.message,
      kind: failure.kind ?? "turn",
      now: now(),
    },
  );
  // One notice per Turn and phase for a hook; one per generation for a mount
  // phase, which would otherwise repeat every Turn until the Plugin is off,
  // and for a theme, which is assembled every hour whether anyone is there. A
  // card draw is charged under the Turn's own runId and the hook phase, so
  // what it was doing is part of the id too: without it a Turn whose hook was
  // skipped and whose card draw also failed would read as one notice, worded
  // for whichever landed first.
  await state.authority.recordNotification({
    notificationId: notificationIdV1(
      "plugin-failed",
      failure.phase === "hook" && failure.kind !== "theme"
        ? turn.runId
        : turn.generationId,
      failure.pluginId,
      failure.phase,
      failure.kind ?? "turn",
    ),
    runId: turn.runId,
    createdAt: now().toISOString(),
    title: failureTitle(failure),
    body: `The plugin "${failure.pluginId}" ${failureWords(failure)}: ${failure.message}. ${failureCost(failure)}${
      quarantined ? "" : ` ${failureCount(health)}`
    }`.slice(0, 2_000),
  });
  if (quarantined) {
    // The Bot's own switch: fenced on the revision read just before it, and
    // a lost race re-read rather than refused.
    await switchPluginForBotV1(
      state.ctx.storage,
      failure.pluginId,
      false,
      now(),
    );
    await state.authority.recordNotification({
      notificationId: notificationIdV1(
        "plugin-quarantined",
        failure.pluginId,
        health.quarantinedAt ?? turn.runId,
      ),
      runId: turn.runId,
      createdAt: now().toISOString(),
      title: "A plugin was turned off",
      body: `The plugin "${failure.pluginId}" ${quarantineRun(health)} and is now off for this Bot. Turn it on again under Plugins to try it once more.`,
      urgency: "critical",
    });
  }
  return { fatal: false };
}

// The Bot Durable Object's side of Plugin health (ADR 0026 step 9): a
// failure becomes a notice in the User's inbox, counts toward the per-Bot
// quarantine, and — for a locked Plugin — fails the Turn instead.
import { notificationIdV1 } from "@frockbot/app/shell/notification-id";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "./catalog.js";
import { switchPluginForBotV1 } from "./authoring.js";
import {
  PLUGIN_QUARANTINE_THRESHOLD_V1,
  readPluginHealthV1,
  recordPluginFailureV1,
  type PluginFailurePhaseV1,
} from "./health.js";

/** One Plugin failing during one Turn, as the mount host reports it. */
export interface PluginFailureNoticeV1 {
  pluginId: string;
  phase: PluginFailurePhaseV1;
  message: string;
}

/** What the mount host does with the failure: carry on without the Plugin, or not. */
export type PluginFailureVerdictV1 = { fatal: false } | { fatal: true };

function locked(pluginId: string): boolean {
  return DEPLOYMENT_PLUGIN_CATALOG_V1.some(
    (plugin) => plugin.pluginId === pluginId && plugin.seed === "locked",
  );
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
      ),
      runId: turn.runId,
      createdAt: now().toISOString(),
      title: "A required plugin failed",
      body: `The plugin "${failure.pluginId}" ${phaseWords(failure.phase)}: ${failure.message}. It is always on for this Bot, so the Turn could not continue without it.`.slice(
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
      now: now(),
    },
  );
  // One notice per Turn and phase for a hook; one per generation for a mount
  // phase, which would otherwise repeat every Turn until the Plugin is off.
  await state.authority.recordNotification({
    notificationId: notificationIdV1(
      "plugin-failed",
      failure.phase === "hook" ? turn.runId : turn.generationId,
      failure.pluginId,
      failure.phase,
    ),
    runId: turn.runId,
    createdAt: now().toISOString(),
    title: "A plugin was skipped",
    body: `The plugin "${failure.pluginId}" ${phaseWords(failure.phase)}: ${failure.message}. This Bot carried on without it.${
      quarantined
        ? ""
        : ` ${health.consecutiveFailures} of ${PLUGIN_QUARANTINE_THRESHOLD_V1} failing Turns in a row before it is turned off.`
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
      body: `The plugin "${failure.pluginId}" failed on ${health.consecutiveFailures} Turns in a row and is now off for this Bot. Turn it on again under Plugins to try it once more.`,
      urgency: "critical",
    });
  }
  return { fatal: false };
}

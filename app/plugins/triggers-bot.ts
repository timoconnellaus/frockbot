// A Plugin trigger, delivered outside any Turn (ADR 0026 step 8).
//
// A Routine whose trigger names a Plugin still enters through the webhook
// door — the same signed key, the same digest, the same replay guard — but
// before the firing is enqueued the delivery is handed to the Plugin, which
// answers with the text the Routine should read or drops it. The worker is
// mounted for the delivery alone, with a synthetic Turn identity that names
// the Routine, and disposed when the answer is in.
import type { PluginWorkerTriggerResultV1 } from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type { RoutinePluginTriggerDeliveryV1 } from "@frockbot/app/routines/store";
import { readBotPluginRosterV1, withPluginWorkerV1 } from "./worker-bot.js";

/** How long one delivery may run inside the Plugin, end to end. */
export const PLUGIN_TRIGGER_DEADLINE_MS = 10_000;

function drop(reason: string): PluginWorkerTriggerResultV1 {
  return { schemaVersion: 1, status: "drop", reason };
}

/**
 * Hand one delivery to the Plugin the Routine names, and answer with what it
 * said. Every refusal is a drop with its reason, never a throw: the door
 * answers the open internet, and a drop is a fact the receipt keeps.
 */
export async function deliverPluginTriggerV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: RoutinePluginTriggerDeliveryV1,
): Promise<PluginWorkerTriggerResultV1> {
  const roster = await readBotPluginRosterV1(state, identity);
  const member = roster.members.find(
    (candidate) => candidate.packageId === input.pluginId,
  );
  if (!member) {
    return drop(
      `plugin "${input.pluginId}" is not in this account's Composition`,
    );
  }
  if (
    !(member.descriptor.triggers ?? []).some(
      (trigger) => trigger.name === input.trigger,
    )
  ) {
    return drop(
      `plugin "${input.pluginId}" declares no trigger "${input.trigger}"`,
    );
  }
  if (!roster.enabled.includes(input.pluginId)) {
    return drop(`plugin "${input.pluginId}" is off for this Bot`);
  }
  const runId = `trigger:${input.routineId}`;
  const outcome = await withPluginWorkerV1(
    state,
    identity,
    roster,
    { runId, deadlineMs: PLUGIN_TRIGGER_DEADLINE_MS },
    (worker) => {
      if (!worker.mounted.includes(input.pluginId)) {
        const failure = worker.failures.find(
          (candidate) => candidate.pluginId === input.pluginId,
        );
        return Promise.resolve(
          drop(
            failure
              ? `plugin "${input.pluginId}" did not mount: ${failure.message}`
              : `plugin "${input.pluginId}" did not mount`,
          ),
        );
      }
      return worker.active.deliverTrigger({
        schemaVersion: 1,
        pluginId: input.pluginId,
        trigger: input.trigger,
        headers: input.headers,
        body: input.body,
        botId: identity.botId,
        routineId: input.routineId,
        deadlineMs: PLUGIN_TRIGGER_DEADLINE_MS,
      });
    },
  );
  return outcome.status === "unavailable" ? drop(outcome.reason) : outcome;
}

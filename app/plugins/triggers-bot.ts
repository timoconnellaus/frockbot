// A Plugin trigger, delivered outside any Turn (ADR 0026 step 8).
//
// A Routine whose trigger names a Plugin still enters through the webhook
// door — the same signed key, the same digest, the same replay guard — but
// before the firing is enqueued the delivery is handed to the Plugin, which
// answers with the text the Routine should read or drops it. The worker is
// mounted for the delivery alone, with a synthetic Turn identity that names
// the Routine, and disposed when the answer is in: nothing about a trigger
// holds a Turn open, and the loader serves the same worker it would serve a
// Turn, so nothing is built twice.
import { PluginWorkerHost } from "@frockbot/frock-compose";
import {
  LoopHookListV1,
  type PluginWorkerTriggerResultV1,
} from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { ToolRegistry } from "@frockbot/core/tools";
import { currentUserCompositionV1 } from "@frockbot/app/composition/bot";
import { isolateMountOptions } from "@frockbot/app/isolates/bot";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type { RoutinePluginTriggerDeliveryV1 } from "@frockbot/app/routines/store";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  enabledSeededPluginIdsV1,
} from "./catalog.js";
import { readPluginEnablementV1 } from "./enablement.js";

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
  const current = await currentUserCompositionV1(state, identity);
  const member = current.members.find(
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
  const enablement = await readPluginEnablementV1(state.ctx.storage);
  const enabled = enabledSeededPluginIdsV1(
    current.members,
    enablement,
    DEPLOYMENT_PLUGIN_CATALOG_V1,
  );
  if (!enabled.includes(input.pluginId)) {
    return drop(`plugin "${input.pluginId}" is off for this Bot`);
  }
  // The identity the delivery runs under: not a Turn, but shaped like one so
  // every loopback call still names what it is for.
  const runId = `trigger:${input.routineId}`;
  const sessionId = `${identity.userId}:${identity.botId}`;
  const isolate = await isolateMountOptions(state, identity, {
    runId,
    sessionId,
    generationId: current.generationId,
    members: current.members,
    enabled,
  });
  if (!isolate) {
    return drop("this deployment cannot mount a Plugin worker");
  }
  const hooks = new LoopHookListV1();
  const host = new PluginWorkerHost({
    ...isolate,
    // Throwaway registries: a delivery registers nothing anyone calls.
    tools: new ToolRegistry(hooks, new SystemPromptRegistry(hooks)),
    hooks,
    botId: identity.botId,
    sessionId,
    turnId: runId,
    generationId: current.generationId,
    turnType: "automation",
    recordHookFailure: () => Promise.resolve(),
    deadlineMs: PLUGIN_TRIGGER_DEADLINE_MS,
  });
  const prepared = await host.mount(
    current.members.filter((candidate) =>
      enabled.includes(candidate.packageId),
    ),
  );
  if (!prepared.mounted.includes(input.pluginId)) {
    const failure = prepared.failures.find(
      (candidate) => candidate.pluginId === input.pluginId,
    );
    return drop(
      failure
        ? `plugin "${input.pluginId}" did not mount: ${failure.message}`
        : `plugin "${input.pluginId}" did not mount`,
    );
  }
  const active = await prepared.commit();
  try {
    return await active.deliverTrigger({
      schemaVersion: 1,
      pluginId: input.pluginId,
      trigger: input.trigger,
      headers: input.headers,
      body: input.body,
      botId: identity.botId,
      routineId: input.routineId,
      deadlineMs: PLUGIN_TRIGGER_DEADLINE_MS,
    });
  } finally {
    await active.dispose();
  }
}

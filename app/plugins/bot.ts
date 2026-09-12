// The Bot's Plugins page, read and switched (ADR 0026).
//
// One list for one Bot: the first-party features a User may switch, the
// Plugins the deployment seeded, and the Plugins this User's Bots wrote, each
// with whether this Bot runs it now. The User's installation is the
// precondition; the Bot's enable map is the switch.
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { currentUserCompositionV1 } from "@frockbot/app/composition/bot";
import { userConfigurationV1 } from "@frockbot/app/settings/bot";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  FIRST_PARTY_TOGGLEABLE_PLUGINS_V1,
  firstPartyFeatureOnForBotV1,
  pluginRunsForBotV1,
  pluginSwitchableV1,
  type SeededPluginV1,
} from "./catalog.js";
import {
  clearPluginHealthV1,
  pluginQuarantineCopyV1,
  readPluginHealthMapV1,
} from "./health.js";
import {
  PluginEnablementConflictError,
  readPluginEnablementV1,
  setPluginEnabledV1,
} from "./enablement.js";
import type {
  BotPluginRowV1,
  BotPluginsFrameV1,
  SetBotPluginEnabledCommandV1,
} from "./page.js";

export type SetBotPluginEnabledReceiptV1 =
  | { status: "applied"; revision: number }
  | { status: "conflict"; currentRevision: number }
  | { status: "rejected"; failure: string };

/** What this Bot's page shows, from what its User installed and its own map. */
export async function readBotPluginsFrameV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  catalog: readonly SeededPluginV1[] = DEPLOYMENT_PLUGIN_CATALOG_V1,
): Promise<BotPluginsFrameV1> {
  const enablement = await readPluginEnablementV1(state.ctx.storage);
  const user = await userConfigurationV1(state, identity).readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  const rows: BotPluginRowV1[] = [];
  for (const feature of FIRST_PARTY_TOGGLEABLE_PLUGINS_V1) {
    const installation = user.packages.find(
      (candidate) => candidate.packageId === feature.packageId,
    );
    const installed = installation?.state === "installed";
    rows.push({
      pluginId: feature.packageId,
      displayName: feature.displayName,
      description: feature.description,
      kind: "first-party",
      on:
        installed && firstPartyFeatureOnForBotV1(feature.packageId, enablement),
      switchable: true,
      ...(installed
        ? {}
        : {
            unavailable:
              "Turned off for the whole account. Turn it on in Account features first.",
          }),
    });
  }
  const composition = await currentUserCompositionV1(state, identity);
  const health = await readPluginHealthMapV1(state.ctx.storage);
  for (const member of composition.members) {
    const seeded = catalog.find(
      (plugin) => plugin.pluginId === member.packageId,
    );
    const quarantine = health.get(member.packageId);
    rows.push({
      ...(quarantine?.quarantinedAt !== undefined
        ? { quarantined: pluginQuarantineCopyV1(quarantine) }
        : {}),
      pluginId: member.packageId,
      displayName: seeded?.displayName ?? member.descriptor.displayName,
      description:
        seeded?.description ??
        `Version ${member.descriptor.version}, written by your Bot.`,
      kind: seeded ? "seeded" : "authored",
      ...(seeded ? { seed: seeded.seed } : {}),
      on: pluginRunsForBotV1(seeded?.seed, member.packageId, enablement),
      switchable: pluginSwitchableV1(seeded?.seed),
      ...(member.descriptor.network
        ? { network: member.descriptor.network }
        : {}),
    });
  }
  return {
    schemaVersion: 1,
    botId: identity.botId,
    revision: enablement.revision,
    plugins: rows,
  };
}

/**
 * Flips one switch for this Bot. A locked Plugin, a first-party feature the
 * account has not installed, or a Plugin the page does not list is refused
 * with the reason; a stale revision is a conflict the page re-reads from.
 */
export async function setBotPluginEnabledV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: SetBotPluginEnabledCommandV1,
  catalog: readonly SeededPluginV1[] = DEPLOYMENT_PLUGIN_CATALOG_V1,
): Promise<SetBotPluginEnabledReceiptV1> {
  const frame = await readBotPluginsFrameV1(state, identity, catalog);
  const row = frame.plugins.find(
    (candidate) => candidate.pluginId === command.pluginId,
  );
  if (!row) {
    return {
      status: "rejected",
      failure: `"${command.pluginId}" is not a plugin this Bot could run`,
    };
  }
  if (!row.switchable) {
    return { status: "rejected", failure: `"${row.displayName}" is always on` };
  }
  if (row.unavailable && command.enabled) {
    return { status: "rejected", failure: row.unavailable };
  }
  try {
    const next = await setPluginEnabledV1(state.ctx.storage, {
      pluginId: command.pluginId,
      enabled: command.enabled,
      expectedRevision: command.expectedRevision,
    });
    // Switching a Plugin on is a person's answer to a quarantine: its
    // history starts over.
    if (command.enabled) {
      await clearPluginHealthV1(state.ctx.storage, command.pluginId);
    }
    return { status: "applied", revision: next.revision };
  } catch (error) {
    if (error instanceof PluginEnablementConflictError) {
      return { status: "conflict", currentRevision: error.currentRevision };
    }
    throw error;
  }
}

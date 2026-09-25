// The Bot's Plugins page, read and switched (ADR 0026).
//
// One list for one Bot: the first-party features, the Plugins the deployment
// seeded, and the Plugins this User's Bots wrote, each with whether this Bot
// runs it now. The Bot's enable map is the only switch: first-party features
// are platform-owned, so the account always holds them.
//
// A row is something this Bot could be switched to run. A locked Plugin runs
// for every Bot and a Plugin that only serves a model runs when that model is
// chosen, so neither is listed: there is nothing here a person could change.
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { currentUserCompositionV1 } from "@frockbot/app/composition/bot";
import { oweThemeAssembleV1 } from "@frockbot/app/theme/owed";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  FIRST_PARTY_TOGGLEABLE_PLUGINS_V1,
  firstPartyFeatureOnForBotV1,
  pluginRunsForBotV1,
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
import {
  isPureModelProviderPluginV1,
  pluginServedModelProviderIdsForMemberV1,
  type BotPluginRowV1,
  type BotPluginsFrameV1,
  type SetBotPluginEnabledCommandV1,
} from "./page.js";
import { renderBotPluginSectionsV1 } from "./views-bot.js";
import { omittedPanelNoticesV1 } from "./panels-bot.js";
import { readBotPluginRosterV1 } from "./worker-bot.js";

export type SetBotPluginEnabledReceiptV1 =
  | { status: "applied"; revision: number }
  | { status: "conflict"; currentRevision: number }
  | { status: "rejected"; failure: string };

/**
 * What this Bot's page shows, from what its User installed and its own map.
 * With `sections`, every Plugin that is on and declares a settings section
 * is asked to draw it (ADR 0026 step 9); a switch never needs that.
 */
export async function readBotPluginsFrameV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  catalog: readonly SeededPluginV1[] = DEPLOYMENT_PLUGIN_CATALOG_V1,
  options: { sections?: boolean } = {},
): Promise<BotPluginsFrameV1> {
  const enablement = await readPluginEnablementV1(state.ctx.storage);
  const rows: BotPluginRowV1[] = FIRST_PARTY_TOGGLEABLE_PLUGINS_V1.map(
    (feature) => ({
      pluginId: feature.packageId,
      displayName: feature.displayName,
      description: feature.description,
      kind: "first-party",
      on: firstPartyFeatureOnForBotV1(feature.packageId, enablement),
    }),
  );
  const composition = await currentUserCompositionV1(state, identity);
  const health = await readPluginHealthMapV1(state.ctx.storage);
  for (const member of composition.members) {
    const seeded = catalog.find(
      (plugin) => plugin.pluginId === member.packageId,
    );
    const quarantine = health.get(member.packageId);
    // What this deployment actually serves through *this* Plugin, not what
    // its descriptor claims: the member has to be the catalog's own Plugin at
    // the catalog's own artifact, or nothing here carries a credential.
    const servedProviders = pluginServedModelProviderIdsForMemberV1({
      packageId: member.packageId,
      artifact: member.artifact,
      modelProviders: (member.descriptor.modelProviders ?? []).map(
        (provider) => provider.id,
      ),
    });
    if (
      seeded?.seed === "locked" ||
      isPureModelProviderPluginV1({
        modelProviders: servedProviders,
        tools: member.descriptor.tools,
        hooks: member.descriptor.hooks,
      })
    ) {
      continue;
    }
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
      ...(member.descriptor.network
        ? { network: member.descriptor.network }
        : {}),
      ...(member.descriptor.device ? { device: member.descriptor.device } : {}),
      ...(member.descriptor.grants.length > 0
        ? { grants: member.descriptor.grants }
        : {}),
      ...(member.descriptor.triggers?.length
        ? { triggers: member.descriptor.triggers }
        : {}),
      ...(servedProviders.length > 0
        ? { modelProviders: servedProviders }
        : {}),
    });
  }
  if (options.sections) {
    const roster = await readBotPluginRosterV1(state, identity);
    const sections = await renderBotPluginSectionsV1(state, identity, roster);
    const omitted = omittedPanelNoticesV1(roster);
    for (const row of rows) {
      const drawn = sections.get(row.pluginId);
      if (drawn && drawn.length > 0) row.sections = drawn;
      const notice = omitted.get(row.pluginId);
      if (notice) row.omitted = notice;
    }
  }
  return {
    schemaVersion: 1,
    botId: identity.botId,
    revision: enablement.revision,
    plugins: rows,
  };
}

/**
 * Flips one switch for this Bot. A Plugin the page does not list is refused
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
      failure: `"${command.pluginId}" is not a plugin this Bot can switch`,
    };
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
    await oweThemeAssembleV1(state.ctx.storage, new Date());
    return { status: "applied", revision: next.revision };
  } catch (error) {
    if (error instanceof PluginEnablementConflictError) {
      return { status: "conflict", currentRevision: error.currentRevision };
    }
    throw error;
  }
}

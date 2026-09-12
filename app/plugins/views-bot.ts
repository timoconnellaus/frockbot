// A Bot's Plugin sections, rendered and pressed (ADR 0026 step 9).
//
// The Plugins page asks every Plugin this Bot has on, and that declares a
// `settings.sections` view, for its section; one worker mount serves them
// all. A control on a section runs one of that Plugin's declared tools under
// its own synthetic identity, outside any Turn, and the page is read again.
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type { PluginToolCommandV1 } from "./page.js";
import { pluginSectionV1, type BotPluginSectionV1 } from "./views.js";
import {
  readBotPluginRosterV1,
  withPluginWorkerV1,
  type BotPluginRosterV1,
} from "./worker-bot.js";

/** How long one section render, or one control's tool call, may run. */
export const PLUGIN_VIEW_DEADLINE_MS = 5_000;
export const PLUGIN_TOOL_ACTION_DEADLINE_MS = 10_000;

export type BotPluginToolReceiptV1 =
  | { status: "ran"; content: string; isError: boolean }
  | { status: "rejected"; failure: string };

/** The settings-section surfaces one member declares, in declaration order. */
export function pluginSectionSurfacesV1(
  member: BotPluginRosterV1["members"][number],
): string[] {
  return (member.descriptor.views ?? [])
    .filter((view) => view.slot === "settings.sections")
    .map((view) => view.surfaceId);
}

/**
 * Every section this Bot's page shows, keyed by Plugin. A Plugin with no
 * section declared has no entry; one that could not render has its failure.
 */
export async function renderBotPluginSectionsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  roster: BotPluginRosterV1,
): Promise<Map<string, BotPluginSectionV1[]>> {
  const sections = new Map<string, BotPluginSectionV1[]>();
  const wanted = roster.members
    .filter((member) => roster.enabled.includes(member.packageId))
    .map((member) => ({ member, surfaces: pluginSectionSurfacesV1(member) }))
    .filter((entry) => entry.surfaces.length > 0);
  if (wanted.length === 0) return sections;
  const runId = `views:${identity.botId}`;
  const outcome = await withPluginWorkerV1(
    state,
    identity,
    roster,
    { runId, deadlineMs: PLUGIN_VIEW_DEADLINE_MS },
    async (worker) => {
      // Every surface is asked at once, so the page waits one deadline in
      // all rather than one per Plugin.
      await Promise.all(
        wanted.map(async ({ member, surfaces }) => {
          const tools = member.descriptor.tools.map((tool) => tool.name);
          const failure = worker.failures.find(
            (candidate) => candidate.pluginId === member.packageId,
          );
          const rendered: BotPluginSectionV1[] = await Promise.all(
            surfaces.map(async (surfaceId) => {
              const source = { pluginId: member.packageId, surfaceId, tools };
              if (failure) {
                return pluginSectionV1(source, {
                  schemaVersion: 1,
                  status: "drop",
                  reason: failure.message,
                });
              }
              return pluginSectionV1(
                source,
                await worker.active.renderView({
                  schemaVersion: 1,
                  pluginId: member.packageId,
                  surfaceId,
                  botId: identity.botId,
                  sessionId: `${identity.userId}:${identity.botId}`,
                  runId,
                  turnId: runId,
                  generationId: roster.generationId,
                  deadlineMs: PLUGIN_VIEW_DEADLINE_MS,
                }),
              );
            }),
          );
          sections.set(member.packageId, rendered);
        }),
      );
      return undefined;
    },
  );
  if (outcome && outcome.status === "unavailable") {
    for (const { member, surfaces } of wanted) {
      sections.set(
        member.packageId,
        surfaces.map((surfaceId) =>
          pluginSectionV1(
            { pluginId: member.packageId, surfaceId, tools: [] },
            { schemaVersion: 1, status: "drop", reason: outcome.reason },
          ),
        ),
      );
    }
  }
  return sections;
}

/**
 * Runs the tool a section's control names. Only a Plugin this Bot has on,
 * that declares a section, and that declares the tool, is reached; every
 * other answer is a rejection with its reason, never a throw.
 */
export async function executeBotPluginToolV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: PluginToolCommandV1,
): Promise<BotPluginToolReceiptV1> {
  const roster = await readBotPluginRosterV1(state, identity);
  const member = roster.members.find(
    (candidate) => candidate.packageId === command.pluginId,
  );
  if (!member) {
    return {
      status: "rejected",
      failure: `"${command.pluginId}" is not a plugin this Bot could run`,
    };
  }
  if (!roster.enabled.includes(command.pluginId)) {
    return {
      status: "rejected",
      failure: `"${member.descriptor.displayName}" is off for this Bot`,
    };
  }
  if (pluginSectionSurfacesV1(member).length === 0) {
    return {
      status: "rejected",
      failure: `"${member.descriptor.displayName}" has no controls`,
    };
  }
  if (!member.descriptor.tools.some((tool) => tool.name === command.tool)) {
    return {
      status: "rejected",
      failure: `"${member.descriptor.displayName}" has no "${command.tool}" control`,
    };
  }
  let input: unknown;
  try {
    input = command.arguments === "" ? {} : JSON.parse(command.arguments);
  } catch {
    return { status: "rejected", failure: "This control's input is not JSON" };
  }
  const runId = `action:${command.commandId}`;
  const outcome = await withPluginWorkerV1(
    state,
    identity,
    roster,
    { runId, deadlineMs: PLUGIN_TOOL_ACTION_DEADLINE_MS },
    async (worker) => {
      const result = await worker.active.executeTool({
        schemaVersion: 1,
        pluginId: command.pluginId,
        tool: command.tool,
        input,
        botId: identity.botId,
        sessionId: `${identity.userId}:${identity.botId}`,
        runId,
        turnId: runId,
        generationId: roster.generationId,
        deadlineMs: PLUGIN_TOOL_ACTION_DEADLINE_MS,
      });
      return {
        status: "ran" as const,
        content: result.content,
        isError: result.isError,
      };
    },
  );
  if (outcome.status === "unavailable") {
    return { status: "rejected", failure: outcome.reason };
  }
  return outcome;
}

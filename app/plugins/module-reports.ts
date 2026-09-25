// What a Plugin's device modules told the cloud from each desktop (ADR 0037).
//
// A module runs on the person's Mac, so its crashes and its logs would
// otherwise go nowhere a Bot could see. The desktop's module host posts them
// to the User Durable Object, which keeps them here, and the Bot that wrote
// the Plugin reads them with `plugin_module_reports`. Like page reports they
// are a debugging aid: bounded per Plugin, newest kept, stamped by the cloud.

import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import type {
  MachineModuleReportV1,
  MachineModuleStateV1,
} from "@frockbot/core/machine-protocol";

/** How many entries a Plugin keeps, newest first. */
export const MAX_PLUGIN_MODULE_REPORTS_V1 = 50;

const REPORTS_KEY_PREFIX_V1 = "plugin:module-reports:v1:";

interface ReportOriginV1 {
  at: string;
  machineId: string;
  machineLabel: string;
  moduleId: string;
}

export type PluginModuleReportEntryV1 = ReportOriginV1 &
  (
    | { kind: "state"; state: MachineModuleStateV1; detail?: string }
    | { kind: "log"; level: "log" | "error"; text: string }
  );

/** The newest state one module reported from one machine. */
export type PluginModuleStateV1 = ReportOriginV1 & {
  state: MachineModuleStateV1;
  detail?: string;
};

export interface PluginModuleReportsV1 {
  /** Newest first, at most `MAX_PLUGIN_MODULE_REPORTS_V1`. */
  entries: PluginModuleReportEntryV1[];
  /** One per machine and module, whatever has scrolled out of `entries`. */
  states: PluginModuleStateV1[];
}

interface ReportStorageV1 {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

function reportsKey(pluginId: string): string {
  return `${REPORTS_KEY_PREFIX_V1}${pluginId}`;
}

/** This Plugin's stored reports. */
export async function readPluginModuleReportsV1(
  storage: ReportStorageV1,
  pluginId: string,
): Promise<PluginModuleReportsV1> {
  const stored = (await storage.get(reportsKey(pluginId))) as
    PluginModuleReportsV1 | undefined;
  return stored ?? { entries: [], states: [] };
}

/**
 * Keeps one machine's posted reports, each under its Plugin. A report for a
 * module the active generation does not carry is dropped: the Plugin was
 * removed or replaced, and nothing it said still describes what runs.
 */
export async function recordPluginModuleReportsV1(
  storage: ReportStorageV1,
  input: {
    generation: CompositionGenerationV1;
    machineId: string;
    machineLabel: string;
    reports: readonly MachineModuleReportV1[];
    now: Date;
  },
): Promise<{ recorded: number; dropped: number }> {
  const at = input.now.toISOString();
  const byPlugin = new Map<string, PluginModuleReportEntryV1[]>();
  let dropped = 0;
  for (const report of input.reports) {
    const member = input.generation.members.find(
      (candidate) => candidate.packageId === report.pluginId,
    );
    if (!member?.modules?.some((module) => module.id === report.moduleId)) {
      dropped += 1;
      continue;
    }
    const origin = {
      at,
      machineId: input.machineId,
      machineLabel: input.machineLabel,
      moduleId: report.moduleId,
    };
    const entry: PluginModuleReportEntryV1 =
      report.kind === "state"
        ? {
            ...origin,
            kind: "state",
            state: report.state,
            ...(report.detail === undefined ? {} : { detail: report.detail }),
          }
        : { ...origin, kind: "log", level: report.level, text: report.text };
    byPlugin.set(report.pluginId, [
      ...(byPlugin.get(report.pluginId) ?? []),
      entry,
    ]);
  }
  for (const [pluginId, posted] of byPlugin) {
    const kept = await readPluginModuleReportsV1(storage, pluginId);
    // A post is in the order things happened, so its last entry is newest.
    const newest = [...posted].reverse();
    let states = kept.states;
    for (const entry of posted) {
      if (entry.kind !== "state") continue;
      const { kind: _kind, ...state } = entry;
      states = [
        ...states.filter(
          (held) =>
            held.machineId !== entry.machineId ||
            held.moduleId !== entry.moduleId,
        ),
        state,
      ];
    }
    await storage.put(reportsKey(pluginId), {
      entries: [...newest, ...kept.entries].slice(
        0,
        MAX_PLUGIN_MODULE_REPORTS_V1,
      ),
      states,
    } satisfies PluginModuleReportsV1);
  }
  return { recorded: input.reports.length - dropped, dropped };
}

/** The reports as the Bot reads them. */
export function pluginModuleReportsTextV1(
  pluginId: string,
  reports: PluginModuleReportsV1,
): string {
  if (reports.states.length === 0 && reports.entries.length === 0) {
    return `${pluginId}'s device modules have reported nothing. A desktop reports a module once the FrockBot app there is open and has started it, which happens after the generation carrying it is active.`;
  }
  const where = (entry: ReportOriginV1) =>
    `${entry.moduleId} on ${entry.machineLabel}`;
  const logs = reports.entries.filter((entry) => entry.kind === "log");
  return [
    `${pluginId}'s device modules, latest state on each desktop:`,
    ...(reports.states.length === 0
      ? ["- none reported yet"]
      : [...reports.states]
          .sort((a, b) => b.at.localeCompare(a.at))
          .map(
            (state) =>
              `- ${where(state)}: ${state.state} since ${state.at}${
                state.detail === undefined ? "" : `. ${state.detail}`
              }`,
          )),
    ...(logs.length === 0
      ? ["No log lines. A module's console output appears here."]
      : [
          `${logs.length} log line(s), newest first:`,
          ...logs.map(
            (entry) =>
              `${entry.at} ${entry.level} (${where(entry)}): ${entry.text}`,
          ),
        ]),
  ].join("\n");
}

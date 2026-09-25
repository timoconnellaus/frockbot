// What a Plugin's page told its Bot (ADR 0036, amended 2026-09-25).
//
// A page runs on the person's device, so its failures used to go nowhere: the
// tuner's lost greeting and its too-quiet threshold were both invisible to the
// Bot that wrote it. The bridge helper forwards the page's errors and the
// readings it chooses to report, the client sends each here, and the Bot reads
// them back with `plugin_page_reports`. They are a debugging aid, not a record
// anyone relies on: bounded per Plugin, newest kept, stamped by the Bot.

import {
  PLUGIN_PAGE_REPORT_LEVELS_V1,
  PLUGIN_PAGE_REPORT_TEXT_MAX_V1,
} from "@frockbot/core/contracts";
import type { BotPluginRosterV1 } from "./worker-bot.js";

export type PluginPageReportLevelV1 =
  (typeof PLUGIN_PAGE_REPORT_LEVELS_V1)[number];

/** How many reports a Plugin keeps, newest first. */
export const MAX_PLUGIN_PAGE_REPORTS_V1 = 50;

const REPORTS_KEY_PREFIX_V1 = "plugin:page-reports:v1:";

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const DEVICE = /^[a-z][a-z0-9-]{0,31}$/;

export interface PluginPageReportCommandV1 {
  pluginId: string;
  surfaceId: string;
  device: string;
  level: PluginPageReportLevelV1;
  text: string;
}

export interface PluginPageReportV1 {
  at: string;
  surfaceId: string;
  device: string;
  level: PluginPageReportLevelV1;
  text: string;
  /** The Plugin's version when its page said this. */
  version: string;
}

export class PluginPageReportDecodeError extends Error {}

function matched(
  value: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  const field = value[key];
  if (typeof field !== "string" || !pattern.test(field)) {
    throw new PluginPageReportDecodeError(`page report.${key} is invalid`);
  }
  return field;
}

/** The client's report, decoded exactly. */
export function decodePluginPageReportCommandV1(
  input: unknown,
): PluginPageReportCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PluginPageReportDecodeError("page report must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
    "device,level,pluginId,schemaVersion,surfaceId,text"
  ) {
    throw new PluginPageReportDecodeError("page report has invalid fields");
  }
  if (value.schemaVersion !== 1) {
    throw new PluginPageReportDecodeError(
      "page report.schemaVersion must be 1",
    );
  }
  const level = PLUGIN_PAGE_REPORT_LEVELS_V1.find(
    (candidate) => candidate === value.level,
  );
  if (!level) {
    throw new PluginPageReportDecodeError("page report.level is invalid");
  }
  const text = value.text;
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > PLUGIN_PAGE_REPORT_TEXT_MAX_V1
  ) {
    throw new PluginPageReportDecodeError("page report.text is invalid");
  }
  return {
    pluginId: matched(value, "pluginId", PLUGIN_ID),
    surfaceId: matched(value, "surfaceId", SURFACE_ID),
    device: matched(value, "device", DEVICE),
    level,
    text,
  };
}

interface ReportStorageV1 {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

function reportsKey(pluginId: string): string {
  return `${REPORTS_KEY_PREFIX_V1}${pluginId}`;
}

/** This Plugin's stored reports, newest first. */
export async function readPluginPageReportsV1(
  storage: ReportStorageV1,
  pluginId: string,
): Promise<PluginPageReportV1[]> {
  const stored = await storage.get(reportsKey(pluginId));
  return Array.isArray(stored) ? (stored as PluginPageReportV1[]) : [];
}

/**
 * Keeps one report, when this Bot's Composition holds the Plugin and the
 * surface is one of its pages. Whether it is switched on is not asked: the
 * page said it.
 */
export async function recordPluginPageReportV1(
  storage: ReportStorageV1,
  roster: BotPluginRosterV1,
  report: PluginPageReportCommandV1,
  now: Date,
): Promise<{ status: "recorded" } | { status: "refused"; reason: string }> {
  const member = roster.members.find(
    (candidate) => candidate.packageId === report.pluginId,
  );
  const page = member?.descriptor.views?.some(
    (view) =>
      view.slot === "conversation.panel" &&
      view.surfaceId === report.surfaceId &&
      view.page !== undefined,
  );
  if (!member || !page) {
    return {
      status: "refused",
      reason: `"${report.pluginId}" has no page "${report.surfaceId}".`,
    };
  }
  const kept = await readPluginPageReportsV1(storage, report.pluginId);
  const entry: PluginPageReportV1 = {
    at: now.toISOString(),
    surfaceId: report.surfaceId,
    device: report.device,
    level: report.level,
    text: report.text,
    version: member.version,
  };
  await storage.put(
    reportsKey(report.pluginId),
    [entry, ...kept].slice(0, MAX_PLUGIN_PAGE_REPORTS_V1),
  );
  return { status: "recorded" };
}

/** The reports as the Bot reads them, marking any from an older version. */
export function pluginPageReportsTextV1(
  pluginId: string,
  reports: readonly PluginPageReportV1[],
  currentVersion: string | undefined,
): string {
  if (reports.length === 0) {
    return `${pluginId}'s pages have reported nothing. Errors a page throws and what it passes to frockbot.log(text) appear here once someone has opened it.`;
  }
  return [
    `${reports.length} report(s) from ${pluginId}'s pages, newest first:`,
    ...reports.map((report) => {
      const older =
        currentVersion !== undefined && report.version !== currentVersion
          ? `, version ${report.version}, before the current one`
          : "";
      return `${report.at} ${report.level} (${report.surfaceId} on ${report.device}${older}): ${report.text}`;
    }),
  ].join("\n");
}

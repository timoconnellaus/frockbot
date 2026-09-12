// The Plugins page for one Bot: what its User installed, what the deployment
// seeded, and the first-party features a User may switch — one list, one
// switch per row, per Bot (ADR 0026).
//
// The frame is the Bot's reading; the document is what the host renders. An
// action keeps the id the card renderer already draws as a switch, and its
// input names the Plugin and the revision the page read, so two people
// flipping switches from stale pages do not silently undo each other.
import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import type { PluginNetworkV1 } from "@frockbot/core/contracts";
import type { PluginSeedStateV1 } from "./catalog.js";
import {
  MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1,
  PLUGIN_TOOL_ACTION_ID_V1,
  type BotPluginSectionV1,
} from "./views.js";

export type BotPluginKindV1 = "first-party" | "seeded" | "authored";

export interface BotPluginRowV1 {
  pluginId: string;
  displayName: string;
  description: string;
  kind: BotPluginKindV1;
  /** Present for a seeded Plugin. */
  seed?: PluginSeedStateV1;
  /** Whether this Bot runs it now. */
  on: boolean;
  /** Whether the User may flip it; a locked Plugin is shown without a switch. */
  switchable: boolean;
  /** The network the descriptor declares, shown on the card before it is on. */
  network?: PluginNetworkV1;
  /** A first-party feature the account has not installed cannot be switched on. */
  unavailable?: string;
  /** Off after failing Turns in a row; the switch turns it on again (ADR 0026). */
  quarantined?: string;
  /** The sections the Plugin drew on its card, when it is on and declares any. */
  sections?: BotPluginSectionV1[];
}

export interface BotPluginsFrameV1 {
  schemaVersion: 1;
  botId: string;
  /** The enable map's revision, fenced on every switch. */
  revision: number;
  plugins: BotPluginRowV1[];
}

export interface SetBotPluginEnabledCommandV1 {
  schemaVersion: 1;
  kind: "set-plugin-enabled";
  commandId: string;
  pluginId: string;
  enabled: boolean;
  expectedRevision: number;
}

/** A control on a Plugin's section, pressed: runs the tool it names. */
export interface PluginToolCommandV1 {
  schemaVersion: 1;
  kind: "plugin-tool";
  commandId: string;
  pluginId: string;
  tool: string;
  /** The tool's input as JSON text; empty means no input. */
  arguments: string;
}

export type BotPluginsCommandV1 =
  SetBotPluginEnabledCommandV1 | PluginToolCommandV1;

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const COMMAND_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const UTF8 = new TextEncoder();

export function decodePluginToolCommandV1(input: unknown): PluginToolCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("plugin control command must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    [
      "arguments",
      "commandId",
      "kind",
      "pluginId",
      "schemaVersion",
      "tool",
    ].join(",")
  ) {
    throw new Error("plugin control command has invalid fields");
  }
  if (value.schemaVersion !== 1 || value.kind !== "plugin-tool") {
    throw new Error("plugin control command is not a plugin control");
  }
  if (
    typeof value.commandId !== "string" ||
    !COMMAND_ID.test(value.commandId)
  ) {
    throw new Error("plugin control command commandId is invalid");
  }
  if (typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) {
    throw new Error("plugin control command pluginId is invalid");
  }
  if (typeof value.tool !== "string" || !TOOL_NAME.test(value.tool)) {
    throw new Error("plugin control command tool is invalid");
  }
  if (
    typeof value.arguments !== "string" ||
    UTF8.encode(value.arguments).byteLength > MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1
  ) {
    throw new Error("plugin control command arguments are invalid");
  }
  return {
    schemaVersion: 1,
    kind: "plugin-tool",
    commandId: value.commandId,
    pluginId: value.pluginId,
    tool: value.tool,
    arguments: value.arguments,
  };
}

/** Any command the Bot's Plugins page posts, told apart by its `kind`. */
export function decodeBotPluginsCommandV1(input: unknown): BotPluginsCommandV1 {
  const kind =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).kind
      : undefined;
  if (kind === "plugin-tool") return decodePluginToolCommandV1(input);
  return decodeSetBotPluginEnabledCommandV1(input);
}

export function decodeSetBotPluginEnabledCommandV1(
  input: unknown,
): SetBotPluginEnabledCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("plugin switch command must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    [
      "commandId",
      "enabled",
      "expectedRevision",
      "kind",
      "pluginId",
      "schemaVersion",
    ].join(",")
  ) {
    throw new Error("plugin switch command has invalid fields");
  }
  if (value.schemaVersion !== 1 || value.kind !== "set-plugin-enabled") {
    throw new Error("plugin switch command is not a plugin switch");
  }
  if (
    typeof value.commandId !== "string" ||
    value.commandId.length === 0 ||
    value.commandId.length > 128
  ) {
    throw new Error("plugin switch command needs a command id");
  }
  if (typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) {
    throw new Error("plugin switch command names an invalid plugin");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("plugin switch command enabled must be a boolean");
  }
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  ) {
    throw new Error("plugin switch command revision is invalid");
  }
  return {
    schemaVersion: 1,
    kind: "set-plugin-enabled",
    commandId: value.commandId,
    pluginId: value.pluginId,
    enabled: value.enabled,
    expectedRevision: value.expectedRevision as number,
  };
}

/** The renderer's node budget, checked before it builds a widget. */
const NODE_LIMIT = 512;
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };

/** What the card says about the reach a Plugin asked for. */
export function pluginNetworkCopyV1(
  network: PluginNetworkV1 | undefined,
): string {
  if (!network) return "";
  if ("open" in network) {
    return "Needs open network access. Turning this on gives every plugin on this account open network access.";
  }
  return `Reaches ${network.hosts.join(", ")}.`;
}

function kindLabel(row: BotPluginRowV1): string {
  switch (row.kind) {
    case "first-party":
      return "Built in";
    case "seeded":
      return row.seed === "locked" ? "Always on" : "Included";
    case "authored":
      return "Made by your Bot";
  }
}

function pluginNode(row: BotPluginRowV1, revision: number): ViewNode {
  const lines: ViewNode[] = [
    { type: "text", text: row.description.slice(0, 4000), style: "body" },
  ];
  const reach = pluginNetworkCopyV1(row.network);
  if (reach) lines.push({ type: "text", text: reach, style: "status" });
  if (row.unavailable) {
    lines.push({ type: "text", text: row.unavailable, style: "status" });
  }
  if (row.quarantined) {
    lines.push({ type: "text", text: row.quarantined, style: "status" });
  }
  for (const section of row.sections ?? []) {
    if (section.root) {
      lines.push({
        type: "group",
        orientation: "column",
        children: [section.root],
      });
    } else if (section.failure) {
      lines.push({ type: "text", text: section.failure, style: "status" });
    }
  }
  const controls: ViewNode[] = [];
  if (row.switchable && !row.unavailable) {
    controls.push({
      type: "action",
      // The id the card renderer draws as a switch; the input says which
      // Plugin and which revision the page read.
      actionId: "set-package-enabled",
      label: row.on ? "Turn off" : "Turn on",
      input: {
        kind: "set-plugin-enabled",
        pluginId: row.pluginId,
        enabled: !row.on,
        expectedRevision: revision,
      },
    });
  }
  return {
    type: "group",
    orientation: "column",
    title: `${row.displayName.slice(0, 150)} · ${kindLabel(row)}`,
    children: [
      ...lines,
      { type: "group", orientation: "row", children: controls },
    ],
  };
}

/** A Bot's Plugins frame as a `ViewDocument`. */
export function botPluginsDocumentV1(frame: BotPluginsFrameV1): ViewDocument {
  const children: ViewNode[] = [
    {
      type: "text",
      text: "What this Bot can do. Each card explains what the plugin does and what it reaches; a switch is for this Bot only.",
    },
  ];
  let nodes = 2;
  let complete = true;
  for (const row of frame.plugins) {
    const cost =
      6 +
      (row.network ? 1 : 0) +
      (row.unavailable ? 1 : 0) +
      (row.quarantined ? 1 : 0) +
      (row.sections ?? []).reduce(
        (sum, section) => sum + (section.root ? 1 + section.nodes : 1),
        0,
      );
    if (nodes + cost > NODE_LIMIT) {
      complete = false;
      break;
    }
    nodes += cost;
    children.push(pluginNode(row, frame.revision));
  }
  if (!complete) {
    children.push({
      type: "text",
      text: "The rest of this Bot's plugins need a newer app. Everything above is still yours to change.",
      style: "status",
    });
  }
  if (frame.plugins.length === 0) {
    children.push({
      type: "text",
      text: "Nothing to switch yet. Plugins your Bot makes, and the ones this deployment includes, appear here.",
    });
  }
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "bot-plugins",
    revision: frame.revision,
    root: { type: "group", orientation: "column", children },
    actions: [
      {
        id: "set-package-enabled",
        schema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["set-plugin-enabled"] },
            pluginId: IDENTIFIER,
            enabled: { type: "boolean" },
            expectedRevision: {
              type: "number",
              minimum: 0,
              maximum: 1_000_000,
            },
          },
          required: ["kind", "pluginId", "enabled", "expectedRevision"],
          additionalProperties: false,
        },
      },
      {
        id: PLUGIN_TOOL_ACTION_ID_V1,
        schema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["plugin-tool"] },
            pluginId: IDENTIFIER,
            tool: IDENTIFIER,
            arguments: {
              type: "string",
              maxLength: MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1,
            },
          },
          required: ["kind", "pluginId", "tool", "arguments"],
          additionalProperties: false,
        },
      },
    ],
  });
}

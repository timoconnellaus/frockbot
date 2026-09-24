// The Plugins page for one Bot: the first-party features, what the deployment
// seeded, and what this User's Bots wrote — one list, one switch per row, per
// Bot (ADR 0026).
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
import type {
  PluginGrantV1,
  PluginDeviceV1,
  PluginNetworkV1,
  PluginTriggerV1,
} from "@frockbot/core/contracts";
import {
  pluginModelProviderDisplayNameV1,
  pluginServedProviderV1,
} from "@frockbot/providers/catalog/definition";
import { deploymentPluginArtifactHashV1 } from "./catalog.js";
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
  /** The network the descriptor declares, shown on the card before it is on. */
  network?: PluginNetworkV1;
  /** The device abilities its page may use, shown before it is on. */
  device?: PluginDeviceV1;
  /** The grants the descriptor asked for; `http` also opens this deployment's sender. */
  grants?: readonly PluginGrantV1[];
  /** Human-facing triggers this Plugin declares, for the Routine picker. */
  triggers?: readonly PluginTriggerV1[];
  /**
   * The model providers the descriptor serves (ADR 0032). A Bot whose model
   * names one of them runs it whatever this row's switch says.
   */
  modelProviders?: readonly string[];
  /** Off after failing Turns in a row; the switch turns it on again (ADR 0026). */
  quarantined?: string;
  /** The sections the Plugin drew on its card, when it is on and declares any. */
  sections?: BotPluginSectionV1[];
  /** Extra conversation.panel views the eight-tab cap dropped. */
  omitted?: string;
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

/**
 * What the card says about the reach a Plugin asked for.
 *
 * `http` opens two members, not one: the declared hosts and the deployment's
 * own sender. Both are said, in the same words the approval card says them
 * (`pluginApprovalActionV1`), because a Plugin that can ask this deployment to
 * mail somebody must never read as reaching nothing.
 */
export function pluginNetworkCopyV1(
  network: PluginNetworkV1 | undefined,
  grants: readonly PluginGrantV1[] = [],
): string {
  const sendsEmail = grants.includes("http");
  const mail = sendsEmail
    ? "Can ask this deployment to send email on the Bot's behalf, which a person approves message by message."
    : "";
  if (!network) return mail;
  if ("open" in network) {
    const open =
      "Needs open network access. Turning this on gives every plugin on this account open network access.";
    return mail ? `${open} ${mail}` : open;
  }
  if (network.hosts.length > 0) {
    const hosts = `Reaches ${network.hosts.join(", ")}.`;
    return mail ? `${hosts} ${mail}` : hosts;
  }
  return mail ? mail : "Reaches no host of its own.";
}

/**
 * What the row says about the model providers a Plugin serves.
 *
 * It says what a person can *do* with it, and nothing about how it is wired:
 * an endpoint and a route are the deployment's business, not theirs. A Plugin
 * whose only contribution is a provider has no switch worth pressing — its
 * code runs when a model is chosen — so it reads as a provider row rather
 * than as something a person turns on.
 */
export function pluginModelProviderCopyV1(
  modelProviders: readonly string[] | undefined,
): string {
  const served = pluginServedModelProviderIdsV1(modelProviders);
  if (served.length === 0) return "";
  const names = served.map(pluginModelProviderDisplayNameV1);
  return `Provides ${names.join(", ")} models. Choose a model in Models.`;
}

/**
 * The claimed providers this deployment actually serves through a Plugin.
 *
 * A descriptor's claim is not authority (ADR 0032): a Plugin no deployment
 * serves the provider through will never carry a credential, so no product
 * surface says that it does just because its descriptor says so.
 */
export function pluginServedModelProviderIdsV1(
  modelProviders: readonly string[] | undefined,
): string[] {
  return (modelProviders ?? []).filter(
    (provider) => pluginServedProviderV1(provider) !== undefined,
  );
}

/**
 * The providers one *member* is served through, which is a fact about bytes:
 * the member has to be the deployment's own Plugin, at the deployment's own
 * artifact, declaring the provider that catalog entry names for it. A
 * descriptor is a claim, and a member a Bot wrote is exactly the claimant
 * that must not be shown as carrying this deployment's credential.
 */
export function pluginServedModelProviderIdsForMemberV1(member: {
  packageId: string;
  artifact: { contentHash: string };
  modelProviders?: readonly string[];
}): string[] {
  if (
    deploymentPluginArtifactHashV1(member.packageId) !==
    member.artifact.contentHash
  ) {
    return [];
  }
  return (member.modelProviders ?? []).filter(
    (provider) =>
      pluginServedProviderV1(provider)?.pluginId === member.packageId,
  );
}

/**
 * Whether this Plugin's only contribution is a model provider it is actually
 * served through. Such a row has no switch worth pressing — it runs when a
 * model is chosen — but a Plugin with tools or hooks beside its provider is
 * mixed: those still answer to the Bot's own switch.
 */
export function isPureModelProviderPluginV1(row: {
  modelProviders?: readonly string[];
  tools?: readonly unknown[];
  hooks?: readonly unknown[];
}): boolean {
  return (
    pluginServedModelProviderIdsV1(row.modelProviders).length > 0 &&
    !row.tools?.length &&
    !row.hooks?.length
  );
}

/**
 * A first-party feature and a Plugin the deployment ships read the same to a
 * person — both came with FrockBot — so they share a heading; only what a Bot
 * wrote is set apart.
 */
function kindLabel(row: BotPluginRowV1): string {
  return row.kind === "authored" ? "Made by your Bots" : "Built in";
}

function pluginNode(row: BotPluginRowV1, revision: number): ViewNode {
  const lines: ViewNode[] = [
    { type: "text", text: row.description.slice(0, 4000), style: "body" },
  ];
  const reach = pluginNetworkCopyV1(row.network, row.grants);
  if (reach) lines.push({ type: "text", text: reach, style: "status" });
  if (row.device?.abilities.includes("microphone")) {
    lines.push({
      type: "text",
      text: "Its page can use your microphone while you have it open.",
      style: "status",
    });
  }
  const serves = pluginModelProviderCopyV1(row.modelProviders);
  if (serves) lines.push({ type: "text", text: serves, style: "status" });
  if (row.quarantined) {
    lines.push({ type: "text", text: row.quarantined, style: "status" });
  }
  if (row.omitted) {
    lines.push({ type: "text", text: row.omitted, style: "status" });
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
  return {
    type: "group",
    orientation: "column",
    title: row.displayName.slice(0, 150),
    children: [
      ...lines,
      {
        type: "group",
        orientation: "row",
        children: [
          {
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
          },
        ],
      },
    ],
  };
}

/** A Bot's Plugins frame as a `ViewDocument`. */
export function botPluginsDocumentV1(frame: BotPluginsFrameV1): ViewDocument {
  // No lead paragraph: the rows say what each Plugin does, and a sentence
  // above them explaining that a switch is per-Bot is a caption on a surface
  // that is only ever reached from one Bot's Settings.
  const children: ViewNode[] = [];
  let nodes = 2;
  let complete = true;
  // A Plugin's kind is a heading over the rows it covers rather than a suffix
  // on every one of their names: the client draws a titled group of titled
  // groups as a labelled card of rows, so the section is what says "Built in"
  // once, and a Plugin called "Web" is called Web.
  const kinds = new Map<string, ViewNode[]>();
  for (const row of frame.plugins) {
    const kind = kindLabel(row);
    const cost =
      6 +
      (kinds.has(kind) ? 0 : 1) +
      (row.network ? 1 : 0) +
      (row.device ? 1 : 0) +
      (row.quarantined ? 1 : 0) +
      (row.omitted ? 1 : 0) +
      (row.sections ?? []).reduce(
        (sum, section) => sum + (section.root ? 1 + section.nodes : 1),
        0,
      );
    if (nodes + cost > NODE_LIMIT) {
      complete = false;
      break;
    }
    nodes += cost;
    const section = kinds.get(kind) ?? [];
    if (section.length === 0) kinds.set(kind, section);
    section.push(pluginNode(row, frame.revision));
  }
  for (const [kind, rows] of kinds) {
    children.push({
      type: "group",
      orientation: "column",
      title: kind,
      children: rows,
    });
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

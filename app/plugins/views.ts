// A Plugin's section on its card, made safe to draw (ADR 0026 step 9).
//
// A Plugin answers a `settings.sections` view with a tree of nodes; this is
// where that tree becomes part of the Bot's Plugins page. The host draws it
// with its own widgets, so every node is re-read against a short list: text,
// groups, lists and actions. A control is the one place a section reaches
// back: its `actionId` names one of the Plugin's own tools, and the page
// carries it as a `plugin-tool` action the User's press runs outside any
// Turn. Anything else the Plugin sent — a field, an embed, a tool it does not
// declare, a tree past the budget — is the section's failure, said in words
// on the card rather than drawn wrong.
import type { PluginWorkerViewResultV1 } from "@frockbot/core/contracts";
import type { ViewNode } from "@frockbot/core/protocol-schemas";

/** One rendered section on a Plugin's card, or why there is none. */
export interface BotPluginSectionV1 {
  surfaceId: string;
  /** The section's tree, present when it rendered. */
  root?: ViewNode;
  /** Why there is nothing to draw, in words for the card. */
  failure?: string;
  /** How many nodes `root` holds, for the page's budget. */
  nodes: number;
}

/** The page action a section's control becomes. */
export const PLUGIN_TOOL_ACTION_ID_V1 = "plugin-tool";
/** Nodes one section may hold; a bigger tree is a failure, not a truncation. */
export const PLUGIN_SECTION_NODE_LIMIT_V1 = 64;
const PLUGIN_SECTION_DEPTH_LIMIT_V1 = 8;
/** The JSON a control hands its tool, as one string in the action's input. */
export const MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1 = 8_000;
const MAX_TEXT = 4_000;
const MAX_TITLE = 150;
const MAX_LABEL = 80;
const MAX_ROWS = 64;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TEXT_STYLES = new Set(["body", "heading", "label", "status"]);
const ACTION_STYLES = new Set(["primary", "secondary", "danger"]);
const UTF8 = new TextEncoder();

export interface PluginSectionSourceV1 {
  pluginId: string;
  surfaceId: string;
  /** The tools the Plugin declares; a control may name only one of these. */
  tools: readonly string[];
}

class SectionRefusal extends Error {}

function refuse(reason: string): never {
  throw new SectionRefusal(reason);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") refuse(`${what} is not text`);
  return value.slice(0, max);
}

/**
 * What the page's `plugin-tool` action carries for one control: the Plugin,
 * the tool, and the tool's input as one JSON string, because an action's
 * input is flat by the client wire schema.
 */
export function pluginToolActionInputV1(
  pluginId: string,
  tool: string,
  input: unknown,
): { kind: "plugin-tool"; pluginId: string; tool: string; arguments: string } {
  const serialized = JSON.stringify(input ?? {});
  if (UTF8.encode(serialized).byteLength > MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1) {
    refuse(
      `a control's input is over ${MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1} bytes`,
    );
  }
  return { kind: "plugin-tool", pluginId, tool, arguments: serialized };
}

function walk(
  value: unknown,
  source: PluginSectionSourceV1,
  budget: { nodes: number },
  depth: number,
): ViewNode {
  if (depth > PLUGIN_SECTION_DEPTH_LIMIT_V1)
    refuse("the section nests too deep");
  if (++budget.nodes > PLUGIN_SECTION_NODE_LIMIT_V1) {
    refuse(`the section holds more than ${PLUGIN_SECTION_NODE_LIMIT_V1} nodes`);
  }
  const node = record(value, "a node");
  switch (node.type) {
    case "text": {
      const style = node.style;
      if (style !== undefined && !TEXT_STYLES.has(style as string)) {
        refuse("a text node names an unknown style");
      }
      return {
        type: "text",
        text: text(node.text, "a text node's text", MAX_TEXT),
        ...(style !== undefined ? { style: style as "body" } : {}),
      };
    }
    case "group": {
      if (node.orientation !== "row" && node.orientation !== "column") {
        refuse("a group names an unknown orientation");
      }
      if (!Array.isArray(node.children)) refuse("a group has no children");
      if (node.collapsed !== undefined && typeof node.collapsed !== "boolean") {
        refuse("a group's collapsed flag is not a boolean");
      }
      return {
        type: "group",
        orientation: node.orientation,
        ...(node.title !== undefined
          ? { title: text(node.title, "a group's title", MAX_TITLE) }
          : {}),
        ...(node.collapsed !== undefined ? { collapsed: node.collapsed } : {}),
        children: node.children.map((child) =>
          walk(child, source, budget, depth + 1),
        ),
      };
    }
    case "action": {
      const tool = node.actionId;
      if (typeof tool !== "string" || !TOOL_NAME.test(tool)) {
        refuse("a control names an invalid tool");
      }
      if (!source.tools.includes(tool)) {
        refuse(`a control names "${tool}", which the plugin does not declare`);
      }
      const style = node.style;
      if (style !== undefined && !ACTION_STYLES.has(style as string)) {
        refuse("a control names an unknown style");
      }
      if (node.input !== undefined) record(node.input, "a control's input");
      return {
        type: "action",
        actionId: PLUGIN_TOOL_ACTION_ID_V1,
        label: text(node.label, "a control's label", MAX_LABEL),
        ...(style !== undefined ? { style: style as "primary" } : {}),
        input: pluginToolActionInputV1(source.pluginId, tool, node.input),
      };
    }
    case "list": {
      if (!Array.isArray(node.rows)) refuse("a list has no rows");
      if (node.rows.length > MAX_ROWS) {
        refuse(`a list holds more than ${MAX_ROWS} rows`);
      }
      const seen = new Set<string>();
      return {
        type: "list",
        ...(node.empty !== undefined
          ? { empty: text(node.empty, "a list's empty text", MAX_TITLE) }
          : {}),
        rows: node.rows.map((raw) => {
          const row = record(raw, "a list row");
          if (typeof row.id !== "string" || !IDENTIFIER.test(row.id)) {
            refuse("a list row has an invalid id");
          }
          if (seen.has(row.id)) refuse(`a list repeats the row "${row.id}"`);
          seen.add(row.id);
          if (row.selected !== undefined && typeof row.selected !== "boolean") {
            refuse("a list row's selected flag is not a boolean");
          }
          // A row's own action would need an input the row cannot carry, so
          // a section's controls are action nodes and rows are plain.
          return {
            id: row.id,
            node: walk(row.node, source, budget, depth + 1),
            ...(row.selected !== undefined ? { selected: row.selected } : {}),
          };
        }),
      };
    }
    case "field":
    case "embed":
      refuse(`a plugin section cannot hold a ${node.type} node`);
    // eslint-disable-next-line no-fallthrough -- `refuse` never returns.
    default:
      refuse("a node has an unknown type");
  }
}

/**
 * One Plugin's answer for one surface, as the section the card draws. Never
 * throws: a refusal is the section's failure, said for the card.
 */
export function pluginSectionV1(
  source: PluginSectionSourceV1,
  result: PluginWorkerViewResultV1,
): BotPluginSectionV1 {
  if (result.status === "drop") {
    return {
      surfaceId: source.surfaceId,
      nodes: 0,
      failure: `This plugin could not show its section${result.reason ? `: ${result.reason.slice(0, 500)}` : "."}`,
    };
  }
  const budget = { nodes: 0 };
  try {
    const root = walk(
      record(result.document, "the document").root,
      source,
      budget,
      0,
    );
    return { surfaceId: source.surfaceId, root, nodes: budget.nodes };
  } catch (error) {
    return {
      surfaceId: source.surfaceId,
      nodes: 0,
      failure:
        error instanceof SectionRefusal
          ? `This plugin's section could not be shown: ${error.message}.`
          : "This plugin's section could not be shown.",
    };
  }
}

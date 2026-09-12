import { describe, expect, test } from "bun:test";
import {
  MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1,
  PLUGIN_SECTION_NODE_LIMIT_V1,
  pluginSectionV1,
} from "./views.js";

const source = {
  pluginId: "weather",
  surfaceId: "weather.settings",
  tools: ["refresh", "clear"],
};

function rendered(root: unknown) {
  return {
    schemaVersion: 1 as const,
    status: "rendered" as const,
    document: { root },
  };
}

describe("a Plugin's section", () => {
  test("text, groups, lists and controls are kept; a control becomes the page's plugin-tool action", () => {
    const section = pluginSectionV1(
      source,
      rendered({
        type: "group",
        orientation: "column",
        title: "Forecast",
        children: [
          { type: "text", text: "Sunny, 21°.", style: "body" },
          {
            type: "list",
            empty: "No days yet",
            rows: [
              {
                id: "mon",
                node: { type: "text", text: "Monday" },
                selected: true,
                actionId: "refresh",
              },
            ],
          },
          {
            type: "action",
            actionId: "refresh",
            label: "Refresh now",
            style: "primary",
            input: { city: "Wollongong" },
          },
        ],
      }),
    );
    expect(section.failure).toBeUndefined();
    expect(section.nodes).toBe(5);
    expect(section.root).toEqual({
      type: "group",
      orientation: "column",
      title: "Forecast",
      children: [
        { type: "text", text: "Sunny, 21°.", style: "body" },
        {
          type: "list",
          empty: "No days yet",
          // A row's own action is dropped: rows are plain, controls press.
          rows: [
            {
              id: "mon",
              node: { type: "text", text: "Monday" },
              selected: true,
            },
          ],
        },
        {
          type: "action",
          actionId: "plugin-tool",
          label: "Refresh now",
          style: "primary",
          input: {
            kind: "plugin-tool",
            pluginId: "weather",
            tool: "refresh",
            arguments: '{"city":"Wollongong"}',
          },
        },
      ],
    });
  });

  test("a drop is the section's failure, in the plugin's words", () => {
    expect(
      pluginSectionV1(source, {
        schemaVersion: 1,
        status: "drop",
        reason: "no forecast today",
      }),
    ).toEqual({
      surfaceId: "weather.settings",
      nodes: 0,
      failure: "This plugin could not show its section: no forecast today",
    });
    expect(
      pluginSectionV1(source, { schemaVersion: 1, status: "drop" }).failure,
    ).toBe("This plugin could not show its section.");
  });

  test("a field, an embed, an undeclared tool, an unknown node and an oversized input are refused by name", () => {
    const failure = (root: unknown) =>
      pluginSectionV1(source, rendered(root)).failure;
    expect(
      failure({ type: "field", field: { id: "x", label: "x", kind: "text" } }),
    ).toMatch(/cannot hold a field node/);
    expect(
      failure({
        type: "embed",
        kind: "image",
        source: "https://x",
        label: "x",
      }),
    ).toMatch(/cannot hold a embed node/);
    expect(
      failure({ type: "action", actionId: "delete_all", label: "x" }),
    ).toMatch(/"delete_all", which the plugin does not declare/);
    expect(
      failure({ type: "action", actionId: "Bad Name", label: "x" }),
    ).toMatch(/invalid tool/);
    expect(failure({ type: "widget" })).toMatch(/unknown type/);
    expect(failure({ type: "text", text: 42 })).toMatch(/is not text/);
    expect(failure("nope")).toMatch(/is not an object/);
    expect(
      failure({
        type: "action",
        actionId: "refresh",
        label: "x",
        input: { blob: "a".repeat(MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1) },
      }),
    ).toMatch(/over 8000 bytes/);
  });

  test("a tree past the node budget or the depth limit is refused whole", () => {
    const wide = {
      type: "group",
      orientation: "row",
      children: Array.from({ length: PLUGIN_SECTION_NODE_LIMIT_V1 }, () => ({
        type: "text",
        text: "x",
      })),
    };
    expect(pluginSectionV1(source, rendered(wide)).failure).toMatch(
      /more than 64 nodes/,
    );
    let deep: unknown = { type: "text", text: "leaf" };
    for (let level = 0; level < 10; level += 1) {
      deep = { type: "group", orientation: "column", children: [deep] };
    }
    expect(pluginSectionV1(source, rendered(deep)).failure).toMatch(
      /nests too deep/,
    );
  });

  test("an empty string is a refusal, because no node the page draws holds one", () => {
    const failure = (root: unknown) =>
      pluginSectionV1(source, rendered(root)).failure;
    expect(failure({ type: "text", text: "" })).toMatch(/is empty/);
    expect(
      failure({
        type: "group",
        orientation: "column",
        title: "",
        children: [],
      }),
    ).toMatch(/is empty/);
    expect(failure({ type: "action", actionId: "refresh", label: "" })).toMatch(
      /is empty/,
    );
    expect(failure({ type: "list", empty: "", rows: [] })).toMatch(/is empty/);
  });

  test("text is bounded, not refused", () => {
    const section = pluginSectionV1(
      source,
      rendered({ type: "text", text: "a".repeat(5_000) }),
    );
    expect((section.root as { text: string }).text).toHaveLength(4_000);
  });
});

import { describe, expect, test } from "bun:test";
import {
  botNavDoorsV1,
  conversationPanelBagV1,
  omittedPanelsCopyV1,
  resolvePanelFocusV1,
  type PluginPanelSourceV1,
} from "./panels.js";
import { MAX_PLUGIN_PANEL_BAG_V1 } from "@frockbot/core/durable";
import { isProtocolValue } from "@frockbot/core/protocol-schemas";

function plugin(
  pluginId: string,
  views: PluginPanelSourceV1["views"],
  displayName = pluginId,
): PluginPanelSourceV1 {
  return { pluginId, displayName, views };
}

describe("the conversation.panel bag", () => {
  test("is every panel surface in mount order, capped at eight", () => {
    const plugins = [
      plugin("notes", [
        { slot: "conversation.panel", surfaceId: "board", label: "Notes" },
        { slot: "settings.sections", surfaceId: "settings" },
      ]),
      plugin("tasks", [
        { slot: "conversation.panel", surfaceId: "today", label: "Today" },
        { slot: "conversation.panel", surfaceId: "later", label: "Later" },
      ]),
    ];
    const { tabs, omitted } = conversationPanelBagV1(plugins);
    expect(tabs).toEqual([
      {
        pluginId: "notes",
        displayName: "notes",
        surfaceId: "board",
        label: "Notes",
      },
      {
        pluginId: "tasks",
        displayName: "tasks",
        surfaceId: "today",
        label: "Today",
      },
      {
        pluginId: "tasks",
        displayName: "tasks",
        surfaceId: "later",
        label: "Later",
      },
    ]);
    expect(omitted.size).toBe(0);
  });

  test("drops extra panels with a notice naming them", () => {
    const plugins = Array.from({ length: 10 }, (_, index) =>
      plugin(`p${index}`, [
        {
          slot: "conversation.panel",
          surfaceId: "main",
          label: `Panel ${index}`,
        },
      ]),
    );
    const { tabs, omitted } = conversationPanelBagV1(plugins);
    expect(tabs).toHaveLength(MAX_PLUGIN_PANEL_BAG_V1);
    expect(omitted.get("p8")).toEqual(["Panel 8"]);
    expect(omitted.get("p9")).toEqual(["Panel 9"]);
    expect(omittedPanelsCopyV1(["Panel 8"])).toBe(
      "This Bot already shows eight conversation panels, so Panel 8 is not offered.",
    );
  });

  test("uses the Plugin's display name when a single panel has no label", () => {
    const { tabs } = conversationPanelBagV1([
      plugin(
        "notes",
        [{ slot: "conversation.panel", surfaceId: "board" }],
        "Notes",
      ),
    ]);
    expect(tabs[0]?.label).toBe("Notes");
  });

  test("a display name past a label's cap still makes a tab and door the wire accepts", () => {
    const plugins = [
      plugin(
        "notes",
        [{ slot: "conversation.panel", surfaceId: "board" }],
        "N".repeat(128),
      ),
    ];
    const { tabs } = conversationPanelBagV1(plugins);
    const [door] = botNavDoorsV1(plugins, tabs);
    expect(isProtocolValue("PanelBagEntry", tabs[0])).toBe(true);
    expect(
      isProtocolValue("PanelDoor", {
        pluginId: door!.pluginId,
        label: door!.label,
        opens: door!.opens,
      }),
    ).toBe(true);
  });
});

describe("bot.nav doors", () => {
  test("a declared nav row opens that Plugin's named panel, else its first", () => {
    const plugins = [
      plugin("notes", [
        { slot: "conversation.panel", surfaceId: "board" },
        { slot: "conversation.panel", surfaceId: "archive", label: "Archive" },
        {
          slot: "bot.nav",
          surfaceId: "door",
          label: "Notes",
          opens: "archive",
        },
      ]),
    ];
    const bag = conversationPanelBagV1(plugins).tabs;
    expect(botNavDoorsV1(plugins, bag)).toEqual([
      {
        pluginId: "notes",
        displayName: "notes",
        label: "Notes",
        surfaceId: "door",
        opens: { pluginId: "notes", surfaceId: "archive" },
      },
    ]);
  });

  test("a panel Plugin with no nav still gets a host-drawn door", () => {
    const plugins = [
      plugin(
        "notes",
        [{ slot: "conversation.panel", surfaceId: "board" }],
        "Notes",
      ),
    ];
    const bag = conversationPanelBagV1(plugins).tabs;
    expect(botNavDoorsV1(plugins, bag)).toEqual([
      {
        pluginId: "notes",
        displayName: "Notes",
        label: "Notes",
        opens: { pluginId: "notes", surfaceId: "board" },
      },
    ]);
  });

  test("a nav view that opens nothing is still drawn", () => {
    const plugins = [
      plugin("status", [
        { slot: "bot.nav", surfaceId: "row", label: "Status" },
      ]),
    ];
    expect(botNavDoorsV1(plugins, [])).toEqual([
      {
        pluginId: "status",
        displayName: "status",
        label: "Status",
        surfaceId: "row",
      },
    ]);
  });
});

describe("panel_focus resolution", () => {
  const bag = conversationPanelBagV1([
    plugin(
      "notes",
      [{ slot: "conversation.panel", surfaceId: "board" }],
      "Notes",
    ),
    plugin("tasks", [
      { slot: "conversation.panel", surfaceId: "today", label: "Today" },
      { slot: "conversation.panel", surfaceId: "later", label: "Later" },
    ]),
  ]).tabs;

  test("pluginId is enough when that Plugin has one panel", () => {
    expect(resolvePanelFocusV1(bag, { pluginId: "notes" })).toEqual({
      status: "open",
      pluginId: "notes",
      surfaceId: "board",
    });
  });

  test("a Plugin with two panels needs a surfaceId", () => {
    expect(resolvePanelFocusV1(bag, { pluginId: "tasks" })).toMatchObject({
      status: "error",
    });
    expect(
      resolvePanelFocusV1(bag, { pluginId: "tasks", surfaceId: "later" }),
    ).toEqual({
      status: "open",
      pluginId: "tasks",
      surfaceId: "later",
    });
  });

  test("null closes; unknown names the tabs this Bot has", () => {
    expect(resolvePanelFocusV1(bag, { pluginId: null })).toEqual({
      status: "closed",
    });
    const unknown = resolvePanelFocusV1(bag, { pluginId: "missing" });
    expect(unknown.status).toBe("error");
    if (unknown.status === "error") {
      expect(unknown.failure).toContain("missing");
      expect(unknown.failure).toContain("notes/board");
    }
  });
});

// The conversation.panel bag and bot.nav doors (ADR 0034).
//
// The bag is every conversation.panel surface on this Bot's enabled Plugins,
// in Composition mount order, at most eight. Extra declarations are omitted
// with a notice on that Plugin's card. A Plugin with two panel surfaces is
// two members, the same as two Plugins with one each.
//
// bot.nav is a row on this Bot's page. A Plugin that declares a panel and no
// nav still gets a host-drawn door so the page is reachable when the region
// is closed.
import { MAX_PLUGIN_PANEL_BAG_V1 } from "@frockbot/core/durable";
import {
  MAX_PLUGIN_VIEW_LABEL_V1,
  type PluginViewV1,
} from "@frockbot/core/contracts";

export { MAX_PLUGIN_PANEL_BAG_V1 };

/** One conversation.panel surface the host will offer as a tab. */
export interface PluginPanelTabV1 {
  pluginId: string;
  displayName: string;
  surfaceId: string;
  label: string;
}

/** One door on this Bot's page: a plugin nav view, or a host-synthesised row. */
export interface PluginNavDoorV1 {
  pluginId: string;
  displayName: string;
  label: string;
  /** The bot.nav surface to draw, absent on a synthesised door. */
  surfaceId?: string;
  /** The conversation.panel this press focuses, if any. */
  opens?: { pluginId: string; surfaceId: string };
}

export interface PluginPanelSourceV1 {
  pluginId: string;
  displayName: string;
  views?: readonly PluginViewV1[];
}

export interface PluginPanelBagV1 {
  tabs: PluginPanelTabV1[];
  /** Surfaces dropped after the cap, keyed by Plugin, in declaration order. */
  omitted: Map<string, string[]>;
}

function panelViews(plugin: PluginPanelSourceV1): PluginViewV1[] {
  return (plugin.views ?? []).filter(
    (view) => view.slot === "conversation.panel",
  );
}

function navViews(plugin: PluginPanelSourceV1): PluginViewV1[] {
  return (plugin.views ?? []).filter((view) => view.slot === "bot.nav");
}

/** A display name may run past a label's cap, and the wire refuses the read. */
function tabLabel(plugin: PluginPanelSourceV1, view: PluginViewV1): string {
  return (view.label ?? plugin.displayName).slice(0, MAX_PLUGIN_VIEW_LABEL_V1);
}

/**
 * The tabs this Bot offers, in the order the caller already mounted the
 * Plugins, plus which extra panel views were dropped.
 */
export function conversationPanelBagV1(
  plugins: readonly PluginPanelSourceV1[],
): PluginPanelBagV1 {
  const tabs: PluginPanelTabV1[] = [];
  const omitted = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const view of panelViews(plugin)) {
      if (tabs.length < MAX_PLUGIN_PANEL_BAG_V1) {
        tabs.push({
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          surfaceId: view.surfaceId,
          label: tabLabel(plugin, view),
        });
        continue;
      }
      const dropped = omitted.get(plugin.pluginId) ?? [];
      dropped.push(view.label ?? view.surfaceId);
      omitted.set(plugin.pluginId, dropped);
    }
  }
  return { tabs, omitted };
}

/** The sentence the Plugin's card shows for views the cap dropped. */
export function omittedPanelsCopyV1(names: readonly string[]): string {
  if (names.length === 0) return "";
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `This Bot already shows eight conversation panels, so ${listed} ${names.length === 1 ? "is" : "are"} not offered.`;
}

/**
 * Doors on this Bot's page: declared bot.nav views (capped with the bag),
 * then a host door for every bag Plugin that declared no nav.
 */
export function botNavDoorsV1(
  plugins: readonly PluginPanelSourceV1[],
  bag: readonly PluginPanelTabV1[],
): PluginNavDoorV1[] {
  const doors: PluginNavDoorV1[] = [];
  const pluginsById = new Map(
    plugins.map((plugin) => [plugin.pluginId, plugin]),
  );
  for (const plugin of plugins) {
    for (const view of navViews(plugin)) {
      if (doors.length >= MAX_PLUGIN_PANEL_BAG_V1) break;
      const opensSurface = view.opens ?? panelViews(plugin)[0]?.surfaceId;
      doors.push({
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        label: tabLabel(plugin, view),
        surfaceId: view.surfaceId,
        ...(opensSurface
          ? { opens: { pluginId: plugin.pluginId, surfaceId: opensSurface } }
          : {}),
      });
    }
    if (doors.length >= MAX_PLUGIN_PANEL_BAG_V1) break;
  }
  const navPluginIds = new Set(doors.map((door) => door.pluginId));
  const seenBagPlugins = new Set<string>();
  for (const tab of bag) {
    if (seenBagPlugins.has(tab.pluginId) || navPluginIds.has(tab.pluginId)) {
      continue;
    }
    seenBagPlugins.add(tab.pluginId);
    const plugin = pluginsById.get(tab.pluginId);
    doors.push({
      pluginId: tab.pluginId,
      displayName: tab.displayName,
      label: tab.label,
      opens: { pluginId: tab.pluginId, surfaceId: tab.surfaceId },
    });
    void plugin;
  }
  return doors;
}

/** Resolve a panel_focus request against the bag, or name the tabs it has. */
export function resolvePanelFocusV1(
  bag: readonly PluginPanelTabV1[],
  request: { pluginId: string | null; surfaceId?: string },
):
  | { status: "closed" }
  | { status: "open"; pluginId: string; surfaceId: string }
  | { status: "error"; failure: string } {
  if (request.pluginId === null) {
    if (request.surfaceId !== undefined) {
      return {
        status: "error",
        failure: "Closing the panel does not take a surface.",
      };
    }
    return { status: "closed" };
  }
  const tabs = bag.filter((tab) => tab.pluginId === request.pluginId);
  if (tabs.length === 0) {
    return {
      status: "error",
      failure: unknownPanelCopyV1(bag, request.pluginId),
    };
  }
  if (request.surfaceId === undefined) {
    if (tabs.length > 1) {
      return {
        status: "error",
        failure: `Choose a surface on ${tabs[0]!.displayName}: ${tabs.map((tab) => tab.surfaceId).join(", ")}.`,
      };
    }
    return {
      status: "open",
      pluginId: tabs[0]!.pluginId,
      surfaceId: tabs[0]!.surfaceId,
    };
  }
  const tab = tabs.find(
    (candidate) => candidate.surfaceId === request.surfaceId,
  );
  if (!tab) {
    return {
      status: "error",
      failure: `"${request.surfaceId}" is not a conversation panel on ${tabs[0]!.displayName}. ${namedTabsCopyV1(bag)}`,
    };
  }
  return {
    status: "open",
    pluginId: tab.pluginId,
    surfaceId: tab.surfaceId,
  };
}

export function namedTabsCopyV1(bag: readonly PluginPanelTabV1[]): string {
  if (bag.length === 0) return "This Bot has no conversation panels.";
  return `This Bot's panels: ${bag.map((tab) => `${tab.label} (${tab.pluginId}/${tab.surfaceId})`).join(", ")}.`;
}

function unknownPanelCopyV1(
  bag: readonly PluginPanelTabV1[],
  pluginId: string,
): string {
  return `"${pluginId}" is not a conversation panel on this Bot. ${namedTabsCopyV1(bag)}`;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** The client's tab press: open a surface or close the region. */
export function decodePanelFocusCommandV1(input: unknown): {
  pluginId: string | null;
  surfaceId?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("panel focus command must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const allowed = new Set(["pluginId", "schemaVersion", "surfaceId"]);
  if (value.schemaVersion !== 1 || !keys.every((key) => allowed.has(key))) {
    throw new Error("panel focus command has invalid fields");
  }
  if (!Object.hasOwn(value, "pluginId")) {
    throw new Error("panel focus command needs a plugin id");
  }
  if (
    value.pluginId !== null &&
    (typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId))
  ) {
    throw new Error("panel focus command pluginId is invalid");
  }
  if (value.surfaceId !== undefined) {
    if (
      typeof value.surfaceId !== "string" ||
      !SURFACE_ID.test(value.surfaceId)
    ) {
      throw new Error("panel focus command surfaceId is invalid");
    }
  }
  return {
    pluginId: value.pluginId as string | null,
    ...(typeof value.surfaceId === "string"
      ? { surfaceId: value.surfaceId }
      : {}),
  };
}

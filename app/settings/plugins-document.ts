// The `PluginsFrame` a settings route produces, projected as the `ViewDocument`
// the host renders — the same convention as `settings-document.ts` and
// `connections-document.ts`, reached with `?as=document`.
//
// Every action declares a `kind` from the closed vocabulary below, because the
// command an action means is not derivable from the label a person reads. The
// three kinds are the whole of this surface: Plugins turns a Package on and
// off and points at the surface that configures it. Nothing a Package declares
// is edited here.

import {
  decodeProtocol,
  type ActionValueSchema,
  type PluginsFrame,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";

export const PLUGIN_ACTION_KINDS_V1 = [
  "install-package",
  "set-package-enabled",
  "open-home",
] as const;

export type PluginActionKindV1 = (typeof PLUGIN_ACTION_KINDS_V1)[number];

/** The renderer's node budget, checked before it builds a widget. */
const NODE_LIMIT = 512;
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
const KIND: ActionValueSchema = {
  type: "string",
  enum: [...PLUGIN_ACTION_KINDS_V1],
};

type Plugin = PluginsFrame["plugins"][number];

const HOME_LABELS: Record<Plugin["home"], string | undefined> = {
  models: "Connectors",
  connections: "Connectors",
  "user-settings": "Settings",
  none: undefined,
};

const STATE_LABELS: Record<Plugin["state"], string> = {
  "not-installed": "Not installed",
  installed: "On",
  disabled: "Off",
  failed: "Failed",
};

function press(
  actionId: string,
  label: string,
  input: Record<string, string | boolean>,
  style?: "primary" | "danger",
): ViewNode {
  return {
    type: "action",
    actionId,
    label: label.slice(0, 100),
    ...(style ? { style } : {}),
    input,
  };
}

function pluginNode(plugin: Plugin): ViewNode {
  const controls: ViewNode[] = [];
  const home = HOME_LABELS[plugin.home];
  if (home && plugin.state === "installed") {
    controls.push(
      press("open-home", `Set up in ${home}`, {
        kind: "open-home",
        home: plugin.home,
      }),
    );
  }
  if (plugin.state === "not-installed") {
    controls.push(
      press("install-package", "Add", {
        kind: "install-package",
        packageId: plugin.packageId,
        version: plugin.version,
      }),
    );
  } else {
    const on = plugin.state === "installed";
    controls.push(
      press("set-package-enabled", on ? "Turn off" : "Turn on", {
        kind: "set-package-enabled",
        packageId: plugin.packageId,
        enabled: !on,
      }),
    );
  }
  return {
    type: "group",
    orientation: "column",
    title: plugin.displayName,
    children: [
      // What it offers and whether it is on are one line, not two: a list of
      // twenty rows is read down the titles, and a row that spends four lines
      // saying two short things pushes the next title off the screen.
      {
        type: "text",
        text: `${plugin.summary} · ${STATE_LABELS[plugin.state]}`.slice(
          0,
          4000,
        ),
        style: "status",
      },
      ...(plugin.failure
        ? [{ type: "text", text: plugin.failure } as ViewNode]
        : []),
      { type: "group", orientation: "row", children: controls },
    ],
  };
}

/** A `PluginsFrame` as a `ViewDocument`. */
export function pluginsDocumentV1(frame: PluginsFrame): ViewDocument {
  const installed = frame.plugins.filter(
    (plugin) => plugin.state !== "not-installed",
  ).length;
  const children: ViewNode[] = [
    {
      type: "text",
      text: `${installed} installed`,
      style: "status",
    },
    {
      type: "text",
      text: "Turn plugins on and off for your Bots. Set one up where it belongs: accounts and model providers in Connectors.",
    },
  ];
  // The root, the two lines above and the overflow status the tail may need.
  let nodes = 4;
  let complete = true;
  for (const plugin of frame.plugins) {
    const node = pluginNode(plugin);
    const cost = 4 + (plugin.failure ? 1 : 0);
    if (nodes + cost > NODE_LIMIT) {
      complete = false;
      break;
    }
    nodes += cost;
    children.push(node);
  }
  if (!complete) {
    children.push({
      type: "text",
      text: "The rest of your plugins need a newer app. Everything above is still yours to change.",
      style: "status",
    });
  }
  if (frame.plugins.length === 0) {
    children.push({
      type: "text",
      text: "This deployment ships no plugins.",
    });
  }
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "plugins",
    revision: frame.revision,
    root: { type: "group", orientation: "column", children },
    actions: [
      {
        id: "install-package",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            packageId: IDENTIFIER,
            version: { type: "string", maxLength: 64 },
          },
          required: ["kind", "packageId", "version"],
          additionalProperties: false,
        },
      },
      {
        id: "set-package-enabled",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            packageId: IDENTIFIER,
            enabled: { type: "boolean" },
          },
          required: ["kind", "packageId", "enabled"],
          additionalProperties: false,
        },
      },
      {
        id: "open-home",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            home: {
              type: "string",
              enum: ["models", "connections", "user-settings", "none"],
            },
          },
          required: ["kind", "home"],
          additionalProperties: false,
        },
      },
    ],
  });
}

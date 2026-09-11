// The `PluginsFrame` a settings route produces, projected as the `ViewDocument`
// the host renders — the same convention as `settings-document.ts` and
// `connections-document.ts`, reached with `?as=document`.
//
// Every action declares a `kind` from the closed vocabulary below, because the
// command an action means is not derivable from the label a person reads. The
// three kinds are the whole of this surface: Plugins turns a Package on and
// off and points at the surface that configures it. Nothing a Package declares
// is edited here.

import { CAPABILITY_DESCRIPTIONS } from "./catalog-copy.js";

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
  models: "Models",
  connections: "Marketplace",
  "user-settings": "Feature settings",
  none: undefined,
};

const STATE_LABELS: Record<Plugin["state"], string> = {
  "not-installed": "Not installed",
  installed: "On",
  disabled: "Off",
  failed: "Failed",
};

/**
 * On, but not yet usable: Messages runs on a Mac this account has paired, so
 * the switch being on is only half of what the person has to do. The line says
 * so wherever the Package is drawn, because "On" alone would be a promise the
 * capability cannot keep on its own.
 */
function setupPending(plugin: Plugin): boolean {
  return (
    plugin.packageId === "machine-messages" && plugin.state === "installed"
  );
}

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

function pluginNode(plugin: Plugin, capabilities: boolean): ViewNode {
  const controls: ViewNode[] = [];
  const home = HOME_LABELS[plugin.home];
  if (home && (capabilities || plugin.state === "installed")) {
    controls.push(
      press("open-home", capabilities ? "Settings" : `Set up in ${home}`, {
        kind: "open-home",
        home: plugin.home,
        packageId: plugin.packageId,
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
    title: capabilities
      ? `${plugin.displayName.slice(0, 150)}${setupPending(plugin) ? " · Needs Mac setup" : ""}`
      : `${plugin.displayName.slice(0, 150)} · ${setupPending(plugin) ? "Available — needs Mac setup" : STATE_LABELS[plugin.state]}`,
    children: [
      {
        type: "text",
        text: (
          CAPABILITY_DESCRIPTIONS[plugin.packageId] ?? plugin.summary
        ).slice(0, 4000),
        style: capabilities ? "body" : "status",
      },
      ...(plugin.failure
        ? [{ type: "text", text: plugin.failure } as ViewNode]
        : []),
      {
        type: "group",
        orientation: capabilities ? "row" : "column",
        ...(capabilities
          ? {}
          : { title: "Details & controls", collapsed: true }),
        children: [
          ...(capabilities
            ? []
            : [
                {
                  type: "text" as const,
                  text: `Version ${plugin.version}`,
                  style: "status" as const,
                },
              ]),
          ...controls,
        ],
      },
    ],
  };
}

/** A `PluginsFrame` as a `ViewDocument`. */
export function pluginsDocumentV1(
  frame: PluginsFrame,
  capabilities = false,
): ViewDocument {
  const installed = frame.plugins.filter(
    (plugin) => plugin.state !== "not-installed",
  ).length;
  const children: ViewNode[] = [
    {
      type: "text",
      text: capabilities
        ? "Available to all your Bots"
        : `${installed} installed`,
      style: "status",
    },
    {
      type: "text",
      text: capabilities
        ? "Choose which extra abilities your Bots can use. Each card explains what the feature does."
        : "Extensions add new abilities to your Bots. Open an extension for its description and controls. Models and built-in features have their own settings.",
    },
  ];
  // The root, the two lines above and the overflow status the tail may need.
  let nodes = 4;
  let complete = true;
  for (const plugin of frame.plugins) {
    const node = pluginNode(plugin, capabilities);
    const cost = 7 + (plugin.failure ? 1 : 0);
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
      text: "No extensions are available yet. Your Bots already include memory, skills, routines and a hosted Computer. Model providers are in Models; optional features are in Bot capabilities.",
    });
  }
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: capabilities ? "capabilities" : "plugins",
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
            packageId: IDENTIFIER,
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

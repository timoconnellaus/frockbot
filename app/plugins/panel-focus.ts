// `panel_focus`: put a conversation.panel in front of the person (ADR 0034).
//
// First-party, in the `frockbot` namespace. Mounted only when this Bot's
// enabled bag is non-empty, so a Bot with no panel Plugins is not offered a
// chrome tool. Showing a tab does not widen authority.
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/core/contracts";
import { namedTabsCopyV1, type PluginPanelTabV1 } from "./panels.js";

export interface PanelFocusHostV1 {
  bag: readonly PluginPanelTabV1[];
  focus(request: {
    pluginId: string | null;
    surfaceId?: string;
  }): Promise<
    | { status: "applied"; pluginId: string | null; surfaceId?: string }
    | { status: "error"; failure: string }
  >;
}

export interface PanelFocusRuntimeHostV1 {
  readonly panels: PanelFocusHostV1;
}

function tool(
  definition: Omit<ToolDefinition, "execute"> & {
    answer(input: unknown, context: ToolExecutionContext): Promise<string>;
  },
): ToolDefinition {
  return {
    ...definition,
    namespace: "frockbot",
    async execute(input, context) {
      try {
        return {
          content: await definition.answer(input, context),
          isError: false,
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

export function createPanelFocusFeature(
  host: PanelFocusRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => [
    runtime.tools.register(
      tool({
        name: "panel_focus",
        description:
          "Show one conversation panel beside this conversation, or close the panel. Pass pluginId and optional surfaceId to select a tab, or pluginId: null to close it. Creating or publishing a Plugin does not open it; call this when the person should look.",
        inputSchema: {
          type: "object",
          properties: {
            pluginId: {
              type: ["string", "null"],
              description:
                "The Plugin whose conversation.panel to show, or null to close the panel.",
            },
            surfaceId: {
              type: "string",
              description:
                "Which conversation.panel surface to show when that Plugin declares more than one. Optional when it declares only one.",
            },
          },
          required: ["pluginId"],
          additionalProperties: false,
        },
        idempotent: false,
        async answer(input) {
          const value = (input ?? {}) as Record<string, unknown>;
          const pluginId = value.pluginId;
          if (pluginId !== null && typeof pluginId !== "string") {
            throw new Error("pluginId must be a plugin id or null");
          }
          if (
            value.surfaceId !== undefined &&
            typeof value.surfaceId !== "string"
          ) {
            throw new Error("surfaceId must be a surface id");
          }
          const result = await host.panels.focus({
            pluginId,
            ...(typeof value.surfaceId === "string"
              ? { surfaceId: value.surfaceId }
              : {}),
          });
          if (result.status === "error") throw new Error(result.failure);
          if (result.pluginId === null) return "Closed the conversation panel.";
          const tab = host.panels.bag.find(
            (candidate) =>
              candidate.pluginId === result.pluginId &&
              candidate.surfaceId === result.surfaceId,
          );
          return tab
            ? `Showing ${tab.label} beside the conversation.`
            : `Showing ${result.pluginId}/${result.surfaceId} beside the conversation.`;
        },
      }),
    ),
  ];
}

export function panelFocusUnavailableCopyV1(): string {
  return namedTabsCopyV1([]);
}

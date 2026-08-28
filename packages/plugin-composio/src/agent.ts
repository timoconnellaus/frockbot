import type { ToolDefinition } from "@frockbot/agent-core";
import type { Context, Plugin } from "cordis";
import { ComposioClient } from "./composio-client.js";

export interface ComposioToolDeclaration {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  version?: string;
}

export interface ComposioPluginConfig {
  client: ComposioClient;
  userId: string;
  connectedAccountId: string;
  tools: ComposioToolDeclaration[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ComposioRouterPluginConfig {
  client: ComposioClient;
  userId: string;
  toolkitSlug: string;
  authorizeEffect(): Promise<{
    connectedAccountId: string;
    toolkitSlug: string;
  }>;
}

export function createConfiguredComposioRuntimeContribution(config: {
  assignment: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
    state: string;
  };
  userId: string;
  readSecret(name: string): string | undefined;
  authorizeConnection(): Promise<{ safeMetadata: Record<string, unknown> }>;
}): Plugin.Function | undefined {
  if (
    config.assignment.packageId !== "composio" ||
    config.assignment.capabilityId !== "gmail-tools" ||
    config.assignment.state !== "enabled" ||
    !config.assignment.connectionId
  ) {
    return undefined;
  }
  const apiKey = config.readSecret("COMPOSIO_API_KEY");
  if (!apiKey) throw new Error("Assigned Composio Connection is misconfigured");
  const authorizeEffect = async () => {
    const connection = await config.authorizeConnection();
    const connectedAccountId = connection.safeMetadata.connectedAccountId;
    const toolkitSlug = connection.safeMetadata.toolkitSlug;
    if (
      typeof connectedAccountId !== "string" ||
      typeof toolkitSlug !== "string"
    ) {
      throw new Error("Composio effect is no longer authorized");
    }
    return { connectedAccountId, toolkitSlug };
  };
  return createComposioRouterPlugin({
    client: new ComposioClient({ apiKey }),
    userId: config.userId,
    toolkitSlug: "gmail",
    authorizeEffect,
  });
}

export function createComposioRouterPlugin(
  config: ComposioRouterPluginConfig,
): Plugin.Function {
  const allowedToolSlugs = new Set<string>();
  const search: ToolDefinition = {
    name: "composio_search_tools",
    description:
      "Search the connected toolkit for exact Composio tool slugs before executing one.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
    validate: isObject,
    execute: async (input: unknown) => {
      const query =
        isObject(input) && typeof input.query === "string"
          ? input.query
          : undefined;
      const grant = await config.authorizeEffect();
      if (grant.toolkitSlug !== config.toolkitSlug) {
        throw new Error("Composio effect grant changed toolkit");
      }
      const result = await config.client.searchTools(grant.toolkitSlug, query);
      for (const tool of result) allowedToolSlugs.add(tool.slug);
      return { content: JSON.stringify(result), isError: false };
    },
  };
  const execute: ToolDefinition = {
    name: "composio_execute_tool",
    description:
      "Execute an exact Composio tool slug returned by composio_search_tools.",
    inputSchema: {
      type: "object",
      properties: {
        toolSlug: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["toolSlug", "arguments"],
    },
    validate: (input: unknown) =>
      isObject(input) &&
      typeof input.toolSlug === "string" &&
      isObject(input.arguments),
    execute: async (input: unknown) => {
      if (
        !isObject(input) ||
        typeof input.toolSlug !== "string" ||
        !isObject(input.arguments)
      ) {
        return { content: "Invalid Composio tool input", isError: true };
      }
      if (!allowedToolSlugs.has(input.toolSlug)) {
        return {
          content:
            "Tool slug was not returned by composio_search_tools in this runtime.",
          isError: true,
        };
      }
      const grant = await config.authorizeEffect();
      if (grant.toolkitSlug !== config.toolkitSlug) {
        return {
          content: "Composio effect grant changed toolkit",
          isError: true,
        };
      }
      const result = await config.client.executeTool({
        toolSlug: input.toolSlug,
        userId: config.userId,
        connectedAccountId: grant.connectedAccountId,
        arguments: input.arguments,
      });
      return { content: JSON.stringify(result), isError: false };
    },
  };
  const plugin: Plugin.Function = (ctx: Context) => {
    const removeSearch = ctx.tools.register(search);
    const removeExecute = ctx.tools.register(execute);
    return () => {
      removeExecute();
      removeSearch();
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}

export function createComposioPlugin(
  config: ComposioPluginConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx: Context) => {
    const disposers = config.tools.map((declaration) => {
      const tool: ToolDefinition = {
        name: declaration.name,
        description: declaration.description,
        inputSchema: declaration.inputSchema,
        validate: isObject,
        execute: async (input: unknown) => {
          const result = await config.client.executeTool({
            toolSlug: declaration.slug,
            userId: config.userId,
            connectedAccountId: config.connectedAccountId,
            version: declaration.version,
            arguments: input as Record<string, unknown>,
          });
          return {
            content: JSON.stringify(result),
            isError: false,
          };
        },
      };
      return ctx.tools.register(tool);
    });
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}

import type { Context, Plugin } from "cordis";
import { decodeConnectedToolsV1, object } from "./tool-contracts.js";

/** One Connection grants this namespace to every Bot of its User. No secret enters the runtime. */
export async function createConfiguredComposioRuntimeContribution(config: {
  capability: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
  };
  composioRequest?(input: unknown): Promise<unknown>;
}): Promise<Plugin.Function | undefined> {
  if (
    config.capability.packageId !== "composio" ||
    config.capability.capabilityId !== "app-tools" ||
    !config.capability.connectionId
  )
    return undefined;
  if (!config.composioRequest)
    throw new Error("Connected account tools are unavailable");
  const request = config.composioRequest;
  const connectionId = config.capability.connectionId;
  const catalog = decodeConnectedToolsV1(
    await request({ schemaVersion: 1, operation: "list-tools", connectionId }),
  );
  const plugin: Plugin.Function = (ctx: Context) => {
    const removeNamespace = ctx.tools.registerNamespace({
      name: catalog.namespace,
      description: catalog.label,
      external: true,
      status: "ready",
    });
    const removers = catalog.tools.map((tool) =>
      ctx.tools.register({
        name: tool.name,
        namespace: catalog.namespace,
        description: tool.description,
        inputSchema: tool.inputSchema,
        admission: {
          turnTypes: ["chat", "automation", "subagent"],
          subagentRoles: ["executor"],
        },
        // The provider does not offer execution idempotency. The Bot's outer
        // call_dynamic_tool intent therefore recovers as unknown, never repeats.
        idempotent: false,
        validate: object,
        execute: async (input, context) => {
          if (context.signal.aborted)
            return {
              content: "Action cancelled before dispatch",
              isError: true,
            };
          const result = await request({
            schemaVersion: 1,
            operation: "execute-tool",
            connectionId,
            toolName: tool.name,
            version: tool.version,
            arguments: input,
            effectId: context.effectId,
            sessionId: context.sessionId,
          });
          if (
            !object(result) ||
            typeof result.content !== "string" ||
            typeof result.isError !== "boolean"
          )
            throw new Error("Connected account returned an invalid result");
          return { content: result.content, isError: result.isError };
        },
      }),
    );
    return () => {
      for (const remove of removers.toReversed()) remove();
      removeNamespace();
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}

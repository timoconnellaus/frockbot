/**
 * Stands in for a plugin authored in a different package: it imports the keys
 * and the builders by value, declares the keys it needs, and never imports a
 * provider (A2, F3).
 */
import { createPlugin } from "@frockbot/compose-core";
import { createTool, toolsKey } from "../../src";
import { queryValidator } from "./validator";

/** A tool whose argument and result types travel with its definition (F1). */
export const lookupTool = createTool({
  name: "lookup",
  description: "Look a word up",
  validator: queryValidator,
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  execute: ({ query }) => ({ found: query.length }),
});

/** A plugin from "another package" that contributes one tool to whoever hosts it. */
export const lookupPlugin = createPlugin({
  name: "lookup-plugin",
  deps: [toolsKey],
  setup(instance) {
    instance.cleanup(instance.context.get(toolsKey).register(lookupTool));
  },
});

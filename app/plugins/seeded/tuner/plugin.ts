import type { PluginExecute, PluginTool } from "@frockbot/applet-sdk/plugin";

export const tools: PluginTool[] = [];

export const execute: PluginExecute = async (tool) => {
  throw new Error(`unknown tool ${tool}`);
};

export const views = {
  tuner: () => ({ a4: 440 }),
};

import type { PromptSection } from "@frockbot/agent-core";
import type { Plugin } from "cordis";

// This contribution is runtime-neutral and can mount in Node or Workers.
export const DEFAULT_IDENTITY_SECTION = "identity";
export const DEFAULT_IDENTITY_TEXT =
  "You are FrockBot running on the custom Cordis agent loop.";

export interface IdentityPluginConfig {
  sectionId?: string;
  text?: string;
  order?: number;
}

export function createIdentityPlugin(
  config: IdentityPluginConfig = {},
): Plugin.Function {
  const sectionId = config.sectionId?.trim() || DEFAULT_IDENTITY_SECTION;
  const text = config.text?.trim() || DEFAULT_IDENTITY_TEXT;
  const order = config.order ?? 0;
  if (!Number.isFinite(order)) {
    throw new Error("identity section order must be finite");
  }

  const section: PromptSection = {
    id: sectionId,
    order,
    render: () => text,
  };
  const plugin: Plugin.Function = (ctx) => ctx.systemPrompt.register(section);
  plugin.inject = ["systemPrompt"];
  return plugin;
}

const identityPlugin = createIdentityPlugin();

export default identityPlugin;

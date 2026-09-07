import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const botTemplateDefinitionV1: PackageDefinitionV1 = {
  id: "bot-template",
  displayName: "Bot templates",
  capabilities: [
    {
      id: "bot-template-export",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat"],
      },
    },
  ],
  dependencies: ["settings", "shell", "ui-theme"],
};

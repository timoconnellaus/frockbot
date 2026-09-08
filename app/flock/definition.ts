import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const flockDefinitionV1: PackageDefinitionV1 = {
  id: "flock",
  displayName: "Flock",
  capabilities: [
    {
      id: "bot-self-management",
      kind: "tool",
      connectionTypes: [],
    },
    {
      id: "bot-messaging",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat"],
      },
    },
  ],
  dependencies: ["shell", "ui-theme"],
};

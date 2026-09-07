import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const subagentsDefinitionV1: PackageDefinitionV1 = {
  id: "subagents",
  displayName: "Subagents",
  capabilities: [
    {
      id: "task-dispatch",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "automation"],
      },
    },
    {
      id: "task-lifecycle",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "automation"],
      },
    },
  ],
  dependencies: ["shell"],
};

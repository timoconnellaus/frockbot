import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const routinesDefinitionV1: PackageDefinitionV1 = {
  id: "routines",
  displayName: "Routines",
  capabilities: [
    {
      id: "routine-tools",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
    },
  ],
  dependencies: ["shell", "ui-theme"],
};

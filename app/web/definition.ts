import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const webDefinitionV1: PackageDefinitionV1 = {
  id: "web",
  displayName: "Web",
  capabilities: [
    {
      id: "web-fetch",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
    },
  ],
};

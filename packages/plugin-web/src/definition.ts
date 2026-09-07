import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const webDefinitionV1: PackageDefinitionV1 = {
  id: "web",
  displayName: "Web",
  capabilities: [
    {
      id: "web-fetch",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
    },
  ],
};

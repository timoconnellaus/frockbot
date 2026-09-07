import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const userMachineDefinitionV1: PackageDefinitionV1 = {
  id: "user-machine",
  displayName: "Registered machines",
  capabilities: [
    {
      id: "machine-registry",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
      },
    },
    {
      id: "machine-control",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat"],
      },
    },
  ],
  dependencies: ["shell", "ui-theme"],
};

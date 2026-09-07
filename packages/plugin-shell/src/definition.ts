import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const shellDefinitionV1: PackageDefinitionV1 = {
  id: "shell",
  displayName: "FrockBot",
  capabilities: [
    {
      id: "user-voice",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "agent"],
      },
    },
    {
      id: "parent-handoff",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["automation", "subagent"],
      },
    },
  ],
  dependencies: ["ui-theme"],
  platformOwned: true,
};

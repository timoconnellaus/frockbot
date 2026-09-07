import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const machineMessagesDefinitionV1: PackageDefinitionV1 = {
  id: "machine-messages",
  displayName: "Messages on your Mac",
  settings: [
    {
      id: "messages-enabled",
      schemaVersion: 1,
      scopes: ["user"],
      schema: {
        type: "boolean",
        title: "Messages.app tools",
        description:
          "Let a bot read and send iMessages through Messages.app on a registered Mac of yours. Off by default. Reading needs Full Disk Access and sending needs Automation rights, both granted on the Mac itself; sending always asks you to approve it first.",
      },
    },
  ],
  capabilities: [
    {
      id: "machine-messages",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat"],
      },
    },
  ],
  dependencies: ["user-machine"],
};

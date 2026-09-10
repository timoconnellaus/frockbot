import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

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
        title: "Allow Messages access",
        description:
          "Allow your Bots to read and send Messages through the directly downloaded FrockBot Mac app on your Mac. Requested message content, contacts and attachments are shared with FrockBot’s cloud and the AI providers used by your Bots. Off by default; enable only if you consent to that sharing. You must also consent in the Mac app and grant Full Disk Access and Automation on the Mac. Each send requires your approval of the recipient and exact text. Disable this setting or quit the Mac app to stop future access; this does not delete content already shared.",
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

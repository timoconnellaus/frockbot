import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const GROUP_MANAGEMENT_CAPABILITY_V1 = "group-management";

export const groupsDefinitionV1: PackageDefinitionV1 = {
  id: "groups",
  displayName: "Group Chats",
  capabilities: [
    {
      id: GROUP_MANAGEMENT_CAPABILITY_V1,
      kind: "tool",
      connectionTypes: [],
      // The Bot's own conversation and its Routines. Not a Turn some other
      // caller started — a group's own Turns speak to the group with a send,
      // and a Bot another Bot asked has no business rearranging groups.
      admission: {
        turnTypes: ["chat", "automation"],
      },
    },
  ],
  dependencies: ["shell"],
};

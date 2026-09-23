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
    {
      // `bot_message` inside a Group Chat Turn, which runs on the agent lane.
      // Offered only there, and only for a Bot outside the group: a member is
      // asked in the thread with an @mention.
      id: "group-bot-messaging",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["agent"],
      },
    },
    {
      id: "subagent-handoff",
      kind: "tool",
      connectionTypes: [],
      // Chat only, for the same reason `bot-messaging` is: a hand-off admits a
      // Turn on the `agent` lane, and offering the tool there too would open a
      // chain underneath one. The depth marker on the origin is the second
      // fence, for the day this ceiling widens.
      admission: {
        turnTypes: ["chat"],
      },
    },
  ],
  dependencies: ["shell", "ui-theme"],
};

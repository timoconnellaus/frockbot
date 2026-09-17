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

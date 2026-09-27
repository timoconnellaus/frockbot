import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

/** The Shell's manifest, all but its name. */
export const SHELL_PACKAGE_V1 = {
  id: "shell",
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
} satisfies Omit<PackageDefinitionV1, "displayName">;

/** The Shell is the product itself, so it carries the brand's name. */
export function shellDefinitionV1(productName: string): PackageDefinitionV1 {
  const { id, ...rest } = SHELL_PACKAGE_V1;
  return { id, displayName: productName, ...rest };
}

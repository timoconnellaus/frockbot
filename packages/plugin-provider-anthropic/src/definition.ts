import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const providerAnthropicDefinitionV1: PackageDefinitionV1 = {
  id: "provider-anthropic",
  displayName: "Anthropic",
  capabilities: [
    {
      id: "anthropic-models",
      kind: "model",
      connectionTypes: ["anthropic-account"],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
      },
    },
  ],
  connectionTypes: [
    {
      id: "anthropic-account",
      displayName: "Anthropic account",
      allowMultiple: true,
      authorization: {
        kind: "api-key",
        driverId: "anthropic",
      },
      capabilities: ["anthropic-models"],
      settings: [
        {
          id: "api-base-url",
          schemaVersion: 1,
          scopes: ["connection"],
          schema: {
            type: "string",
            title: "API base URL",
            description:
              "Root URL of the Anthropic Messages API, without a trailing slash. Absent means https://api.anthropic.com/v1.",
            minLength: 1,
            maxLength: 2048,
          },
        },
      ],
    },
  ],
  defaultEnablement: "disabled",
  dependencies: ["credentials", "settings"],
};

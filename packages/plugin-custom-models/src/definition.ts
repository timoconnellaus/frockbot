import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const customModelsDefinitionV1: PackageDefinitionV1 = {
  id: "custom-models",
  displayName: "Custom models",
  settings: [
    {
      id: "model",
      schemaVersion: 1,
      scopes: ["bot"],
      role: "model",
      schema: {
        type: "object",
        properties: {
          connectionId: {
            type: "string",
          },
          providerModelId: {
            type: "string",
          },
        },
        required: ["connectionId", "providerModelId"],
        additionalProperties: false,
      },
    },
  ],
  defaultEnablement: "disabled",
  dependencies: ["settings", "shell", "ui-theme"],
};

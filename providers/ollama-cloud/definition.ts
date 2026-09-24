import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const providerOllamaCloudDefinitionV1: PackageDefinitionV1 = {
  id: "provider-ollama-cloud",
  displayName: "Ollama Cloud",
  capabilities: [
    {
      id: "ollama-cloud-models",
      kind: "model",
      connectionTypes: ["ollama-cloud-account"],
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
      },
    },
  ],
  connectionTypes: [
    {
      id: "ollama-cloud-account",
      displayName: "Ollama Cloud account",
      icon: "ollama",
      allowMultiple: true,
      authorization: {
        kind: "api-key",
        driverId: "ollama-cloud",
      },
      capabilities: ["ollama-cloud-models"],
      settings: [
        {
          id: "api-base-url",
          schemaVersion: 1,
          scopes: ["connection"],
          schema: {
            type: "string",
            title: "API base URL",
            description:
              "Root URL of the Ollama-compatible endpoint, without a trailing slash. Absent means https://ollama.com; use http://127.0.0.1:11434 for a local Ollama server.",
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

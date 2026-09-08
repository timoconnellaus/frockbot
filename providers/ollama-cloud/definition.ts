import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const providerOllamaCloudDefinitionV1: PackageDefinitionV1 = {
  id: "provider-ollama-cloud",
  displayName: "Ollama Cloud",
  settings: [
    {
      id: "web-search-max-results",
      schemaVersion: 1,
      scopes: ["user"],
      schema: {
        type: "integer",
        title: "Maximum web search results",
        description:
          "How many results a Bot's web search returns at most, however many it asks for. Leave this empty to use the default of 5.",
        minimum: 1,
        maximum: 10,
      },
    },
  ],
  capabilities: [
    {
      id: "ollama-cloud-models",
      kind: "model",
      connectionTypes: ["ollama-cloud-account"],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
      },
    },
    {
      id: "ollama-cloud-web-search",
      kind: "tool",
      connectionTypes: ["ollama-cloud-account"],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
    },
  ],
  connectionTypes: [
    {
      id: "ollama-cloud-account",
      displayName: "Ollama Cloud account",
      allowMultiple: true,
      authorization: {
        kind: "api-key",
        driverId: "ollama-cloud",
      },
      capabilities: ["ollama-cloud-models", "ollama-cloud-web-search"],
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
  dependencies: ["credentials", "settings", "web"],
};

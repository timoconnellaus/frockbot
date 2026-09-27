import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

/** The built-in model, named by the brand. */
export function providerFlockAiDefinitionV1(
  builtInModelName: string,
): PackageDefinitionV1 {
  return {
    id: "provider-flock-ai",
    displayName: builtInModelName,
    capabilities: [
      {
        id: "flock-ai-models",
        kind: "model",
        connectionTypes: ["flock-ai-account"],
        admission: {
          turnTypes: ["chat", "agent", "automation", "subagent"],
        },
      },
    ],
    connectionTypes: [
      {
        id: "flock-ai-account",
        displayName: builtInModelName,
        allowMultiple: false,
        authorization: {
          kind: "ambient-native",
        },
        capabilities: ["flock-ai-models"],
      },
    ],
    dependencies: ["settings"],
    platformOwned: true,
  };
}

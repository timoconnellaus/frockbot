import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const providerFlockAiDefinitionV1: PackageDefinitionV1 = {
  id: "provider-flock-ai",
  displayName: "Frock AI",
  capabilities: [
    {
      id: "flock-ai-models",
      kind: "model",
      connectionTypes: ["flock-ai-account"],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
      },
    },
  ],
  connectionTypes: [
    {
      id: "flock-ai-account",
      displayName: "Frock AI",
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

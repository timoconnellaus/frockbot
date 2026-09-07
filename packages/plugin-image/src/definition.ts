import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const imageDefinitionV1: PackageDefinitionV1 = {
  id: "image",
  displayName: "Image generation",
  settings: [
    {
      id: "model",
      schemaVersion: 1,
      scopes: ["user", "bot"],
      schema: {
        type: "string",
        title: "Image model",
        description:
          "Which model your Bots use to make images. Uses a fast default if you don't pick one.",
        enum: [
          "@cf/black-forest-labs/flux-1-schnell",
          "@cf/black-forest-labs/flux-2-klein-4b",
          "@cf/stabilityai/stable-diffusion-xl-base-1.0",
          "@cf/bytedance/stable-diffusion-xl-lightning",
        ],
      },
    },
  ],
  capabilities: [
    {
      id: "image-generation",
      kind: "tool",
      connectionTypes: [],
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
    },
  ],
  roots: [
    {
      id: "generated",
      scope: "user",
    },
  ],
};

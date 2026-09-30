import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

import {
  LOCAL_MODEL_CONNECTION_TYPE_ID,
  LOCAL_MODEL_ENDPOINT_SETTING,
  LOCAL_MODEL_MACHINE_SETTING,
  LOCAL_MODEL_PACKAGE_ID,
} from "./endpoint.js";

export const providerLocalModelDefinitionV1: PackageDefinitionV1 = {
  id: LOCAL_MODEL_PACKAGE_ID,
  displayName: "Local models",
  capabilities: [
    {
      id: "local-models",
      kind: "model",
      connectionTypes: [LOCAL_MODEL_CONNECTION_TYPE_ID],
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
      },
    },
  ],
  connectionTypes: [
    {
      id: LOCAL_MODEL_CONNECTION_TYPE_ID,
      displayName: "Model server on your Mac",
      description:
        "Ollama, LM Studio, mesh-llm or another OpenAI-compatible server running on your Mac, reached through the FrockBot app. Free to use.",
      icon: "ollama",
      allowMultiple: true,
      authorization: { kind: "none" },
      capabilities: ["local-models"],
      settings: [
        {
          id: LOCAL_MODEL_MACHINE_SETTING,
          schemaVersion: 1,
          scopes: ["connection"],
          schema: {
            type: "string",
            title: "Mac",
            description: "The paired Mac the model server runs on.",
            minLength: 1,
            maxLength: 128,
          },
        },
        {
          id: LOCAL_MODEL_ENDPOINT_SETTING,
          schemaVersion: 1,
          scopes: ["connection"],
          schema: {
            type: "string",
            title: "Endpoint",
            description:
              "The server's OpenAI-compatible address on that Mac, such as http://localhost:11434/v1 for Ollama.",
            minLength: 1,
            maxLength: 2048,
          },
        },
      ],
    },
  ],
  defaultEnablement: "disabled",
  dependencies: ["settings"],
};

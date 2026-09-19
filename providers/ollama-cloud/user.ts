import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";

import {
  modelConnectionLifecycleV1,
  type ModelConnectionsUserApplicationHostV1,
  type ModelConnectionUserBackendHostV1,
} from "../model-connections/user.js";
import { decodeOllamaApiBaseUrl, OllamaCloudClient } from "./client.js";
import { OLLAMA_CLOUD_PROVIDER } from "./runtime.js";

/**
 * Ollama names models bare (`gpt-oss:20b`, `glm-5.1`). The preferred model is
 * routinely available and cheap to probe; the neutral lifecycle falls back to
 * the first discovered model when it is absent.
 */
export const OllamaCloudUserBackendContribution = modelConnectionLifecycleV1({
  packageId: "provider-ollama-cloud",
  displayName: "Ollama Cloud",
  storageLabel: "Ollama",
  connectionLabel: "Ollama",
  connectionTypeId: "ollama-cloud-account",
  providerType: OLLAMA_CLOUD_PROVIDER,
  storagePrefix: "ollama",
  apiBaseUrl: {
    settingKey: "api-base-url",
    decode: decodeOllamaApiBaseUrl,
  },
  preferredProbeModelId: "gpt-oss:20b",
  createClient: (config) => new OllamaCloudClient(config),
});

export type OllamaCloudUserBackendContribution = InstanceType<
  typeof OllamaCloudUserBackendContribution
>;

export function createOllamaCloudUserBackendContribution(
  host: ModelConnectionUserBackendHostV1,
): OllamaCloudUserBackendContribution {
  return new OllamaCloudUserBackendContribution(host);
}

/** The manifest's User entry, resolved from the application's contribution table. */
export const userContribution = defineUserBackendContribution<
  ModelConnectionsUserApplicationHostV1,
  OllamaCloudUserBackendContribution
>({
  specifier: "@frockbot/providers/ollama-cloud/user",
  mount: (host, lifecycle) =>
    lifecycle.mount(
      createOllamaCloudUserBackendContribution(host.modelConnections),
    ),
});

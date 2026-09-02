/**
 * Durable records reconstructed from the last pre-account-wide model shape
 * (eb0283) and the stranded platform binding introduced during that rollout
 * (1571b62). Keeping these as raw objects is intentional: decoding them before
 * storage would erase the historical fields the migration must encounter.
 */

export const LEGACY_SETTINGS_STATE_KEY = "user-configuration";
export const LEGACY_DEFAULT_PACKAGES_MARKER_KEY =
  "user-default-packages-bootstrap:v1";

export const LEGACY_OLLAMA_CONNECTION_ID = "ollama-legacy";
export const LEGACY_OLLAMA_MODEL_ID = "glm-5.3-flash:cloud";

export function legacyUserSettingsRecordV1(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 12,
    profile: { name: "Legacy User" },
    packages: [
      {
        packageId: "provider-workers-ai",
        version: "0.0.1",
        state: "installed",
      },
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        state: "installed",
      },
    ],
    connections: [
      {
        connectionId: "workers-ai-ambient",
        packageId: "provider-workers-ai",
        connectionTypeId: "workers-ai-account",
        displayName: "Cloudflare Workers AI",
        state: "ready",
        generation: "workers-ai-ambient-v1",
        providerType: "workers-ai",
        authorization: {
          schemaVersion: 1,
          kind: "ambient-native",
          credential: {
            schemaVersion: 1,
            configured: true,
            source: "ambient-native",
            writable: false,
            generation: "workers-ai-ambient-v1",
          },
        },
        modelCatalog: {
          schemaVersion: 1,
          generation: "workers-ai-static-v1",
          state: "fresh",
          models: [
            {
              providerModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
              displayName: "DeepSeek V4 Flash",
              capabilities: { tools: true, vision: false, reasoning: true },
              source: "discovered",
            },
          ],
        },
        safeMetadata: { catalog: "static" },
      },
      {
        connectionId: LEGACY_OLLAMA_CONNECTION_ID,
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        displayName: "Ollama",
        state: "ready",
        generation: "ollama-generation-1",
        providerType: "ollama-cloud",
        authorization: {
          schemaVersion: 1,
          kind: "api-key",
          credential: {
            schemaVersion: 1,
            configured: true,
            source: "api-key",
            writable: true,
            generation: "ollama-generation-1",
          },
        },
        modelCatalog: {
          schemaVersion: 1,
          generation: "ollama-catalog-1",
          state: "fresh",
          models: [
            {
              providerModelId: LEGACY_OLLAMA_MODEL_ID,
              displayName: "GLM 5.3 Flash",
              capabilities: { tools: true, vision: false, reasoning: true },
              source: "discovered",
            },
          ],
        },
        safeMetadata: {
          dependentAssignments: [
            {
              botId: "primary",
              generation: "assignment-1",
              packageId: "provider-ollama-cloud",
              capabilityId: "ollama-cloud-models",
              claimOrder: 1,
              status: "acknowledged",
            },
          ],
        },
      },
    ],
    // Workers AI originally wrote `newBotModelTemplate`; the additional
    // platform binding is the stranded post-rollout projection reported by
    // the affected account and is deliberately preserved in this raw fixture.
    platformModel: {
      connectionId: "workers-ai-ambient",
      providerModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    },
    newBotModelTemplate: {
      connectionId: LEGACY_OLLAMA_CONNECTION_ID,
      providerModelId: LEGACY_OLLAMA_MODEL_ID,
    },
    newBotModelTemplateSource: "user",
  };
}

export function legacyBotSettingsRecordV1(
  botId = "primary",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    botId,
    revision: 4,
    profile: { name: "Primary" },
    notifications: { enabled: true },
    assignments: [
      {
        assignmentId: "ollama-model",
        packageId: "provider-ollama-cloud",
        capabilityId: "ollama-cloud-models",
        connectionId: LEGACY_OLLAMA_CONNECTION_ID,
        state: "enabled",
      },
    ],
    assignmentOperations: [],
    model: {
      connectionId: LEGACY_OLLAMA_CONNECTION_ID,
      providerModelId: LEGACY_OLLAMA_MODEL_ID,
    },
  };
}

export function legacyDefaultPackagesMarkerV1(): Record<string, unknown> {
  return { schemaVersion: 1 };
}

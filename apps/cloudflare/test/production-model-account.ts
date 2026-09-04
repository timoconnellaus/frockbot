import productionSettingsRevision38 from "./production-settings-revision-38.json" with { type: "json" };

/**
 * The owner's live `/api/settings` projection after v0.2.3. The JSON fixture is
 * kept byte-for-byte as captured; these helpers only separate the fields that
 * are stored under different Durable Object keys from the settings record.
 */
export const PRODUCTION_SETTINGS_STATE_KEY = "user-configuration";
export const PRODUCTION_DEFAULT_PACKAGES_MARKER_KEY =
  "user-default-packages-bootstrap:v1";
export const PRODUCTION_FROCK_BOOTSTRAP_MARKER_KEY =
  "provider-flock-ai:bootstrap-v1";
export const PRODUCTION_CATALOG_PIN_KEY = "user-catalog-pin";

export const PRODUCTION_OLLAMA_CONNECTION_ID =
  "connection-2f57547a-cfd9-4744-a9b8-1dbdddae1593";
export const PRODUCTION_OLLAMA_MODEL_ID = "glm-5.3-flash";

export function productionUserSettingsRecordV1(): Record<string, unknown> {
  const stored = structuredClone(productionSettingsRevision38) as Record<
    string,
    unknown
  >;
  // These two values are projected from `user-catalog-pin`; they are not part
  // of the raw `user-configuration` record.
  delete stored.catalogGeneration;
  delete stored.catalogIndexHash;
  return stored;
}

export function productionDefaultPackagesMarkerV2(): Record<string, unknown> {
  return { schemaVersion: 2 };
}

export function productionFrockBootstrapMarkerV1(
  userId: string,
): Record<string, unknown> {
  return { schemaVersion: 1, userId };
}

export function productionCatalogPinV1(): Record<string, unknown> {
  return {
    generation: productionSettingsRevision38.catalogGeneration,
    indexHash: productionSettingsRevision38.catalogIndexHash,
  };
}

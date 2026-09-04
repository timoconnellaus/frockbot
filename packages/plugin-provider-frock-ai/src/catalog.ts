import type { ConnectionModelCatalogV1 } from "@frockbot/connection-core";

// The provider is Frock AI. Its *stored* identity strings still read `flock-`:
// every existing User has them written into their Connection, their installed
// Package list and their Bots' model bindings, and renaming a stored id is a
// data migration rather than a rename. They are never shown to a person — the
// display name and the model ids are, and those moved.
export const FROCK_AI_PACKAGE_ID = "provider-flock-ai";
export const FROCK_AI_CONNECTION_TYPE_ID = "flock-ai-account";
export const FROCK_AI_CAPABILITY_ID = "flock-ai-models";
export const FROCK_AI_PROVIDER_TYPE = "flock-ai";
export const FROCK_AI_CONNECTION_ID = "flock-ai-ambient";
export const FROCK_AI_CONNECTION_GENERATION = "flock-ai-ambient-v1";
export const FROCK_AI_DEFAULT_MODEL = "@frock/auto";
/**
 * The Cloudflare AI Gateway dynamic route. The dashboard resource is still
 * named `flock-auto`; the value is the resource's name, not ours.
 */
export const FROCK_AI_DEFAULT_AUTO_ROUTE = "flock-auto";

/** The pre-rename model-id prefix. Bots bound before the rename still carry it. */
export const FROCK_AI_LEGACY_MODEL_PREFIX = "@flock/";
export const FROCK_AI_MODEL_PREFIX = "@frock/";

/**
 * Read a Frock AI model id, accepting the pre-rename `@flock/` spelling.
 * Every decode and resolution path runs ids through this, so a Bot bound to
 * `@flock/auto` behaves exactly as one bound to `@frock/auto`; nothing writes
 * the legacy prefix back.
 */
export function normalizeFrockModelIdV1(id: string): string {
  return id.startsWith(FROCK_AI_LEGACY_MODEL_PREFIX)
    ? `${FROCK_AI_MODEL_PREFIX}${id.slice(FROCK_AI_LEGACY_MODEL_PREFIX.length)}`
    : id;
}

/** Whether an id names a Frock AI model under either spelling. */
export function isFrockModelIdV1(id: string): boolean {
  const normalized = normalizeFrockModelIdV1(id);
  return (
    normalized.startsWith(FROCK_AI_MODEL_PREFIX) &&
    normalized.length > FROCK_AI_MODEL_PREFIX.length
  );
}

const CLOUDFLARE_TEXT_MODELS = [
  {
    cloudflareModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    displayName: "DeepSeek V4 Flash",
    capabilities: { tools: true, vision: false, reasoning: true },
  },
] as const;

export function frockModelIdForCloudflareIdV1(id: string): string {
  if (!id.startsWith("@cf/") || id.length === "@cf/".length) {
    throw new Error(`Cloudflare model id "${id}" must start with "@cf/"`);
  }
  return `@frock/${id.slice("@cf/".length)}`;
}

export function cloudflareModelIdForFrockIdV1(input: string): string {
  const id = normalizeFrockModelIdV1(input);
  if (!isFrockModelIdV1(id)) {
    throw new Error(`Frock AI model id "${input}" must start with "@frock/"`);
  }
  if (id === FROCK_AI_DEFAULT_MODEL) {
    throw new Error("Frock AI Auto does not name a Cloudflare model");
  }
  return `@cf/${id.slice(FROCK_AI_MODEL_PREFIX.length)}`;
}

export function gatewayModelForFrockIdV1(
  input: string,
  autoRoute = FROCK_AI_DEFAULT_AUTO_ROUTE,
): string {
  const id = normalizeFrockModelIdV1(input);
  if (!isFrockModelIdV1(id)) {
    throw new Error(`Frock AI model id "${input}" must start with "@frock/"`);
  }
  if (id === FROCK_AI_DEFAULT_MODEL) {
    if (!/^[A-Za-z0-9-]+$/.test(autoRoute)) {
      throw new Error(`Frock AI Auto route "${autoRoute}" is invalid`);
    }
    return `dynamic/${autoRoute}`;
  }
  return `workers-ai/${cloudflareModelIdForFrockIdV1(id)}`;
}

const STATIC_CATALOG: ConnectionModelCatalogV1 = {
  schemaVersion: 1,
  generation: "flock-ai-static-v1",
  state: "fresh",
  models: [
    {
      providerModelId: FROCK_AI_DEFAULT_MODEL,
      displayName: "Auto (recommended)",
      capabilities: { tools: true, vision: false, reasoning: true },
      source: "discovered",
    },
    ...CLOUDFLARE_TEXT_MODELS.map((model) => ({
      providerModelId: frockModelIdForCloudflareIdV1(model.cloudflareModelId),
      displayName: model.displayName,
      capabilities: model.capabilities,
      source: "discovered" as const,
    })),
  ],
};

/** A deployment-safe advisory catalog; it requires no account token or REST call. */
export function frockAiStaticCatalogV1(): ConnectionModelCatalogV1 {
  return structuredClone(STATIC_CATALOG);
}

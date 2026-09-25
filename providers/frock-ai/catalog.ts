import type { ConnectionModelCatalogV1 } from "@frockbot/core/connection";

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
/**
 * The model conversation summaries run on, whatever model the Bot itself is
 * on. Never listed in the catalog: nobody picks it, the platform does.
 */
export const FROCK_AI_SUMMARY_MODEL = "@frock/structured";
/** The AI Gateway dynamic route behind {@link FROCK_AI_SUMMARY_MODEL}. */
export const FROCK_AI_SUMMARY_ROUTE = "frock-structured";
/**
 * The specialists a Bot on Frock AI may hand work to: each a model id no one
 * picks for a Bot, backed by a Gateway dynamic route whose target is chosen in
 * the dashboard like Auto's. A specialty is offered only once the deployment
 * prices its route (docs/billing.md), so an unconfigured one is never called.
 */
export const FROCK_AI_SPECIALTIES_V1 = [
  {
    name: "writing",
    model: "@frock/writing",
    route: "frock-writing",
    summary:
      "Writing the person will read at length: emails, documents, posts, stories.",
  },
  {
    name: "coding",
    model: "@frock/coding",
    route: "frock-coding",
    summary: "Code: Plugins, scripts, and fixes on the Computer.",
  },
  {
    name: "thinking",
    model: "@frock/thinking",
    route: "frock-thinking",
    summary: "Plans, maths and hard decisions that need careful reasoning.",
  },
  {
    name: "vision",
    model: "@frock/vision",
    route: "frock-vision",
    summary: "Photos, screenshots and PDFs: anything that has to be seen.",
  },
] as const;

export type FrockAiSpecialtyV1 = (typeof FROCK_AI_SPECIALTIES_V1)[number];

/** The specialty a Frock AI model id names, if it names one. */
export function frockAiSpecialtyV1(
  input: string,
): FrockAiSpecialtyV1 | undefined {
  const id = normalizeFrockModelIdV1(input);
  return FROCK_AI_SPECIALTIES_V1.find((specialty) => specialty.model === id);
}

/** Workers AI model selected when Auto must honor a JSON Schema request. */
export const FROCK_AI_STRUCTURED_MODEL =
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/**
 * What Auto is on a deployment with no AI Gateway route.
 *
 * The `AI` binding reaches the Gateway's *universal* endpoint, whose
 * request-shape translation rejects a `dynamic/<route>` model before inference
 * runs (cloudflare/ai#617). So a deployment without Gateway credentials cannot
 * have a routed Auto, and pinning the catalog's own chat model is what keeps
 * "the platform picks the model" true there: the same model a User would
 * otherwise have to choose by hand, and the only `@cf/` chat model this
 * deployment offers.
 */
export const FROCK_AI_BINDING_AUTO_MODEL =
  "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731";

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

/**
 * `autoRoute` is `null` on a transport that cannot carry a dynamic route — the
 * `AI` binding — where Auto is a concrete Workers AI model instead.
 */
export function gatewayModelForFrockIdV1(
  input: string,
  autoRoute: string | null = FROCK_AI_DEFAULT_AUTO_ROUTE,
): string {
  const id = normalizeFrockModelIdV1(input);
  if (!isFrockModelIdV1(id)) {
    throw new Error(`Frock AI model id "${input}" must start with "@frock/"`);
  }
  if (id === FROCK_AI_SUMMARY_MODEL) {
    // The binding path has no routes; its Auto model has the context a
    // summary needs.
    return autoRoute === null
      ? FROCK_AI_BINDING_AUTO_MODEL
      : `dynamic/${FROCK_AI_SUMMARY_ROUTE}`;
  }
  const specialty = frockAiSpecialtyV1(id);
  if (specialty) {
    return autoRoute === null
      ? FROCK_AI_BINDING_AUTO_MODEL
      : `dynamic/${specialty.route}`;
  }
  if (id === FROCK_AI_DEFAULT_MODEL) {
    if (autoRoute === null) return FROCK_AI_BINDING_AUTO_MODEL;
    if (!/^[A-Za-z0-9-]+$/.test(autoRoute)) {
      throw new Error(`Frock AI Auto route "${autoRoute}" is invalid`);
    }
    return `dynamic/${autoRoute}`;
  }
  return `workers-ai/${cloudflareModelIdForFrockIdV1(id)}`;
}

/** Auto routes ordinary chat dynamically and pins schema work to a capable model. */
export function gatewayModelForFrockRequestV1(
  input: string,
  structured: boolean,
  autoRoute: string | null = FROCK_AI_DEFAULT_AUTO_ROUTE,
): string {
  const id = normalizeFrockModelIdV1(input);
  return structured && id === FROCK_AI_DEFAULT_MODEL
    ? FROCK_AI_STRUCTURED_MODEL
    : gatewayModelForFrockIdV1(id, autoRoute);
}

const STATIC_CATALOG: ConnectionModelCatalogV1 = {
  schemaVersion: 1,
  generation: "flock-ai-static-v1",
  state: "fresh",
  models: [
    {
      providerModelId: FROCK_AI_DEFAULT_MODEL,
      displayName: "Auto (recommended)",
      capabilities: { tools: true, vision: true, reasoning: true },
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

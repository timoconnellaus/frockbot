import {
  type AgentRuntimeV1,
  type PromptSection,
  type RuntimeFeatureV1,
} from "@frockbot/core/contracts";

// This contribution is runtime-neutral and can mount in Node or Workers.
export const DEFAULT_IDENTITY_SECTION = "identity";
/** Who the model is told it is, in the brand's words. */
export function defaultIdentityTextV1(productName: string): string {
  return `You are ${productName} running on the custom agent loop.`;
}

export interface IdentityFeatureConfig {
  /** The product's name, which the default identity names. */
  productName: string;
  sectionId?: string;
  text?: string;
  order?: number;
}

export function createIdentityFeature(
  config: IdentityFeatureConfig,
): RuntimeFeatureV1<AgentRuntimeV1> {
  const sectionId = config.sectionId?.trim() || DEFAULT_IDENTITY_SECTION;
  const text = config.text?.trim() || defaultIdentityTextV1(config.productName);
  const order = config.order ?? 0;
  if (!Number.isFinite(order)) {
    throw new Error("identity section order must be finite");
  }

  const section: PromptSection = {
    id: sectionId,
    order,
    render: () => text,
  };
  return (runtime) => runtime.systemPrompt.register(section);
}

import {
  type AgentRuntimeV1,
  type PromptSection,
  type RuntimeFeatureV1,
} from "@frockbot/kernel-contracts";

// This contribution is runtime-neutral and can mount in Node or Workers.
export const DEFAULT_IDENTITY_SECTION = "identity";
export const DEFAULT_IDENTITY_TEXT =
  "You are FrockBot running on the custom agent loop.";

export interface IdentityFeatureConfig {
  sectionId?: string;
  text?: string;
  order?: number;
}

export function createIdentityFeature(
  config: IdentityFeatureConfig = {},
): RuntimeFeatureV1<AgentRuntimeV1> {
  const sectionId = config.sectionId?.trim() || DEFAULT_IDENTITY_SECTION;
  const text = config.text?.trim() || DEFAULT_IDENTITY_TEXT;
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

const identityFeature = createIdentityFeature();

export default identityFeature;

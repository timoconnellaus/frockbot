import type { ModelAssignment } from "@frockbot/configuration-core";

export function resolveBotSettingsModel(input: {
  current?: ModelAssignment;
  useExactModel: boolean;
  selectedModel: string;
  exactConnectionId: string;
  exactProviderModelId: string;
}): ModelAssignment | undefined {
  if (input.useExactModel) {
    const selected = {
      connectionId: input.exactConnectionId,
      providerModelId: input.exactProviderModelId.trim(),
    };
    if (!selected.connectionId || !selected.providerModelId) {
      throw new Error("A Connection and model ID are required");
    }
    return selected;
  }
  if (!input.selectedModel) return input.current;
  let value: unknown;
  try {
    value = JSON.parse(input.selectedModel);
  } catch {
    throw new Error("A Connection and model ID are required");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    value[0].length === 0 ||
    typeof value[1] !== "string" ||
    value[1].length === 0
  ) {
    throw new Error("A Connection and model ID are required");
  }
  return { connectionId: value[0], providerModelId: value[1] };
}

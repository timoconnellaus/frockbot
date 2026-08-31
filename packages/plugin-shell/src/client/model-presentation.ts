/**
 * The model line the shell shows above the composer. It names the model the
 * Bot actually runs on, whether that model is the Bot's own override or the
 * User's default: a Bot that "just works" does not advertise where its
 * settings came from.
 */
export function modelRuntimeLabel(input: {
  modelDisplayName?: string;
  providerModelId?: string;
  packageDisplayName?: string;
  connectionDisplayName?: string;
  hasModel: boolean;
}): string {
  if (!input.hasModel) return "No default model";
  const model =
    input.modelDisplayName ?? input.providerModelId ?? "Connected model";
  const provider = input.packageDisplayName ?? input.connectionDisplayName;
  return provider ? `${model} · ${provider}` : model;
}

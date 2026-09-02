/**
 * The model line the shell shows above the composer. Platform choices read as
 * the model itself; opting into an account choice or Bot override makes that
 * distinction visible. A resolver failure is already the backend's complete,
 * repairable explanation, so the client presents it verbatim.
 */
export function modelRuntimeLabel(input: {
  source: "bot" | "account" | "platform" | "none";
  modelDisplayName?: string;
  providerModelId?: string;
  packageDisplayName?: string;
  connectionDisplayName?: string;
  failure?: string;
}): string {
  if (input.failure) return input.failure;
  if (input.source === "none" || !input.providerModelId) {
    return "Model unavailable";
  }
  const model =
    input.modelDisplayName ?? input.providerModelId ?? "Connected model";
  const provider = input.packageDisplayName ?? input.connectionDisplayName;
  const runtime = provider ? `${model} · ${provider}` : model;
  if (input.source === "bot") return `${runtime} · Bot override`;
  if (input.source === "account") return `${runtime} · Account model`;
  return runtime;
}

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
  /**
   * The chosen model could not bind — its provider Package is off, or its
   * Connection is gone — and the platform default is answering in its place.
   */
  fallback?: boolean;
}): string {
  if (input.failure) return input.failure;
  if (input.source === "none" || !input.providerModelId) {
    return "No model available — set one up in Models";
  }
  const model =
    input.modelDisplayName ?? input.providerModelId ?? "Connected model";
  const provider = input.packageDisplayName ?? input.connectionDisplayName;
  const runtime = provider ? `${model} · ${provider}` : model;
  if (input.source === "bot") return `${runtime} · this Bot only`;
  if (input.source === "account") return `${runtime} · Account model`;
  if (input.fallback) return `${runtime} · your chosen model is unavailable`;
  return runtime;
}

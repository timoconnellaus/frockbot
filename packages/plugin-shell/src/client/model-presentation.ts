export function modelRuntimeLabel(input: {
  packageDisplayName?: string;
  connectionDisplayName?: string;
  hasModel: boolean;
}): string {
  if (input.packageDisplayName) {
    return `${input.packageDisplayName} · Dynamic Worker`;
  }
  if (input.connectionDisplayName) {
    return `${input.connectionDisplayName} · Dynamic Worker`;
  }
  return input.hasModel
    ? "Connected model · Dynamic Worker"
    : "Model not configured · Dynamic Worker";
}

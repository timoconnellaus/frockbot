export function formatCostV1(costMicros: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(costMicros / 1_000_000);
}

export function shortModelNameV1(value: string): string {
  const slash = value.indexOf("/");
  return slash < 0 ? value : value.slice(slash + 1);
}

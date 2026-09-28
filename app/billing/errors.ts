/**
 * What billing refuses with, and how it fingerprints what it was asked. Apart
 * from the ledger so a payments Package can refuse in the same words and
 * statuses without reaching ledger storage.
 */
export class BillingError extends Error {
  constructor(
    message: string,
    readonly status = 402,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

/** Canonical JSON: keys sorted, `undefined` dropped. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

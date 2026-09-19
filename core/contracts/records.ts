/** Exact object-shape primitives shared by contract decoders. */

/** Require a non-null, non-array object record. */
export function recordV1(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Require every required key and reject every key outside the allow-list. */
export function exactKeysV1(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

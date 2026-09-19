/**
 * Turns a Durable Object RPC result into the plain JSON DTO its decoder
 * expects. Workers RPC results can carry runtime-owned properties, so a
 * boundary decoder must inspect the serialized value rather than the live
 * result.
 */
export function rpcJsonSnapshotV1<T>(value: T, label = "RPC response"): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`${label} is not a JSON value`);
    }
    return JSON.parse(serialized) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `${label} is not a JSON value`
    ) {
      throw error;
    }
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

/** A non-null, non-array object at an RPC boundary. */
export function rpcRecordV1(
  value: unknown,
  label = "RPC response",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

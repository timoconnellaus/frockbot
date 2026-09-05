import validators from "./validators.generated.js";
import type { ProtocolTypes } from "./types.generated.js";
export type * from "./types.generated.js";
export * from "./compatibility.generated.js";

/** Structural validation only; authorization and cross-record checks stay at the owner. */
export function isProtocolValue<K extends keyof ProtocolTypes>(
  name: K,
  value: unknown,
): value is ProtocolTypes[K] {
  const validate = validators[`is${name}` as keyof typeof validators];
  try {
    return validate(value);
  } catch {
    return false;
  }
}
export function decodeProtocol<K extends keyof ProtocolTypes>(
  name: K,
  value: unknown,
): ProtocolTypes[K] {
  if (!isProtocolValue(name, value)) throw new Error(`Invalid ${name}`);
  return structuredClone(value);
}

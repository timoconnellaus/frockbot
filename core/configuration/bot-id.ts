import { isPublicIdentifier } from "./identifiers.js";

export function isBotIdV1(value: unknown): value is string {
  return isPublicIdentifier(value);
}

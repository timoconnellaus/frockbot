// One canonical serialization and one digest, shared by everything that
// content-addresses a record: a Composition generation's member list and the
// module set a Bot isolate mounts. Both sides of a hash comparison have to
// agree byte for byte, so there is exactly one implementation.

import { sha256HexTextV1 } from "../crypto.js";

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("canonical data must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new Error("canonical data must be JSON serializable");
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export async function sha256(value: string): Promise<string> {
  return sha256HexTextV1(value);
}

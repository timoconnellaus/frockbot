const PUBLIC_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const RESERVED_CONNECTION_IDENTIFIERS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

export function isPublicIdentifier(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_IDENTIFIER_PATTERN.test(value);
}

export function isConnectionIdentifier(value: unknown): value is string {
  return (
    isPublicIdentifier(value) && !RESERVED_CONNECTION_IDENTIFIERS.has(value)
  );
}

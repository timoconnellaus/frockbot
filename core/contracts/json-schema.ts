// The JSON Schema subset the kernel itself validates against.
//
// A Plugin card declares the values the Bot must send as a JSON Schema
// (ADR 0030), and the kernel checks the Bot's values against it before the
// Plugin ever sees them. That check is here rather than in a library because
// of what it must promise: a constraint the kernel cannot enforce is never
// quietly ignored. A schema using a keyword this module does not know is
// refused outright, so a card whose schema says `pattern` is a card that does
// not draw rather than a card whose pattern nobody checked.
//
// The subset is what a card's values actually are — objects of strings,
// numbers, booleans and arrays of them — and deliberately not a validator
// anyone could mistake for a complete one.

/** The keywords this validator understands. Anything else is refused. */
const KNOWN_KEYWORDS_V1 = [
  "type",
  "title",
  "description",
  "default",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
] as const;

const KNOWN_TYPES_V1 = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;

/** How deep a card's values may nest. A card is a thing, not a document. */
const MAX_SCHEMA_DEPTH_V1 = 8;

export class JsonSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSchemaError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const NUMERIC_KEYWORDS_V1 = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
] as const;

/**
 * Whether `schema` is a schema this module can enforce whole, raising
 * `JsonSchemaError` naming the part that it cannot.
 *
 * Called where a schema is declared rather than where a value arrives, so a
 * card whose schema says `pattern` is refused at decode instead of drawing
 * fine until the Bot happens to fill that field. The two walks share the
 * keyword and type tables, so what is enforceable is stated once.
 */
export function assertEnforceableJsonSchemaV1(
  schema: unknown,
  path = "schema",
  depth = 0,
): void {
  if (depth > MAX_SCHEMA_DEPTH_V1) {
    throw new JsonSchemaError(
      `${path} nests deeper than ${MAX_SCHEMA_DEPTH_V1}`,
    );
  }
  const declared = record(schema);
  if (!declared) throw new JsonSchemaError(`${path} is not a schema`);
  for (const keyword of Object.keys(declared)) {
    if (
      !KNOWN_KEYWORDS_V1.includes(keyword as (typeof KNOWN_KEYWORDS_V1)[number])
    ) {
      throw new JsonSchemaError(
        `${path} declares "${keyword}", which this deployment does not enforce`,
      );
    }
  }
  const type = declared.type;
  if (
    typeof type !== "string" ||
    !KNOWN_TYPES_V1.includes(type as (typeof KNOWN_TYPES_V1)[number])
  ) {
    throw new JsonSchemaError(`${path} does not declare a known type`);
  }
  for (const keyword of NUMERIC_KEYWORDS_V1) {
    if (
      declared[keyword] !== undefined &&
      typeof declared[keyword] !== "number"
    ) {
      throw new JsonSchemaError(`${path}.${keyword} must be a number`);
    }
  }
  if (declared.enum !== undefined && !Array.isArray(declared.enum)) {
    throw new JsonSchemaError(`${path}.enum must be an array`);
  }
  if (declared.required !== undefined) {
    if (
      !Array.isArray(declared.required) ||
      declared.required.some((name) => typeof name !== "string")
    ) {
      throw new JsonSchemaError(`${path}.required must be names`);
    }
  }
  // Only the boolean form: a sub-schema here is a constraint the value walk
  // would quietly ignore, which is the one thing this module promises not to.
  if (
    declared.additionalProperties !== undefined &&
    typeof declared.additionalProperties !== "boolean"
  ) {
    throw new JsonSchemaError(
      `${path}.additionalProperties must be true or false`,
    );
  }
  if (declared.items !== undefined) {
    assertEnforceableJsonSchemaV1(declared.items, `${path}.items`, depth + 1);
  }
  const properties = record(declared.properties);
  if (declared.properties !== undefined && !properties) {
    throw new JsonSchemaError(`${path}.properties must be an object`);
  }
  for (const [name, property] of Object.entries(properties ?? {})) {
    assertEnforceableJsonSchemaV1(
      property,
      `${path}.properties.${name}`,
      depth + 1,
    );
  }
}

/**
 * Whether `value` satisfies `schema`, in the subset above. Raises
 * `JsonSchemaError` naming the path that failed, because the Bot reads the
 * message and has to know which field to fix.
 */
export function validateAgainstJsonSchemaV1(
  value: unknown,
  schema: unknown,
  path = "value",
  depth = 0,
): void {
  if (depth > MAX_SCHEMA_DEPTH_V1) {
    throw new JsonSchemaError(
      `${path} nests deeper than ${MAX_SCHEMA_DEPTH_V1}`,
    );
  }
  const declared = record(schema);
  if (!declared) throw new JsonSchemaError(`${path} has no schema`);
  for (const keyword of Object.keys(declared)) {
    if (
      !KNOWN_KEYWORDS_V1.includes(keyword as (typeof KNOWN_KEYWORDS_V1)[number])
    ) {
      throw new JsonSchemaError(
        `${path} declares "${keyword}", which this deployment does not enforce`,
      );
    }
  }
  const type = declared.type;
  if (
    typeof type !== "string" ||
    !KNOWN_TYPES_V1.includes(type as (typeof KNOWN_TYPES_V1)[number])
  ) {
    throw new JsonSchemaError(`${path} does not declare a known type`);
  }
  if (Array.isArray(declared.enum) && !declared.enum.includes(value as never)) {
    throw new JsonSchemaError(`${path} is not one of the declared values`);
  }
  switch (type) {
    case "null":
      if (value !== null) throw new JsonSchemaError(`${path} must be null`);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new JsonSchemaError(`${path} must be a boolean`);
      }
      return;
    case "string": {
      if (typeof value !== "string") {
        throw new JsonSchemaError(`${path} must be a string`);
      }
      if (
        typeof declared.minLength === "number" &&
        value.length < declared.minLength
      ) {
        throw new JsonSchemaError(
          `${path} must be at least ${declared.minLength} characters`,
        );
      }
      if (
        typeof declared.maxLength === "number" &&
        value.length > declared.maxLength
      ) {
        throw new JsonSchemaError(
          `${path} must be at most ${declared.maxLength} characters`,
        );
      }
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new JsonSchemaError(`${path} must be a number`);
      }
      if (type === "integer" && !Number.isSafeInteger(value)) {
        throw new JsonSchemaError(`${path} must be an integer`);
      }
      if (typeof declared.minimum === "number" && value < declared.minimum) {
        throw new JsonSchemaError(
          `${path} must be at least ${declared.minimum}`,
        );
      }
      if (typeof declared.maximum === "number" && value > declared.maximum) {
        throw new JsonSchemaError(
          `${path} must be at most ${declared.maximum}`,
        );
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw new JsonSchemaError(`${path} must be an array`);
      }
      if (
        typeof declared.minItems === "number" &&
        value.length < declared.minItems
      ) {
        throw new JsonSchemaError(
          `${path} must hold at least ${declared.minItems} entries`,
        );
      }
      if (
        typeof declared.maxItems === "number" &&
        value.length > declared.maxItems
      ) {
        throw new JsonSchemaError(
          `${path} must hold at most ${declared.maxItems} entries`,
        );
      }
      if (declared.items !== undefined) {
        for (const [index, entry] of value.entries()) {
          validateAgainstJsonSchemaV1(
            entry,
            declared.items,
            `${path}[${index}]`,
            depth + 1,
          );
        }
      }
      return;
    }
    default: {
      const object = record(value);
      if (!object) throw new JsonSchemaError(`${path} must be an object`);
      const properties = record(declared.properties) ?? {};
      const required = Array.isArray(declared.required)
        ? declared.required
        : [];
      for (const name of required) {
        if (typeof name !== "string" || object[name] === undefined) {
          throw new JsonSchemaError(`${path}.${String(name)} is required`);
        }
      }
      // Open by default is what JSON Schema means, so the refusal is the
      // declared one: a card that says `additionalProperties: false` gets it.
      if (declared.additionalProperties === false) {
        const unexpected = Object.keys(object).find(
          (name) => !Object.hasOwn(properties, name),
        );
        if (unexpected !== undefined) {
          throw new JsonSchemaError(`${path}.${unexpected} is not declared`);
        }
      }
      for (const [name, property] of Object.entries(properties)) {
        if (object[name] === undefined) continue;
        validateAgainstJsonSchemaV1(
          object[name],
          property,
          `${path}.${name}`,
          depth + 1,
        );
      }
      return;
    }
  }
}

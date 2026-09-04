/** The JSON Schema subset accepted by the model contract (ADR 0033). */
export type StructuredOutputSchemaV1 =
  | {
      type: "object";
      properties?: Record<string, StructuredOutputSchemaV1>;
      required?: string[];
      additionalProperties?: boolean;
      enum?: unknown[];
      title?: string;
      description?: string;
    }
  | {
      type: "array";
      items: StructuredOutputSchemaV1;
      enum?: unknown[];
      title?: string;
      description?: string;
    }
  | {
      type: "string" | "number" | "boolean";
      enum?: unknown[];
      title?: string;
      description?: string;
    };

export interface JsonSchemaResponseFormatV1 {
  type: "json_schema";
  /** Provider-safe identifier for the schema, not a display label. */
  name: string;
  schema: StructuredOutputSchemaV1;
}

export interface JsonResponseFormatV1 {
  type: "json";
}

export type ModelResponseFormatV1 =
  JsonSchemaResponseFormatV1 | JsonResponseFormatV1;

export type StructuredOutputSupportV1 = "json_schema" | "json" | "none";

export interface ModelProviderSupportsV1 {
  structuredOutput: StructuredOutputSupportV1;
}

export interface StructuredOutputIssueV1 {
  path: string;
  code: "type" | "enum" | "required" | "additional-property";
  message: string;
}

/** A validation failure is durable, so its diagnostics cannot grow unbounded. */
export const STRUCTURED_OUTPUT_ISSUE_LIMIT_V1 = 100;

export type StructuredOutputFailureV1 =
  | {
      code: "invalid-json";
      message: string;
    }
  | {
      code: "schema-mismatch";
      message: string;
      issues: StructuredOutputIssueV1[];
    };

export interface ResponseFormatNoteV1 {
  code: "structured-output-downgraded";
  requested: "json_schema" | "json";
  effective: "json" | "prompt";
  message: string;
}

export type StructuredModelResultV1<T> =
  | { status: "completed"; value: T; raw: string }
  | { status: "failed"; failure: StructuredOutputFailureV1; raw: string };

const SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "items",
  "enum",
  "required",
  "additionalProperties",
  "title",
  "description",
]);

/**
 * Strictly decodes the deliberately small, dependency-free schema dialect.
 * Unsupported JSON Schema keywords fail at admission instead of being
 * interpreted differently by different providers.
 */
export function decodeStructuredOutputSchemaV1(
  value: unknown,
  label = "structured output schema",
): StructuredOutputSchemaV1 {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!SCHEMA_KEYS.has(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
  if (
    value.type !== "object" &&
    value.type !== "array" &&
    value.type !== "string" &&
    value.type !== "number" &&
    value.type !== "boolean"
  ) {
    throw new Error(
      `${label}.type must be object, array, string, number, or boolean`,
    );
  }
  requireOptionalString(value.title, `${label}.title`);
  requireOptionalString(value.description, `${label}.description`);
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      throw new Error(`${label}.enum must be a non-empty array`);
    }
    for (const member of value.enum) requireJsonValue(member, `${label}.enum`);
  }

  if (value.type === "object") {
    if (value.items !== undefined) {
      throw new Error(`${label}.items is only valid for arrays`);
    }
    if (
      value.additionalProperties !== undefined &&
      typeof value.additionalProperties !== "boolean"
    ) {
      throw new Error(`${label}.additionalProperties must be a boolean`);
    }
    const properties: Record<string, StructuredOutputSchemaV1> = {};
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) {
        throw new Error(`${label}.properties must be an object`);
      }
      for (const [name, schema] of Object.entries(value.properties)) {
        properties[name] = decodeStructuredOutputSchemaV1(
          schema,
          `${label}.properties.${name}`,
        );
      }
    }
    let required: string[] | undefined;
    if (value.required !== undefined) {
      if (
        !Array.isArray(value.required) ||
        !value.required.every((entry) => typeof entry === "string")
      ) {
        throw new Error(`${label}.required must be an array of strings`);
      }
      required = [...value.required];
      for (const name of required) {
        if (!(name in properties)) {
          throw new Error(`${label}.required names unknown property "${name}"`);
        }
      }
    }
    return {
      type: "object",
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(required ? { required } : {}),
      ...(value.additionalProperties !== undefined
        ? { additionalProperties: value.additionalProperties }
        : {}),
      ...(value.enum !== undefined ? { enum: value.enum } : {}),
      ...(value.title !== undefined ? { title: value.title } : {}),
      ...(value.description !== undefined
        ? { description: value.description }
        : {}),
    };
  }

  if (
    value.properties !== undefined ||
    value.required !== undefined ||
    value.additionalProperties !== undefined
  ) {
    throw new Error(`${label} contains object-only keywords`);
  }
  if (value.type === "array") {
    if (value.items === undefined) {
      throw new Error(`${label}.items is required for arrays`);
    }
    return {
      type: "array",
      items: decodeStructuredOutputSchemaV1(value.items, `${label}.items`),
      ...(value.enum !== undefined ? { enum: value.enum } : {}),
      ...(value.title !== undefined ? { title: value.title } : {}),
      ...(value.description !== undefined
        ? { description: value.description }
        : {}),
    };
  }
  if (value.items !== undefined) {
    throw new Error(`${label}.items is only valid for arrays`);
  }
  return {
    type: value.type,
    ...(value.enum !== undefined ? { enum: value.enum } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.description !== undefined
      ? { description: value.description }
      : {}),
  };
}

export function decodeModelResponseFormatV1(
  value: unknown,
  label = "responseFormat",
): ModelResponseFormatV1 {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.type === "json") {
    requireExactKeys(value, ["type"], label);
    return { type: "json" };
  }
  if (value.type !== "json_schema") {
    throw new Error(`${label}.type must be json_schema or json`);
  }
  requireExactKeys(value, ["type", "name", "schema"], label);
  if (
    typeof value.name !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.name)
  ) {
    throw new Error(`${label}.name must be 1-64 letters, digits, _ or -`);
  }
  return {
    type: "json_schema",
    name: value.name,
    schema: decodeStructuredOutputSchemaV1(value.schema, `${label}.schema`),
  };
}

export function validateStructuredOutputV1(
  text: string,
  schema: StructuredOutputSchemaV1,
): StructuredModelResultV1<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      status: "failed",
      failure: {
        code: "invalid-json",
        message: "The model response was not valid JSON",
      },
      raw: text,
    };
  }
  const issues: StructuredOutputIssueV1[] = [];
  validateValue(value, schema, "$", issues);
  return issues.length === 0
    ? { status: "completed", value, raw: text }
    : {
        status: "failed",
        failure: {
          code: "schema-mismatch",
          message: "The model response did not match the requested schema",
          issues,
        },
        raw: text,
      };
}

function validateValue(
  value: unknown,
  schema: StructuredOutputSchemaV1,
  path: string,
  issues: StructuredOutputIssueV1[],
): void {
  if (issues.length >= STRUCTURED_OUTPUT_ISSUE_LIMIT_V1) return;
  if (schema.enum && !schema.enum.some((member) => jsonEqual(member, value))) {
    pushIssue(issues, {
      path,
      code: "enum",
      message: `${path} is not one of the allowed values`,
    });
    return;
  }
  if (schema.type === "object") {
    if (!isRecord(value)) return typeIssue(path, "object", issues);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        pushIssue(issues, {
          path: `${path}.${required}`,
          code: "required",
          message: `${path}.${required} is required`,
        });
      }
    }
    for (const [name, member] of Object.entries(value)) {
      const memberSchema = schema.properties?.[name];
      if (memberSchema) {
        validateValue(member, memberSchema, `${path}.${name}`, issues);
      } else if (schema.additionalProperties === false) {
        pushIssue(issues, {
          path: `${path}.${name}`,
          code: "additional-property",
          message: `${path}.${name} is not allowed`,
        });
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return typeIssue(path, "array", issues);
    value.forEach((member, index) =>
      validateValue(member, schema.items, `${path}[${index}]`, issues),
    );
    return;
  }
  if (typeof value !== schema.type) typeIssue(path, schema.type, issues);
}

function typeIssue(
  path: string,
  expected: string,
  issues: StructuredOutputIssueV1[],
): void {
  pushIssue(issues, {
    path,
    code: "type",
    message: `${path} must be a ${expected}`,
  });
}

function pushIssue(
  issues: StructuredOutputIssueV1[],
  issue: StructuredOutputIssueV1,
): void {
  if (issues.length < STRUCTURED_OUTPUT_ISSUE_LIMIT_V1) issues.push(issue);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  }
}

function requireOptionalString(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function requireJsonValue(value: unknown, label: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((member) => requireJsonValue(member, label));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((member) => requireJsonValue(member, label));
    return;
  }
  throw new Error(`${label} must contain only JSON values`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

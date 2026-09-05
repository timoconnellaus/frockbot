import type {
  StandardSchemaIssue,
  StandardSchemaV1,
} from "@frockbot/compose-core";

/** The JSON Schema subset used for composer tool arguments and plugin options. */
export interface JsonSchema extends Record<string, unknown> {
  type?: JsonSchemaType | ReadonlyArray<JsonSchemaType>;
  description?: string;
  enum?: ReadonlyArray<unknown>;
  properties?: Record<string, JsonSchema>;
  required?: ReadonlyArray<string>;
  items?: JsonSchema;
  additionalProperties?: boolean;
}

/** Primitive names understood by {@link JsonSchema}. */
export type JsonSchemaType =
  "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

interface Problem {
  message: string;
  path: Array<string | number>;
}

const kindOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const isType = (value: unknown, type: JsonSchemaType): boolean => {
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "number") return typeof value === "number";
  return kindOf(value) === type;
};

function check(
  value: unknown,
  schema: JsonSchema,
  path: Array<string | number>,
  problems: Array<Problem>,
): void {
  const types =
    schema.type === undefined
      ? []
      : Array.isArray(schema.type)
        ? [...schema.type]
        : [schema.type as JsonSchemaType];
  if (types.length > 0 && !types.some((type) => isType(value, type))) {
    problems.push({
      message: `expected ${types.join(" or ")}, got ${kindOf(value)}`,
      path,
    });
    return;
  }
  if (schema.enum && !schema.enum.some((one) => Object.is(one, value))) {
    problems.push({
      message: `expected one of ${schema.enum
        .map((one) => JSON.stringify(one))
        .join(", ")}`,
      path,
    });
    return;
  }
  if (kindOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in object)) {
        problems.push({ message: "is required", path: [...path, name] });
      }
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (name in object) {
        check(object[name], property, [...path, name], problems);
      }
    }
    if (schema.additionalProperties === false) {
      const known = schema.properties ?? {};
      for (const name of Object.keys(object)) {
        if (!(name in known)) {
          problems.push({
            message: "is not a known argument",
            path: [...path, name],
          });
        }
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      check(item, schema.items!, [...path, index], problems),
    );
  }
}

/** A Standard Schema carrying the JSON Schema the composer can report. */
export interface DescribedValidator<TInput, TOutput> extends StandardSchemaV1<
  TInput,
  TOutput
> {
  readonly schema: JsonSchema;
}

const isJsonSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null;

/** Read the JSON Schema attached to a validator, when it has one. */
export function schemaOf(validator: unknown): JsonSchema | undefined {
  const schema = (validator as { schema?: unknown } | undefined)?.schema;
  return isJsonSchema(schema) ? schema : undefined;
}

/** Build a Standard Schema validator from the JSON Schema shown to a model. */
export function jsonSchemaValidator<TOutput>(
  schema: JsonSchema,
): DescribedValidator<unknown, TOutput> {
  return {
    schema,
    "~standard": {
      version: 1,
      vendor: "compose-tools",
      validate: (value: unknown) => {
        const subject = value ?? {};
        const problems: Array<Problem> = [];
        check(subject, schema, [], problems);
        if (problems.length === 0) return { value: subject as TOutput };
        const issues: Array<StandardSchemaIssue> = problems.map((problem) => ({
          message:
            problem.path.length === 0
              ? problem.message
              : `${problem.path.join(".")} ${problem.message}`,
          path: problem.path,
        }));
        return { issues };
      },
    },
  };
}

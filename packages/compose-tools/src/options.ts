import type { StandardSchemaV1 } from "@frockbot/compose-core";
import type { JsonSchema } from "./json-schema";

/** Build a small Standard Schema, optionally carrying its descriptive schema. */
export const optionsSchema = <TInput, TOutput>(
  parse: (value: TInput) => TOutput,
  schema?: JsonSchema,
): StandardSchemaV1<TInput, TOutput> & { schema?: JsonSchema } => ({
  ...(schema === undefined ? {} : { schema }),
  "~standard": {
    version: 1,
    vendor: "compose-tools",
    validate: (value: unknown) => ({ value: parse(value as TInput) }),
  },
});

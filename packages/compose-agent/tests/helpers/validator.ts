import type {
  StandardSchemaResult,
  StandardSchemaV1,
} from "@frockbot/compose-core";

/**
 * A minimal Standard Schema, so the tests exercise the spec rather than a
 * particular validation library.
 */
export const validator = <TInput, TOutput>(
  validate: (value: TInput) => StandardSchemaResult<TOutput>,
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    version: 1,
    vendor: "compose-agent-tests",
    validate: validate as (
      value: unknown,
    ) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>,
  },
});

/** `{ query: string }`, rejecting anything else. */
export const queryValidator = validator<unknown, { query: string }>((value) => {
  const query = (value as { query?: unknown } | null)?.query;
  if (typeof query !== "string") {
    return { issues: [{ message: "expected a string", path: ["query"] }] };
  }
  return { value: { query } };
});

/** Anything at all; for tools that take no arguments worth checking. */
export const anyValidator = validator<unknown, Record<string, unknown>>(
  (value) => ({ value: (value ?? {}) as Record<string, unknown> }),
);

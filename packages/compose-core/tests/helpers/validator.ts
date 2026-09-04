import type { StandardSchemaResult, StandardSchemaV1 } from "../../src/index";

/**
 * A minimal Standard Schema, so the tests exercise the spec rather than a
 * particular validation library.
 */
export const validator = <TInput, TOutput>(
  validate: (value: TInput) => StandardSchemaResult<TOutput>,
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    version: 1,
    vendor: "compose-tests",
    validate: validate as (
      value: unknown,
    ) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>,
  },
});

/** `{ every?: number }` in, `{ every: number }` out, defaulted to 10. */
export const intervalValidator = validator<
  { every?: number } | undefined,
  { every: number }
>((value) => {
  const every = value?.every ?? 10;
  if (typeof every !== "number" || Number.isNaN(every)) {
    return { issues: [{ message: "expected a number", path: ["every"] }] };
  }
  return { value: { every } };
});

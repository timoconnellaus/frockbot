/**
 * The Standard Schema v1 interface, inlined so the kernel can accept any
 * validator without taking a runtime dependency on one.
 *
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

/** One problem found by a validator, with the path to the offending value. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** What a validator returns: the parsed value, or the issues that stopped it. */
export type StandardSchemaResult<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/** The value a validator produces once it has validated and defaulted its input. */
export type InferOutput<TValidator> =
  TValidator extends StandardSchemaV1<any, infer TOutput> ? TOutput : never;

/** The value a caller passes to a validator. */
export type InferInput<TValidator> =
  TValidator extends StandardSchemaV1<infer TInput, any> ? TInput : never;
